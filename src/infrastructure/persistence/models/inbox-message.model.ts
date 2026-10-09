import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** Deduplicação persistente do consumer: PK composta (consumer_name, message_id). */
@Entity({ tableName: 'inbox_messages' })
export class InboxMessageModel {
  @PrimaryKey({ type: 'text' })
  consumerName!: string;

  @PrimaryKey({ type: 'text' })
  messageId!: string;

  @Property({ type: 'character', length: 64 })
  payloadHash!: string;

  @Property({ type: 'datetime', defaultRaw: 'now()' })
  receivedAt!: Date;

  @Property({ type: 'datetime', nullable: true })
  processedAt?: Date | null;
}
