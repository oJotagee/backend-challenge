import { WalletLedgerEntry } from '@/domain/entities/wallet-ledger-entry.entity';
import type { LedgerDirection } from '@/domain/enums/ledger-direction.enum';
import { Money } from '@/domain/value-objects/money.vo';

import type { WalletLedgerEntryModel } from '../models/wallet-ledger-entry.model';

export class LedgerEntryMapper {
  static toDomain(m: WalletLedgerEntryModel): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: m.id,
      walletId: m.walletId,
      transactionId: m.transactionId,
      direction: m.direction as LedgerDirection,
      money: Money.fromPersistence(m.amount, m.currency),
      balanceBefore: Money.fromPersistence(m.balanceBefore, m.currency),
      balanceAfter: Money.fromPersistence(m.balanceAfter, m.currency),
      createdAt: m.createdAt,
    });
  }

  static toModelData(e: WalletLedgerEntry): Omit<WalletLedgerEntryModel, 'sequence'> {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.toString(),
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.toString(),
      balanceAfter: e.balanceAfter.toString(),
      createdAt: e.createdAt,
    };
  }
}
