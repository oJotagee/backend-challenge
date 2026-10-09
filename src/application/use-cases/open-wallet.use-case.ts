import { Inject, Injectable } from '@nestjs/common';

import { OutboxMessage } from '@/domain/entities/outbox-message.entity';
import { WagerTransaction } from '@/domain/entities/wager-transaction.entity';
import { Wallet } from '@/domain/entities/wallet.entity';
import { WalletBalanceChanged } from '@/domain/events/wager-transaction-events';
import { Money, type MoneyProps } from '@/domain/value-objects/money.vo';

import { UniqueConflictError, WalletAlreadyExistsError } from '../errors/application-errors';
import { CLOCK, type Clock } from '../ports/clock.port';
import { ID_GENERATOR, type IdGenerator } from '../ports/id-generator.port';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../ports/transaction-runner.port';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/**
 * Cria a wallet. Saldo inicial > 0 gera, na MESMA transação SQL, a transação interna
 * OPENING + o lançamento CREDIT + o evento WalletBalanceChanged (seção 9).
 */
@Injectable()
export class OpenWalletUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly runner: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<OpenWalletResult> {
    const initialBalance = Money.from(command.initialBalance);

    try {
      return await this.runner.run(async (repos) => {
        const now = this.clock.now();
        const walletId = this.ids.next();
        const openingTransactionId = this.ids.next();

        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance,
          openingTransactionId,
          openingEntryId: this.ids.next(),
          now,
        });

        repos.wallets.add(wallet);

        if (openingEntry) {
          const opening = WagerTransaction.opening({
            id: openingTransactionId,
            walletId,
            playerId: command.playerId,
            money: initialBalance,
            now,
          });
          repos.transactions.add(opening);
          repos.ledger.add(openingEntry);
          const event = WalletBalanceChanged.from(wallet, openingEntry, {
            eventId: this.ids.next(),
            correlationId: command.correlationId,
            occurredAt: now,
          });
          repos.outbox.add(OutboxMessage.enqueue(event));
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (error) {
      if (error instanceof UniqueConflictError) {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }
  }
}
