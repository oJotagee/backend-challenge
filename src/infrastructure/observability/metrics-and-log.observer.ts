import { Injectable, Logger } from '@nestjs/common';

import type { WagerDecision, WageringObserver } from '@/application/ports/wagering-observer.port';
import type { ReconciliationResult } from '@/application/use-cases/reconcile-wallet.use-case';

import { Metrics } from './metrics';

/**
 * Um ponto só para métricas e logs do que a aplicação reporta.
 * Os logs levam ids e status; nunca valores, saldos ou payload (seção 12) — exceto a
 * divergência de reconciliação, que é um incidente e precisa dos valores para investigar.
 */
@Injectable()
export class MetricsAndLogObserver implements WageringObserver {
  private readonly transactionLogger = new Logger('WagerTransaction');
  private readonly reconciliationLogger = new Logger('Reconciliation');

  constructor(private readonly metrics: Metrics) {}

  transactionDecided(d: WagerDecision): void {
    const { result } = d;

    if (result.idempotentReplay) {
      this.metrics.duplicatesDetected.inc({ source: d.source });
    } else {
      this.metrics.transactionsByStatus.inc({ kind: d.kind, status: result.status, failure_code: result.failureCode ?? '' });
    }
    this.metrics.processingLatency.observe({ source: d.source }, d.durationMs / 1000);

    this.transactionLogger.log(
      {
        ...(d.source === 'http' ? {} : { correlationId: d.correlationId }),
        ...(d.messageId ? { messageId: d.messageId } : {}),
        transactionId: result.transactionId,
        walletId: d.walletId,
        providerId: d.providerId,
        source: d.source,
        kind: d.kind,
        status: result.status,
        ...(result.failureCode ? { failureCode: result.failureCode } : {}),
        idempotentReplay: result.idempotentReplay,
        durationMs: Math.round(d.durationMs * 10) / 10,
      },
      'wager transaction decided',
    );
  }

  reconciliationDiverged(result: ReconciliationResult): void {
    this.metrics.reconciliationDivergences.inc();
    this.reconciliationLogger.error(
      {
        walletId: result.walletId,
        stored: result.storedBalance.amount,
        calculated: result.calculatedBalance.amount,
        difference: result.difference.amount,
        checkedEntries: result.checkedEntries,
      },
      'wallet balance diverges from ledger',
    );
  }
}
