import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { Injectable } from '@nestjs/common';

@Injectable()
export class Metrics {
  readonly registry = new Registry();

  readonly transactionsByStatus = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações por kind e status final',
    labelNames: ['kind', 'status', 'failure_code'] as const,
    registers: [this.registry],
  });
  readonly duplicatesDetected = new Counter({
    name: 'wager_duplicates_total',
    help: 'Replays idempotentes e mensagens duplicadas na inbox',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });
  readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Retries por componente',
    labelNames: ['component'] as const,
    registers: [this.registry],
  });
  readonly dlqMessages = new Counter({
    name: 'wager_dlq_messages_total',
    help: 'Mensagens enviadas para a DLQ',
    registers: [this.registry],
  });
  readonly lockConflicts = new Counter({
    name: 'wager_lock_conflicts_total',
    help: 'Conflitos de concorrência (lock timeout, serialização, unique violation)',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });
  readonly outboxLagSeconds = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Idade da mensagem pendente mais antiga da outbox',
    registers: [this.registry],
  });
  readonly processingLatency = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Latência do use case de processamento',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });
  readonly reconciliationDivergences = new Counter({
    name: 'wallet_reconciliation_divergences_total',
    help: 'Divergências entre saldo materializado e ledger',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}
