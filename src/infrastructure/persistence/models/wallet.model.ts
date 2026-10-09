import { Check, Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

/**
 * Modelo de persistência (equivalente ao `model Wallet` do Prisma).
 * Não é o agregado de domínio: o mapper traduz WalletModel ↔ Wallet.
 */
@Entity({ tableName: 'wallets' })
@Unique({ name: 'wallets_player_currency_uq', properties: ['playerId', 'currency'] })
@Check({ name: 'wallets_balance_non_negative', expression: 'balance >= 0' })
@Check({ name: 'wallets_version_positive', expression: 'version >= 1' })
@Check({ name: 'wallets_currency_iso', expression: "currency ~ '^[A-Z]{3}$'" })
export class WalletModel {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ type: 'character', length: 3 })
  currency!: string;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  balance!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property({ type: 'datetime', defaultRaw: 'now()' })
  createdAt!: Date;

  @Property({ type: 'datetime', defaultRaw: 'now()' })
  updatedAt!: Date;
}
