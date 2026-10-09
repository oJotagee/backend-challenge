import { Migration } from '@mikro-orm/migrations';

export class Migration20261007214337_initial_schema extends Migration {

  override name = 'Migration20261007214337_initial_schema';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_messages" ("consumer_name" text not null, "message_id" text not null, "payload_hash" char(64) not null, "received_at" timestamptz not null default now(), "processed_at" timestamptz null, primary key ("consumer_name", "message_id"));`);

    this.addSql(`create table "outbox_messages" ("id" uuid not null, "aggregate_id" uuid not null, "event_type" text not null, "payload" jsonb not null, "occurred_at" timestamptz not null, "attempts" int not null default 0, "next_attempt_at" timestamptz not null default now(), "published_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "outbox_pending_idx" on "outbox_messages" ("next_attempt_at") where published_at is null;`);
    this.addSql(`alter table "outbox_messages" add constraint "outbox_attempts_non_negative" check (attempts >= 0);`);

    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" uuid not null, "currency" char(3) not null, "balance" numeric(20,2) not null, "version" int not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_currency_uq" unique ("player_id", "currency");`);
    this.addSql(`alter table "wallets" add constraint "wallets_currency_iso" check (currency ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "wallets" add constraint "wallets_version_positive" check (version >= 1);`);
    this.addSql(`alter table "wallets" add constraint "wallets_balance_non_negative" check (balance >= 0);`);

    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" text not null, "external_transaction_id" text not null, "idempotency_key" text not null, "payload_hash" char(64) not null, "wallet_id" uuid not null, "player_id" uuid not null, "round_id" text not null, "game_id" text not null, "kind" text not null, "amount" numeric(20,2) not null, "currency" char(3) not null, "reference_external_transaction_id" text null, "reference_transaction_id" uuid null, "status" text not null, "failure_code" text null, "balance_after" numeric(20,2) null, "attempts" int not null default 0, "next_attempt_at" timestamptz null, "created_at" timestamptz not null default now(), "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "wager_tx_reference_lookup_idx" on "wager_transactions" ("provider_id", "reference_external_transaction_id") where reference_external_transaction_id is not null;`);
    this.addSql(`create index "wager_tx_pending_reference_idx" on "wager_transactions" ("next_attempt_at") where status = 'PENDING_REFERENCE';`);
    this.addSql(`create unique index "wager_tx_single_reversal_uq" on "wager_transactions" ("reference_transaction_id", "kind") where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_tx_provider_external_uq" unique ("provider_id", "external_transaction_id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_tx_idempotency_key_uq" unique ("idempotency_key");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_tx_failure_code_on_failure" check ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_tx_reference_required" check (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_tx_amount_non_negative" check (amount >= 0);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_kind_check" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
    this.addSql(`create or replace function "wager_transactions_wager_tx_guard_terminal_fn"() returns trigger as \$\$ begin if old.status in ('PROCESSED','REJECTED','FAILED') then raise exception 'wager transaction % is terminal (%)', old.id, old.status using errcode = 'integrity_constraint_violation'; end if; return new; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "wager_tx_guard_terminal" BEFORE UPDATE on "wager_transactions" for each ROW execute function "wager_transactions_wager_tx_guard_terminal_fn"();`);

    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "sequence" bigserial, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" text not null, "amount" numeric(20,2) not null, "currency" char(3) not null, "balance_before" numeric(20,2) not null, "balance_after" numeric(20,2) not null, "created_at" timestamptz not null default now(), primary key ("id"));`);
    this.addSql(`create index "ledger_wallet_sequence_idx" on "wallet_ledger_entries" ("wallet_id", "sequence");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_sequence_uq" unique ("sequence");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_one_entry_per_tx_wallet_uq" unique ("transaction_id", "wallet_id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_balanced" check ((direction = 'CREDIT' AND balance_after = balance_before + amount) OR (direction = 'DEBIT' AND balance_after = balance_before - amount));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_balances_non_negative" check (balance_before >= 0 AND balance_after >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "ledger_amount_positive" check (amount > 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_direction_check" check ("direction" in ('DEBIT', 'CREDIT'));`);
    this.addSql(`create or replace function "wallet_ledger_entries_ledger_forbid_mutation_fn"() returns trigger as \$\$ begin raise exception 'wallet_ledger_entries is append-only' using errcode = 'integrity_constraint_violation'; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "ledger_forbid_mutation" BEFORE UPDATE OR DELETE on "wallet_ledger_entries" for each ROW execute function "wallet_ledger_entries_ledger_forbid_mutation_fn"();`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete set null;`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_transaction_id_foreign" foreign key ("transaction_id") references "wager_transactions" ("id");`);
  }

  // Escrito à mão: `migration:create --initial` não gera down().
  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
    this.addSql(`drop function if exists "wallet_ledger_entries_ledger_forbid_mutation_fn"();`);
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop function if exists "wager_transactions_wager_tx_guard_terminal_fn"();`);
    this.addSql(`drop table if exists "wallets" cascade;`);
    this.addSql(`drop table if exists "outbox_messages" cascade;`);
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
  }

}
