import { InvalidTransactionStateError } from '../errors/domain-error';
import type { IntegrationEvent } from '../events/integration-event';
import { type BackoffPolicy, nextAttemptAt } from '../services/exponential-backoff';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export const OUTBOX_BACKOFF: BackoffPolicy = { baseMs: 1_000, maxMs: 5 * 60_000 };

/**
 * Evento esperando publicação. É gravado na MESMA transação da alteração financeira;
 * um worker publica depois do commit. `id` = eventId, que o consumidor usa para deduplicar.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      { ...event.toJSON() },
      event.occurredAt,
      0,
      event.occurredAt,
    );
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      s.id,
      s.aggregateId,
      s.eventType,
      s.payload,
      s.occurredAt,
      s.attempts,
      s.nextAttemptAt,
      s.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new InvalidTransactionStateError(this.id, 'PUBLISHED', 'PUBLISHED');

    this._publishedAt = at;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff). */
  scheduleRetry(now: Date, policy: BackoffPolicy = OUTBOX_BACKOFF): void {
    if (!this.isPending()) throw new InvalidTransactionStateError(this.id, 'PUBLISHED', 'RETRY');

    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt(now, this._attempts, policy);
  }
}
