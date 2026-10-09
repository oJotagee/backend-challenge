import type { WagerTransactionKind } from '@/domain/enums/wager-transaction-kind.enum';

import type { ProcessWagerTransactionResult } from '../use-cases/process-wager-transaction.use-case';
import type { ReconciliationResult } from '../use-cases/reconcile-wallet.use-case';

export const WAGERING_OBSERVER = Symbol('WAGERING_OBSERVER');

export type DecisionSource = 'http' | 'sqs' | 'pending-reference';

export interface WagerDecision {
  result: ProcessWagerTransactionResult;
  source: DecisionSource;
  kind: WagerTransactionKind;
  walletId: string;
  providerId: string;
  correlationId: string;
  messageId?: string;
  durationMs: number;
}

/** Fatos que a aplicação reporta para métricas e logs, sem conhecer prom-client nem logger. */
export interface WageringObserver {
  transactionDecided(decision: WagerDecision): void;
  reconciliationDiverged(result: ReconciliationResult): void;
}

export const noopWageringObserver: WageringObserver = {
  transactionDecided: () => {},
  reconciliationDiverged: () => {},
};
