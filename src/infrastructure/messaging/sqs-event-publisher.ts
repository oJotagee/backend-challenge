import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';

import type { EventPublisher } from '@/application/ports/event-publisher.port';
import type { OutboxMessage } from '@/domain/entities/outbox-message.entity';

/** Limite do SQS para SendMessageBatch. */
export const SQS_BATCH_LIMIT = 10;

/**
 * Publica os envelopes numa fila FIFO com SendMessageBatch (até 10 por chamada).
 * MessageGroupId = aggregateId mantém a ordem por agregado; MessageDeduplicationId = eventId
 * descarta reenvios em 5 min (otimização: fora dessa janela quem deduplica é o consumidor).
 *
 * Se um evento de um agregado falha, os eventos seguintes do mesmo agregado não são enviados
 * nesta rodada — senão um evento posterior chegaria antes do anterior.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<ReadonlySet<string>> {
    const published = new Set<string>();
    const blockedAggregates = new Set<string>();
    let pending = [...messages];

    while (pending.length > 0) {
      const sendable = pending.filter((m) => !blockedAggregates.has(m.aggregateId));
      const chunk = sendable.slice(0, SQS_BATCH_LIMIT);
      if (chunk.length === 0) break;
      pending = pending.filter((m) => !chunk.includes(m));

      const failedIds = await this.sendChunk(chunk);
      for (const message of chunk) {
        if (failedIds.has(message.id)) blockedAggregates.add(message.aggregateId);
        else published.add(message.id);
      }
    }
    return published;
  }

  private async sendChunk(chunk: OutboxMessage[]): Promise<Set<string>> {
    try {
      const response = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: chunk.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: message.eventType },
              eventId: { DataType: 'String', StringValue: message.id },
            },
          })),
        }),
      );
      return new Set((response.Failed ?? []).map((failure) => chunk[Number(failure.Id)]!.id));
    } catch {
      return new Set(chunk.map((m) => m.id));
    }
  }
}
