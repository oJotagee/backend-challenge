import { describe, expect, it } from 'bun:test';
import type { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';

import { OutboxMessage } from '@/domain/entities/outbox-message.entity';
import { SqsEventPublisher } from '@/infrastructure/messaging/sqs-event-publisher';

import { NOW } from './fixtures';

/**
 * Falha parcial do SendMessageBatch não é reproduzível no LocalStack sob demanda; aqui o
 * cliente SQS é simulado só para exercitar a lógica de lote e de ordem por agregado.
 * O caminho feliz contra o SQS real está em test/integration/outbox-and-pending.spec.ts.
 */
function message(id: string, aggregateId: string): OutboxMessage {
  return OutboxMessage.rehydrate({
    id,
    aggregateId,
    eventType: 'WagerTransactionProcessed',
    payload: { eventId: id },
    occurredAt: NOW,
    attempts: 0,
  });
}

function fakeSqs(behavior: (entryIds: string[]) => { failedEventIds?: string[]; throws?: boolean }) {
  const batches: string[][] = [];
  const client = {
    send: async (command: SendMessageBatchCommand) => {
      const entries = command.input.Entries ?? [];
      const eventIds = entries.map((e) => e.MessageDeduplicationId!);
      batches.push(eventIds);
      const { failedEventIds = [], throws } = behavior(eventIds);
      if (throws) throw new Error('sqs down');
      return {
        Failed: entries
          .filter((e) => failedEventIds.includes(e.MessageDeduplicationId!))
          .map((e) => ({ Id: e.Id, Code: 'InternalError', SenderFault: false })),
      };
    },
  } as unknown as SQSClient;
  return { client, batches };
}

describe('SqsEventPublisher (SendMessageBatch)', () => {
  it('envia em lotes de até 10, preservando a ordem', async () => {
    const { client, batches } = fakeSqs(() => ({}));
    const messages = Array.from({ length: 23 }, (_, i) => message(`e${i}`, `agg-${i}`));

    const published = await new SqsEventPublisher(client, 'q').publish(messages);

    expect(batches.map((b) => b.length)).toEqual([10, 10, 3]);
    expect(batches.flat()).toEqual(messages.map((m) => m.id));
    expect(published.size).toBe(23);
  });

  it('falha parcial: só os aceitos são publicados', async () => {
    const { client } = fakeSqs(() => ({ failedEventIds: ['b1'] }));

    const published = await new SqsEventPublisher(client, 'q').publish([
      message('a1', 'A'),
      message('b1', 'B'),
      message('c1', 'C'),
    ]);

    expect([...published].sort()).toEqual(['a1', 'c1']);
  });

  it('falha de um evento bloqueia os eventos seguintes do MESMO agregado (ordem)', async () => {
    const { client, batches } = fakeSqs(() => ({ failedEventIds: ['a1'] }));
    const messages = [
      ...Array.from({ length: 9 }, (_, i) => message(`x${i}`, `X${i}`)),
      message('a1', 'A'),
      message('a2', 'A'),
      message('b1', 'B'),
    ];

    const published = await new SqsEventPublisher(client, 'q').publish(messages);

    expect(published.has('a1')).toBe(false);
    expect(published.has('a2')).toBe(false);
    expect(published.has('b1')).toBe(true);
    expect(batches[1]).toEqual(['b1']);
  });

  it('chamada que lança erro → nenhum evento do lote é publicado', async () => {
    const { client } = fakeSqs(() => ({ throws: true }));

    const published = await new SqsEventPublisher(client, 'q').publish([message('a1', 'A'), message('b1', 'B')]);

    expect(published.size).toBe(0);
  });
});
