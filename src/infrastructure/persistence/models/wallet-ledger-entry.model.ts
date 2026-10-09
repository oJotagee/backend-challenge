import { Check, Entity, Enum, Index, ManyToOne, PrimaryKey, Property, Trigger, Unique } from '@mikro-orm/decorators/legacy';

import { WagerTransactionModel } from './wager-transaction.model';
import { WalletModel } from './wallet.model';

const APPEND_ONLY_BODY =
  "raise exception 'wallet_ledger_entries is append-only' using errcode = 'integrity_constraint_violation';";

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ name: 'ledger_one_entry_per_tx_wallet_uq', properties: ['transactionId', 'walletId'] })
@Unique({ name: 'ledger_sequence_uq', properties: ['sequence'] })
@Index({ name: 'ledger_wallet_sequence_idx', properties: ['walletId', 'sequence'] })
@Check({ name: 'ledger_amount_positive', expression: 'amount > 0' })
@Check({ name: 'ledger_balances_non_negative', expression: 'balance_before >= 0 AND balance_after >= 0' })
@Check({
  name: 'ledger_balanced',
  expression:
    "(direction = 'CREDIT' AND balance_after = balance_before + amount) OR " +
    "(direction = 'DEBIT' AND balance_after = balance_before - amount)",
})
@Trigger({ name: 'ledger_forbid_mutation', timing: 'before', events: ['update', 'delete'], body: APPEND_ONLY_BODY })
@Trigger({
  name: 'ledger_currency_matches_wallet',
  timing: 'before',
  events: ['insert'],
  body:
    'if not exists (select 1 from wallets w where w.id = new.wallet_id and w.currency = new.currency) then ' +
    "raise exception 'ledger entry currency % does not match wallet %', new.currency, new.wallet_id " +
    "using errcode = 'foreign_key_violation'; " +
    'end if; return new;',
})
export class WalletLedgerEntryModel {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'bigint', autoincrement: true, columnType: 'bigserial' })
  sequence!: string;

  @ManyToOne(() => WalletModel, { mapToPk: true, fieldName: 'wallet_id' })
  walletId!: string;

  @ManyToOne(() => WagerTransactionModel, { mapToPk: true, fieldName: 'transaction_id' })
  transactionId!: string;

  @Enum({ items: ['DEBIT', 'CREDIT'] })
  direction!: 'DEBIT' | 'CREDIT';

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'character', length: 3 })
  currency!: string;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  balanceBefore!: string;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  balanceAfter!: string;

  @Property({ type: 'datetime', defaultRaw: 'now()' })
  createdAt!: Date;
}
