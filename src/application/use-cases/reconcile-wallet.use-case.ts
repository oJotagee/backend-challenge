import { Inject, Injectable } from '@nestjs/common';

import { Money, type MoneyProps } from '@/domain/value-objects/money.vo';

import { WalletNotFoundError } from '../errors/application-errors';
import { noopWageringObserver, WAGERING_OBSERVER, type WageringObserver } from '../ports/wagering-observer.port';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../ports/transaction-runner.port';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly runner: TransactionRunner,
    @Inject(WAGERING_OBSERVER) private readonly observer: WageringObserver = noopWageringObserver,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const result = await this.runner.run(async (repos) => {
      const wallet = await repos.wallets.findByIdForUpdate(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);

      const summary = await repos.ledger.summarize(walletId);
      const calculated = Money.fromPersistence(summary.calculatedBalance, wallet.currency);
      const difference = wallet.balance.subtract(calculated);

      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: summary.entryCount,
      };
    });

    if (!result.consistent) this.observer.reconciliationDiverged(result);
    return result;
  }
}
