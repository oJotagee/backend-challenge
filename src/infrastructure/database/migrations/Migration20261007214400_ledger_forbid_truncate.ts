import { Migration } from '@mikro-orm/migrations';

export class Migration20261007214400_ledger_forbid_truncate extends Migration {
  override name = 'Migration20261007214400_ledger_forbid_truncate';

  override up(): void {
    this.addSql(`
      create or replace function "ledger_forbid_truncate_fn"() returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries is append-only' using errcode = 'integrity_constraint_violation';
      end; $$ language plpgsql;
    `);
    this.addSql(`
      create trigger "ledger_forbid_truncate" before truncate on "wallet_ledger_entries"
        for each statement execute function "ledger_forbid_truncate_fn"();
    `);
  }

  override down(): void {
    this.addSql(`drop trigger if exists "ledger_forbid_truncate" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "ledger_forbid_truncate_fn"();`);
  }
}
