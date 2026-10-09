import { Migration } from '@mikro-orm/migrations';

export class Migration20261008001455_ledger_currency_matches_wallet extends Migration {

  override name = 'Migration20261008001455_ledger_currency_matches_wallet';

  override up(): void | Promise<void> {
    this.addSql(`create or replace function "wallet_ledger_entries_ledger_currency_matches_wallet_fn"() returns trigger as \$\$ begin if not exists (select 1 from wallets w where w.id = new.wallet_id and w.currency = new.currency) then raise exception 'ledger entry currency % does not match wallet %', new.currency, new.wallet_id using errcode = 'foreign_key_violation'; end if; return new; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "ledger_currency_matches_wallet" BEFORE INSERT on "wallet_ledger_entries" for each ROW execute function "wallet_ledger_entries_ledger_currency_matches_wallet_fn"();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop trigger if exists "ledger_currency_matches_wallet" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "wallet_ledger_entries_ledger_currency_matches_wallet_fn"();`);
  }

}
