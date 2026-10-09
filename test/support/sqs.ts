import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

import type { ProcessWagerTransactionCommand } from '@/application/use-cases/process-wager-transaction.use-case';
import { SqsWagerConsumer, type SqsWagerConsumerOptions } from '@/infrastructure/messaging/sqs-wager-consumer';

export const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

export function testSqsClient(): SQSClient {
  return new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1', endpoint: process.env.SQS_ENDPOINT });
}

export interface TestQueues {
  queueUrl: string;
  dlqUrl: string;
  eventsUrl: string;
  destroy(): Promise<void>;
}

/** Filas FIFO exclusivas desta execução: não interferem nas filas de desenvolvimento. */
export async function createTestQueues(sqs: SQSClient, prefix: string): Promise<TestQueues> {
  const name = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const create = async (queueName: string, attributes: Record<string, string> = {}) =>
    (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: `${queueName}.fifo`,
          Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...attributes },
        }),
      )
    ).QueueUrl!;

  const dlqUrl = await create(`${name}-dlq`);
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  const queueUrl = await create(name, {
    VisibilityTimeout: '30',
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes!.QueueArn, maxReceiveCount: '10' }),
  });
  const eventsUrl = await create(`${name}-events`);

  return {
    queueUrl,
    dlqUrl,
    eventsUrl,
    async destroy() {
      await Promise.all([queueUrl, dlqUrl, eventsUrl].map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))));
    },
  };
}

/** Converte o comando do use case no envelope da fila (seção 10) e envia. */
export async function sendWagerMessage(
  sqs: SQSClient,
  queueUrl: string,
  command: ProcessWagerTransactionCommand,
  opts: { messageId?: string; deduplicationId?: string } = {},
): Promise<string> {
  const messageId = opts.messageId ?? `msg-${crypto.randomUUID()}`;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageGroupId: command.data.walletId,
      MessageDeduplicationId: opts.deduplicationId ?? crypto.randomUUID(),
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...command.data, idempotencyKey: command.idempotencyKey },
      }),
    }),
  );
  return messageId;
}

export async function sendRaw(sqs: SQSClient, queueUrl: string, body: string, groupId = 'raw'): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageGroupId: groupId,
      MessageDeduplicationId: crypto.randomUUID(),
      MessageBody: body,
    }),
  );
}

export async function receiveAll(
  sqs: SQSClient,
  queueUrl: string,
  opts: { waitSeconds?: number; visibilityTimeout?: number } = {},
): Promise<Message[]> {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: opts.waitSeconds ?? 1,
      VisibilityTimeout: opts.visibilityTimeout,
      MessageAttributeNames: ['All'],
    }),
  );
  return Messages ?? [];
}

export function testConsumer(
  sqs: SQSClient,
  queues: TestQueues,
  overrides: Partial<SqsWagerConsumerOptions> & Pick<SqsWagerConsumerOptions, 'process'>,
): SqsWagerConsumer {
  return new SqsWagerConsumer({
    sqs,
    queueUrl: queues.queueUrl,
    dlqUrl: queues.dlqUrl,
    consumerName: 'wager-transactions',
    waitTimeSeconds: 1,
    maxReceiveCount: 3,
    retryBaseSeconds: 1,
    retryMaxSeconds: 4,
    shutdownGraceMs: 5_000,
    logger: silentLogger,
    ...overrides,
  });
}
