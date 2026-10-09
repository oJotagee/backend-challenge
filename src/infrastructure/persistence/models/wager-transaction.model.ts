import { Check, Entity, Enum, Index, ManyToOne, PrimaryKey, Property, Trigger, Unique } from '@mikro-orm/decorators/legacy';

import { WalletModel } from './wallet.model';
export const WAGER_TRANSACTION_KINDS = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export const WAGER_TRANSACTION_STATUSES = ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'] as const;

@Entity({ tableName: 'wager_transactions' })
@Unique({ name: 'wager_tx_idempotency_key_uq', properties: ['idempotencyKey'] })
@Unique({ name: 'wager_tx_provider_external_uq', properties: ['providerId', 'externalTransactionId'] })
@Check({ name: 'wager_tx_amount_non_negative', expression: 'amount >= 0' })
@Check({
  name: 'wager_tx_reference_required',
  expression: "kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL",
})
@Check({
  name: 'wager_tx_failure_code_on_failure',
  expression: "(status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)",
})
@Index({
  name: 'wager_tx_single_reversal_uq',
  expression:
    'create unique index "wager_tx_single_reversal_uq" on "wager_transactions" ("reference_transaction_id", "kind") ' +
    "where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')",
})
@Index({
  name: 'wager_tx_pending_reference_idx',
  expression:
    'create index "wager_tx_pending_reference_idx" on "wager_transactions" ("next_attempt_at") ' +
    "where status = 'PENDING_REFERENCE'",
})
@Index({
  name: 'wager_tx_reference_lookup_idx',
  expression:
    'create index "wager_tx_reference_lookup_idx" on "wager_transactions" ("provider_id", "reference_external_transaction_id") ' +
    'where reference_external_transaction_id is not null',
})
@Trigger({
  name: 'wager_tx_guard_terminal',
  timing: 'before',
  events: ['update'],
  body:
    "if old.status in ('PROCESSED','REJECTED','FAILED') then " +
    "raise exception 'wager transaction % is terminal (%)', old.id, old.status using errcode = 'integrity_constraint_violation'; " +
    'end if; return new;',
})
export class WagerTransactionModel {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'text' })
  providerId!: string;

  @Property({ type: 'text' })
  externalTransactionId!: string;

  @Property({ type: 'text' })
  idempotencyKey!: string;

  @Property({ type: 'character', length: 64 })
  payloadHash!: string;

  @ManyToOne(() => WalletModel, { mapToPk: true, fieldName: 'wallet_id' })
  walletId!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ type: 'text' })
  roundId!: string;

  @Property({ type: 'text' })
  gameId!: string;

  @Enum({ items: [...WAGER_TRANSACTION_KINDS] })
  kind!: (typeof WAGER_TRANSACTION_KINDS)[number];

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'character', length: 3 })
  currency!: string;

  @Property({ type: 'text', nullable: true })
  referenceExternalTransactionId?: string | null;

  @ManyToOne(() => WagerTransactionModel, { mapToPk: true, fieldName: 'reference_transaction_id', nullable: true })
  referenceTransactionId?: string | null;

  @Enum({ items: [...WAGER_TRANSACTION_STATUSES] })
  status!: (typeof WAGER_TRANSACTION_STATUSES)[number];

  @Property({ type: 'text', nullable: true })
  failureCode?: string | null;

  @Property({ type: 'decimal', precision: 20, scale: 2, nullable: true })
  balanceAfter?: string | null;

  @Property({ type: 'integer', default: 0 })
  attempts!: number;

  @Property({ type: 'datetime', nullable: true })
  nextAttemptAt?: Date | null;

  @Property({ type: 'datetime', defaultRaw: 'now()' })
  createdAt!: Date;

  @Property({ type: 'datetime', nullable: true })
  processedAt?: Date | null;
}
