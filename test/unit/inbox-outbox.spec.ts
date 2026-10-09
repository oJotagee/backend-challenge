import { describe, expect, it } from 'bun:test';
import { InboxMessage } from '@/domain/entities/inbox-message.entity';
import { OutboxMessage } from '@/domain/entities/outbox-message.entity';
import { WagerTransactionKind as K } from '@/domain/enums/wager-transaction-kind.enum';
import { InvalidTransactionStateError } from '@/domain/errors/domain-error';
import { WagerTransactionProcessed } from '@/domain/events/wager-transaction-events';
import { NOW, brl, tx } from './fixtures';

const later = (ms: number) => new Date(NOW.getTime() + ms);

function event() {
  const t = tx(K.Bet, '25.00');
  t.markProcessed(undefined, brl('75.00'), NOW);
  return WagerTransactionProcessed.from(t, { eventId: 'evt-1', correlationId: 'corr-1', occurredAt: NOW });
}

describe('InboxMessage', () => {
  it('nasce não processada e marca uma única vez', () => {
    const msg = InboxMessage.receive({ messageId: 'm1', consumerName: 'wager', payloadHash: 'h', receivedAt: NOW });
    expect(msg.isProcessed()).toBe(false);

    msg.markProcessed(NOW);
    expect(msg.isProcessed()).toBe(true);
    expect(() => msg.markProcessed(NOW)).toThrow(InvalidTransactionStateError);
  });
});

describe('OutboxMessage', () => {
  it('enqueue guarda o envelope serializado e já está vencida', () => {
    const msg = OutboxMessage.enqueue(event());

    expect(msg.id).toBe('evt-1');
    expect(msg.eventType).toBe('WagerTransactionProcessed');
    expect(msg.payload.version).toBe(1);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(NOW)).toBe(true);
  });

  it('scheduleRetry aplica backoff exponencial com teto', () => {
    const msg = OutboxMessage.enqueue(event());
    const policy = { baseMs: 1000, maxMs: 4000 };

    msg.scheduleRetry(NOW, policy);
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt).toEqual(later(1000));
    expect(msg.isDue(later(999))).toBe(false);
    expect(msg.isDue(later(1000))).toBe(true);

    msg.scheduleRetry(NOW, policy);
    msg.scheduleRetry(NOW, policy);
    msg.scheduleRetry(NOW, policy);
    expect(msg.nextAttemptAt).toEqual(later(4000));
  });

  it('publicada não é mais pendente nem pode ser republicada', () => {
    const msg = OutboxMessage.enqueue(event());
    msg.markPublished(NOW);

    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(later(1_000_000))).toBe(false);
    expect(() => msg.markPublished(NOW)).toThrow(InvalidTransactionStateError);
  });
});

describe('IntegrationEvent', () => {
  it('toJSON gera envelope estável, com dinheiro como string', () => {
    const json = event().toJSON();

    expect(json).toMatchObject({
      eventId: 'evt-1',
      eventType: 'WagerTransactionProcessed',
      correlationId: 'corr-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
    });
    expect(json.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(json.data.balanceAfter).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('data é imutável', () => {
    const e = event();
    expect(() => {
      (e.data as { kind: string }).kind = 'WIN';
    }).toThrow();
  });
});
