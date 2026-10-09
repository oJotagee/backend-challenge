import { Wallet } from '@/domain/entities/wallet.entity';
import { Money } from '@/domain/value-objects/money.vo';

import type { WalletModel } from '../models/wallet.model';

export class WalletMapper {
  static toDomain(model: WalletModel): Wallet {
    return Wallet.rehydrate({
      id: model.id,
      playerId: model.playerId,
      currency: model.currency,
      balance: Money.fromPersistence(model.balance, model.currency),
      version: model.version,
      createdAt: model.createdAt,
      updatedAt: model.updatedAt,
    });
  }

  static toModelData(wallet: Wallet): WalletModel {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  static applyChanges(wallet: Wallet, model: WalletModel): void {
    model.balance = wallet.balance.toString();
    model.version = wallet.version;
    model.updatedAt = wallet.updatedAt;
  }
}
