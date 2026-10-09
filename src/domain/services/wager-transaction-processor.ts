import { ALLOWED_REFERENCE_KINDS, WagerTransaction } from '../entities/wager-transaction.entity';
import type { Wallet } from '../entities/wallet.entity';
import type { WalletLedgerEntry } from '../entities/wallet-ledger-entry.entity';
import { FailureCode } from '../enums/failure-code.enum';
import { LedgerDirection } from '../enums/ledger-direction.enum';
import { WagerTransactionKind } from '../enums/wager-transaction-kind.enum';
import { WagerTransactionStatus } from '../enums/wager-transaction-status.enum';
import { BusinessRuleViolationError } from '../errors/domain-error';
import type { BackoffPolicy } from './exponential-backoff';

export interface ReferenceResolutionPolicy extends BackoffPolicy {
  maxAttempts: number;
}

export interface ProcessInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  reference?: WagerTransaction;
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  now: Date;
}

export type ProcessOutcome =
  | { type: 'processed'; entry?: WalletLedgerEntry }
  | { type: 'rejected'; code: FailureCode }
  | { type: 'pending_reference' };

/**
 * Regras da seção 7, sem I/O. Recebe tudo já carregado, aplica as transições na
 * transação e na wallet, e devolve o que aconteceu. O use case só persiste o resultado.
 */
export class WagerTransactionProcessor {
  constructor(private readonly referencePolicy: ReferenceResolutionPolicy) {}

  process(input: ProcessInput): ProcessOutcome {
    const { transaction: tx, wallet, now } = input;

    const precondition = this.checkWallet(tx, wallet);
    if (precondition) return this.reject(tx, wallet, precondition, now);

    const referenceCheck = this.checkReference(input);
    if (referenceCheck === 'pending') return this.pendingOrGiveUp(tx, wallet, now);
    if (referenceCheck) return this.reject(tx, wallet, referenceCheck, now);

    if (!tx.affectsBalance()) {
      tx.markProcessed(input.reference?.id, wallet.balance, now);
      return { type: 'processed' };
    }

    try {
      const entry = this.move(input);

      tx.markProcessed(input.reference?.id, wallet.balance, now);

      return { type: 'processed', entry };
    } catch (error) {
      if (error instanceof BusinessRuleViolationError) return this.reject(tx, wallet, error.code, now);

      throw error;
    }
  }

  private checkWallet(tx: WagerTransaction, wallet: Wallet): FailureCode | undefined {
    if (wallet.id !== tx.walletId || wallet.playerId !== tx.playerId) return FailureCode.WalletPlayerMismatch;

    if (wallet.currency !== tx.money.currency) return FailureCode.CurrencyMismatch;

    return undefined;
  }

  /**
   * REFUND/ROLLBACK: referência obrigatória. WIN: referência opcional — se informada e
   * encontrada, é validada; se ainda não chegou, o WIN não fica bloqueado esperando.
   */
  private checkReference(input: ProcessInput): FailureCode | 'pending' | undefined {
    const { transaction: tx, reference } = input;
    if (!tx.referenceExternalTransactionId) return undefined;

    if (!reference) return tx.requiresReference() ? 'pending' : undefined;

    const sameContext =
      reference.providerId === tx.providerId &&
      reference.playerId === tx.playerId &&
      reference.walletId === tx.walletId &&
      reference.money.currency === tx.money.currency &&
      reference.roundId === tx.roundId;

    if (!sameContext) return FailureCode.ReferenceMismatch;

    const allowed =
      tx.kind === WagerTransactionKind.Win
        ? new Set([WagerTransactionKind.Bet])
        : ALLOWED_REFERENCE_KINDS[tx.kind];

    if (!allowed?.has(reference.kind)) return FailureCode.ReferenceKindNotAllowed;

    if (!reference.isTerminal()) return tx.requiresReference() ? 'pending' : undefined;

    if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;

    if (!tx.requiresReference()) return undefined;

    if (input.referenceAlreadyReversed) return FailureCode.ReferenceAlreadyReversed;

    if (!reference.money.equals(tx.money)) return FailureCode.ReversalAmountMismatch;

    return undefined;
  }

  private move(input: ProcessInput): WalletLedgerEntry {
    const { transaction: tx, wallet, reference, ledgerEntryId, now } = input;
    const movement = { entryId: ledgerEntryId, transactionId: tx.id, money: tx.money, at: now };

    if (tx.ledgerDirectionFor(reference) === LedgerDirection.Credit) return wallet.credit(movement);

    const insufficientFundsCode =
      tx.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalInsufficientFunds;

    return wallet.debit({ ...movement, insufficientFundsCode });
  }

  private pendingOrGiveUp(tx: WagerTransaction, wallet: Wallet, now: Date): ProcessOutcome {
    if (tx.attempts + 1 >= this.referencePolicy.maxAttempts) {
      return this.reject(tx, wallet, FailureCode.ReferenceNotFound, now);
    }

    tx.markPendingReference(now, this.referencePolicy);

    return { type: 'pending_reference' };
  }

  private reject(tx: WagerTransaction, wallet: Wallet, code: FailureCode, now: Date): ProcessOutcome {
    tx.reject(code, now, wallet.balance);

    return { type: 'rejected', code };
  }
}
