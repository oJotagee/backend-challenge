import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import {
  IdempotencyConflictError,
  WalletNotFoundError,
} from '@/application/errors/application-errors';
import type {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from '@/application/use-cases/process-wager-transaction.use-case';
import { CurrencyMismatchError, InvalidMoneyError, InvalidWagerTransactionError } from '@/domain/errors/domain-error';

import type { Metrics } from '../observability/metrics';
import { wagerTransactionRequestedSchema } from './wager-message.schema';

export interface ConsumerLogger {
  log(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface SqsWagerConsumerOptions {
  sqs: SQSClient;
  queueUrl: string;
  dlqUrl: string;
  consumerName: string;
  waitTimeSeconds: number;
  maxReceiveCount: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  shutdownGraceMs: number;
  process: (command: ProcessWagerTransactionCommand) => Promise<ProcessWagerTransactionResult>;
  logger: ConsumerLogger;
  metrics?: Metrics;
}

export type MessageDisposition = 'acked' | 'retry' | 'dead-lettered' | 'released';

type ErrorKind = 'business' | 'permanent' | 'transient';

/**
 * Consumidor de wager-transactions.fifo.
 * - negócio (wallet inexistente, conflito de idempotência) → ack: reenviar não muda nada;
 * - permanente (mensagem malformada / payload inválido) → DLQ imediatamente;
 * - transitório (banco fora, lock timeout, erro inesperado) → não ack; volta com backoff
 *   (ChangeMessageVisibility) e vai para a DLQ ao atingir maxReceiveCount.
 * O ack (DeleteMessage) só acontece depois que o use case retornou, ou seja, depois do COMMIT.
 */
export class SqsWagerConsumer {
  private running = false;
  private stopping = false;
  private loop?: Promise<void>;
  private poll?: AbortController;

  constructor(private readonly o: SqsWagerConsumerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loop = this.run();
  }

  /** SIGTERM: para de receber, conclui a mensagem em andamento e devolve as que não começaram. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.poll?.abort();
    await Promise.race([this.loop, Bun.sleep(this.o.shutdownGraceMs)]);
    this.running = false;
  }

  /** Uma rodada de recebimento + processamento. Exposto para testes determinísticos. */
  async pollOnce(): Promise<MessageDisposition[]> {
    this.poll = new AbortController();
    const response = await this.o.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.o.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.o.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        MessageAttributeNames: ['All'],
      }),
      { abortSignal: this.poll.signal },
    );

    const dispositions: MessageDisposition[] = [];
    const messages = response.Messages ?? [];
    for (const [index, message] of messages.entries()) {
      if (this.stopping) {
        await Promise.all(messages.slice(index).map((m) => this.release(m)));
        dispositions.push(...messages.slice(index).map(() => 'released' as const));
        break;
      }
      dispositions.push(await this.handle(message));
    }
    return dispositions;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.stopping) break;
        this.o.logger.error({ err: error }, 'sqs receive failed');
        await Bun.sleep(1_000);
      }
    }
  }

  private async handle(message: Message): Promise<MessageDisposition> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const parsed = this.parse(message);
    if (!parsed.ok) return this.deadLetter(message, 'INVALID_MESSAGE', parsed.reason);

    const { messageId, data } = parsed.value;
    const context = {
      messageId,
      correlationId: messageId,
      walletId: data.walletId,
      providerId: data.providerId,
      receiveCount,
    };
    try {
      const { idempotencyKey, ...business } = data;
      await this.o.process({
        idempotencyKey,
        data: business,
        correlationId: messageId,
        source: { type: 'sqs', consumerName: this.o.consumerName, messageId },
      });
      await this.ack(message);
      return 'acked';
    } catch (error) {
      return this.onError(message, error, context, receiveCount);
    }
  }

  private async onError(
    message: Message,
    error: unknown,
    context: object,
    receiveCount: number,
  ): Promise<MessageDisposition> {
    const kind = classify(error);
    const err = { name: (error as Error)?.name, message: (error as Error)?.message };

    if (kind === 'business') {
      await this.ack(message);
      this.o.logger.warn({ ...context, err }, 'wager message rejected by business rule, acked');
      return 'acked';
    }
    if (kind === 'permanent') {
      return this.deadLetter(message, 'INVALID_PAYLOAD', err.message ?? 'invalid payload');
    }
    if (receiveCount >= this.o.maxReceiveCount) {
      return this.deadLetter(message, 'RETRIES_EXHAUSTED', err.message ?? 'transient failure');
    }

    const delay = Math.min(this.o.retryMaxSeconds, this.o.retryBaseSeconds * 2 ** (receiveCount - 1));
    await this.setVisibility(message, delay);
    this.o.metrics?.retries.inc({ component: 'sqs-consumer' });
    this.o.logger.warn({ ...context, err, retryInSeconds: delay }, 'wager message failed, will retry');
    return 'retry';
  }

  private parse(message: Message) {
    try {
      const result = wagerTransactionRequestedSchema.safeParse(JSON.parse(message.Body ?? ''));
      return result.success
        ? ({ ok: true, value: result.data } as const)
        : ({ ok: false, reason: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } as const);
    } catch {
      return { ok: false, reason: 'body is not valid JSON' } as const;
    }
  }

  private async deadLetter(message: Message, code: string, reason: string): Promise<MessageDisposition> {
    await this.o.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.o.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureCode: { DataType: 'String', StringValue: code },
          failureReason: { DataType: 'String', StringValue: reason.slice(0, 1000) },
        },
      }),
    );
    await this.ack(message);
    this.o.metrics?.dlqMessages.inc();
    this.o.logger.error({ sqsMessageId: message.MessageId, code, reason }, 'wager message sent to DLQ');
    return 'dead-lettered';
  }

  private ack(message: Message) {
    return this.o.sqs.send(new DeleteMessageCommand({ QueueUrl: this.o.queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async release(message: Message): Promise<void> {
    await this.setVisibility(message, 0);
  }

  private setVisibility(message: Message, seconds: number) {
    return this.o.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.o.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}

function classify(error: unknown): ErrorKind {
  if (error instanceof WalletNotFoundError || error instanceof IdempotencyConflictError) return 'business';
  if (
    error instanceof InvalidWagerTransactionError ||
    error instanceof InvalidMoneyError ||
    error instanceof CurrencyMismatchError
  ) {
    return 'permanent';
  }
  return 'transient';
}
