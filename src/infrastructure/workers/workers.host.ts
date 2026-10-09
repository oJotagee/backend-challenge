import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';

import { PublishOutboxUseCase } from '@/application/use-cases/publish-outbox.use-case';
import { ProcessWagerTransactionUseCase } from '@/application/use-cases/process-wager-transaction.use-case';
import { RetryPendingReferencesUseCase } from '@/application/use-cases/retry-pending-references.use-case';
import { APP_CONFIG, type AppConfig } from '@/config';

import { SQS_CLIENT } from '../messaging/sqs.client';
import { SqsWagerConsumer } from '../messaging/sqs-wager-consumer';
import { Metrics } from '../observability/metrics';
import { IntervalWorker } from './interval-worker';

export const WAGER_CONSUMER_NAME = 'wager-transactions';
const PENDING_REFERENCE_BATCH = 50;

/**
 * Sobe os três processos de fundo em TODA instância (não há líder): o consumer SQS, o
 * publicador da outbox e o worker de PENDING_REFERENCE. A segurança entre instâncias vem
 * do banco (inbox, SKIP LOCKED, lock da wallet), não de haver um só worker.
 */
@Injectable()
export class WorkersHost implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Workers');
  private consumer?: SqsWagerConsumer;
  private workers: IntervalWorker[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly metrics: Metrics,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly publishOutbox: PublishOutboxUseCase,
    private readonly retryPending: RetryPendingReferencesUseCase,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.WORKERS_ENABLED) return;
    const log = {
      log: (obj: object, msg: string) => this.logger.log(obj, msg),
      warn: (obj: object, msg: string) => this.logger.warn(obj, msg),
      error: (obj: object, msg: string) => this.logger.error(obj, msg),
    };

    this.consumer = new SqsWagerConsumer({
      sqs: this.sqs,
      queueUrl: this.config.SQS_WAGER_QUEUE_URL,
      dlqUrl: this.config.SQS_WAGER_DLQ_URL,
      consumerName: WAGER_CONSUMER_NAME,
      waitTimeSeconds: this.config.SQS_WAIT_TIME_SECONDS,
      maxReceiveCount: this.config.SQS_MAX_RECEIVE_COUNT,
      retryBaseSeconds: this.config.SQS_RETRY_BASE_SECONDS,
      retryMaxSeconds: this.config.SQS_RETRY_MAX_SECONDS,
      shutdownGraceMs: this.config.SHUTDOWN_GRACE_MS,
      process: (command) => this.processWager.execute(command),
      logger: log,
      metrics: this.metrics,
    });

    this.workers = [
      new IntervalWorker('outbox-publisher', this.config.OUTBOX_POLL_INTERVAL_MS, () => this.publishTick(), log),
      new IntervalWorker(
        'pending-reference',
        this.config.PENDING_REFERENCE_POLL_INTERVAL_MS,
        () => this.pendingTick(),
        log,
      ),
    ];

    this.consumer.start();
    for (const worker of this.workers) worker.start();
    this.logger.log({}, 'workers started');
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.consumer?.stop(), ...this.workers.map((w) => w.stop())]);
    this.logger.log({}, 'workers stopped');
  }

  private async publishTick(): Promise<boolean> {
    const { published, failed } = await this.publishOutbox.execute(this.config.OUTBOX_BATCH_SIZE);
    if (failed > 0) this.metrics.retries.inc({ component: 'outbox-publisher' }, failed);
    this.metrics.outboxLagSeconds.set(await this.publishOutbox.lagSeconds());
    return published + failed === this.config.OUTBOX_BATCH_SIZE;
  }

  private async pendingTick(): Promise<boolean> {
    const result = await this.retryPending.execute(PENDING_REFERENCE_BATCH);
    return result.attempted === PENDING_REFERENCE_BATCH;
  }
}
