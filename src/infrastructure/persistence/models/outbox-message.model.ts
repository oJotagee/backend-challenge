import { Check, Entity, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'outbox_messages' })
@Check({ name: 'outbox_attempts_non_negative', expression: 'attempts >= 0' })
@Index({
  name: 'outbox_pending_idx',
  expression: 'create index "outbox_pending_idx" on "outbox_messages" ("next_attempt_at") where published_at is null',
})
export class OutboxMessageModel {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  aggregateId!: string;

  @Property({ type: 'text' })
  eventType!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property({ type: 'datetime' })
  occurredAt!: Date;

  @Property({ type: 'integer', default: 0 })
  attempts!: number;

  @Property({ type: 'datetime', defaultRaw: 'now()' })
  nextAttemptAt!: Date;

  @Property({ type: 'datetime', nullable: true })
  publishedAt?: Date | null;
}
