import type { MikroORM } from '@mikro-orm/postgresql';

import type { LedgerPage, WageringReadRepository } from '@/application/ports/wagering-read.port';
import type { WagerTransaction } from '@/domain/entities/wager-transaction.entity';
import type { Wallet } from '@/domain/entities/wallet.entity';

import { LedgerEntryMapper } from '../mappers/ledger-entry.mapper';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper';
import { WalletMapper } from '../mappers/wallet.mapper';
import { WagerTransactionModel } from '../models/wager-transaction.model';
import { WalletLedgerEntryModel } from '../models/wallet-ledger-entry.model';
import { WalletModel } from '../models/wallet.model';

/** Cada leitura usa um EntityManager novo (identity map vazio), em autocommit, sem lock. */
export class MikroOrmWageringReadRepository implements WageringReadRepository {
  constructor(private readonly orm: MikroORM) {}

  async findWallet(walletId: string): Promise<Wallet | undefined> {
    const model = await this.em().findOne(WalletModel, { id: walletId });
    return model ? WalletMapper.toDomain(model) : undefined;
  }

  async listLedger(walletId: string, afterSequence: string | undefined, limit: number): Promise<LedgerPage> {
    const models = await this.em().find(
      WalletLedgerEntryModel,
      afterSequence ? { walletId, sequence: { $gt: afterSequence } } : { walletId },
      { orderBy: { sequence: 'asc' }, limit: limit + 1 },
    );
    return {
      entries: models
        .slice(0, limit)
        .map((m) => ({ entry: LedgerEntryMapper.toDomain(m), sequence: String(m.sequence) })),
      hasMore: models.length > limit,
    };
  }

  findTransaction(transactionId: string): Promise<WagerTransaction | undefined> {
    return this.transaction({ id: transactionId });
  }

  findTransactionByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.transaction({ providerId, externalTransactionId });
  }

  private async transaction(where: Partial<WagerTransactionModel>): Promise<WagerTransaction | undefined> {
    const model = await this.em().findOne(WagerTransactionModel, where);
    return model ? WagerTransactionMapper.toDomain(model) : undefined;
  }

  private em() {
    return this.orm.em.fork();
  }
}
