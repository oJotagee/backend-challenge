import { Inject, Injectable } from '@nestjs/common';

import { WagerTransactionStatus } from '@/domain/enums/wager-transaction-status.enum';
import type { WagerTransactionProcessor } from '@/domain/services/wager-transaction-processor';

import { CLOCK, type Clock } from '../ports/clock.port';
import { ID_GENERATOR, type IdGenerator } from '../ports/id-generator.port';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../ports/transaction-runner.port';
import { recordOutcome } from '../services/wager-outcome-recorder';
import {
  noopWageringObserver,
  WAGERING_OBSERVER,
  type WageringObserver,
} from '../ports/wagering-observer.port';
import { toResult, WAGER_TRANSACTION_PROCESSOR } from './process-wager-transaction.use-case';

export interface RetryPendingReferencesResult {
  attempted: number;
  outcomes: Record<'processed' | 'rejected' | 'pending_reference' | 'skipped', number>;
}

/**
 * Reprocessa transações PENDING_REFERENCE vencidas (seção 7.1). Cada uma em sua própria
 * transação, travando a wallet ANTES de reler a transação: a mesma ordem de lock do fluxo
 * principal, então não há deadlock, e duas instâncias que peguem o mesmo id se serializam
 * (a segunda encontra o estado já atualizado e pula).
 */
@Injectable()
export class RetryPendingReferencesUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly runner: TransactionRunner,
    @Inject(WAGER_TRANSACTION_PROCESSOR) private readonly processor: WagerTransactionProcessor,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(WAGERING_OBSERVER) private readonly observer: WageringObserver = noopWageringObserver,
  ) {}

  async execute(batchSize: number): Promise<RetryPendingReferencesResult> {
    const due = await this.runner.run((repos) => repos.transactions.findDuePendingReference(this.clock.now(), batchSize));
    const result: RetryPendingReferencesResult = {
      attempted: due.length,
      outcomes: { processed: 0, rejected: 0, pending_reference: 0, skipped: 0 },
    };

    for (const { id, walletId } of due) {
      const startedAt = performance.now();
      const { type, transaction } = await this.retryOne(id, walletId);
      result.outcomes[type]++;
      if (transaction) {
        this.observer.transactionDecided({
          result: toResult(transaction, false),
          source: 'pending-reference',
          kind: transaction.kind,
          walletId: transaction.walletId,
          providerId: transaction.providerId,
          correlationId: transaction.id,
          durationMs: performance.now() - startedAt,
        });
      }
    }
    return result;
  }

  private retryOne(transactionId: string, walletId: string) {
    return this.runner.run(async (repos) => {
      const now = this.clock.now();
      const wallet = await repos.wallets.findByIdForUpdate(walletId);
      const transaction = await repos.transactions.findById(transactionId);

      const stillDue =
        wallet &&
        transaction?.status === WagerTransactionStatus.PendingReference &&
        (!transaction.nextAttemptAt || transaction.nextAttemptAt <= now);
      if (!stillDue) return { type: 'skipped' as const };

      const reference = await repos.transactions.findByProviderExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId!,
      );
      const referenceAlreadyReversed = reference
        ? await repos.transactions.hasProcessedReversal(reference.id, transaction.kind)
        : false;

      const outcome = this.processor.process({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed,
        ledgerEntryId: this.ids.next(),
        now,
      });

      await recordOutcome(repos, {
        outcome,
        transaction,
        wallet,
        isNewTransaction: false,
        eventContext: () => ({
          eventId: this.ids.next(),
          correlationId: transaction.id,
          causationId: transaction.id,
          occurredAt: now,
        }),
      });
      return { type: outcome.type, transaction };
    });
  }
}
