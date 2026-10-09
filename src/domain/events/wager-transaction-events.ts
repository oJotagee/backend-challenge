import type { WagerTransaction } from '../entities/wager-transaction.entity';
import type { Wallet } from '../entities/wallet.entity';
import type { WalletLedgerEntry } from '../entities/wallet-ledger-entry.entity';
import type { FailureCode } from '../enums/failure-code.enum';
import type { LedgerDirection } from '../enums/ledger-direction.enum';
import type { WagerTransactionKind } from '../enums/wager-transaction-kind.enum';
import type { MoneyProps } from '../value-objects/money.vo';
import { type EventContext, IntegrationEvent } from './integration-event';

interface TransactionRef {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function transactionRef(tx: WagerTransaction): TransactionRef {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

export interface WagerTransactionProcessedData extends TransactionRef {
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...transactionRef(tx),
        ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balanceAfter: tx.balanceAfter!.toJSON(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionRef {
  failureCode: FailureCode;
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: { ...transactionRef(tx), failureCode: tx.failureCode! },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionRef {
  referenceExternalTransactionId: string;
  attempts: number;
  nextAttemptAt: string;
}

/** Referência ausente: a transação vai ser retentada pelo worker. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...transactionRef(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId!,
        attempts: tx.attempts,
        nextAttemptAt: tx.nextAttemptAt!.toISOString(),
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda — por isso exige um lançamento do ledger. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
