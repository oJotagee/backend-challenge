import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { LoggerModule } from 'nestjs-pino';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Module } from '@nestjs/common';

import { ProcessWagerTransactionUseCase, WAGER_TRANSACTION_PROCESSOR } from './application/use-cases/process-wager-transaction.use-case';
import { MikroOrmTransactionRunner } from './infrastructure/persistence/mikro-orm-transaction-runner';
import { ReconcileWalletUseCase } from './application/use-cases/reconcile-wallet.use-case';
import { WagerTransactionProcessor } from './domain/services/wager-transaction-processor';
import { TRANSACTION_RUNNER } from './application/ports/transaction-runner.port';
import { ID_GENERATOR, UuidV7Generator } from './application/ports/id-generator.port';
import { SQS_CLIENT, createSqsClient } from './infrastructure/messaging/sqs.client';
import { WageringController } from './presentation/controllers/wagering.controller';
import { OpenWalletUseCase } from './application/use-cases/open-wallet.use-case';
import { MetricsController } from './presentation/controllers/metrics.controller';
import { HealthController } from './presentation/controllers/health.controller';
import { WalletsController } from './presentation/controllers/wallets.controller';
import { HttpExceptionFilter } from './presentation/filters/http-exception.filter';
import { MikroOrmWageringReadRepository } from './infrastructure/persistence/repositories/mikro-orm-read.repository';
import { WAGERING_READ_REPOSITORY } from './application/ports/wagering-read.port';
import { WageringQueries } from './application/use-cases/wagering-queries.use-case';
import { RetryPendingReferencesUseCase } from './application/use-cases/retry-pending-references.use-case';
import { PublishOutboxUseCase } from './application/use-cases/publish-outbox.use-case';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { EVENT_PUBLISHER } from './application/ports/event-publisher.port';
import { WorkersHost } from './infrastructure/workers/workers.host';
import { MetricsAndLogObserver } from './infrastructure/observability/metrics-and-log.observer';
import { WAGERING_OBSERVER } from './application/ports/wagering-observer.port';
import { CLOCK, SystemClock } from './application/ports/clock.port';
import { Metrics } from './infrastructure/observability/metrics';
import { AuthGuard } from './infrastructure/auth/auth.guard';
import { APP_CONFIG, loadConfig } from './config';
import ormConfig from '../mikro-orm.config';

const config = loadConfig();

@Module({
  imports: [
    MikroOrmModule.forRoot({ ...ormConfig, clientUrl: config.DATABASE_URL, registerRequestContext: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: config.LOG_LEVEL,
        base: { instance: config.INSTANCE_ID },
        genReqId: (req) => (req.headers['x-correlation-id'] as string | undefined) ?? crypto.randomUUID(),
        quietReqLogger: true,
        customAttributeKeys: { reqId: 'correlationId' },
        redact: ['req.headers.authorization', 'req.body', 'res.body'],
        ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
      },
    }),
  ],
  controllers: [HealthController, MetricsController, WalletsController, WageringController],
  providers: [
    { provide: APP_CONFIG, useValue: config },
    { provide: SQS_CLIENT, useFactory: () => createSqsClient(config) },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    Metrics,

    { provide: TRANSACTION_RUNNER, useFactory: (orm: MikroORM, metrics: Metrics) => new MikroOrmTransactionRunner(orm, (kind) => metrics.lockConflicts.inc({ kind })), inject: [MikroORM, Metrics] },
    { provide: WAGERING_READ_REPOSITORY, useFactory: (orm: MikroORM) => new MikroOrmWageringReadRepository(orm), inject: [MikroORM] },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: WAGERING_OBSERVER, useClass: MetricsAndLogObserver },
    {
      provide: EVENT_PUBLISHER,
      useFactory: (sqs: SQSClient) => new SqsEventPublisher(sqs, config.SQS_EVENTS_QUEUE_URL),
      inject: [SQS_CLIENT],
    },
    {
      provide: WAGER_TRANSACTION_PROCESSOR,
      useFactory: () =>
        new WagerTransactionProcessor({
          baseMs: config.PENDING_REFERENCE_POLL_INTERVAL_MS,
          maxMs: 5 * 60_000,
          maxAttempts: config.PENDING_REFERENCE_MAX_ATTEMPTS,
        }),
    },

    OpenWalletUseCase,
    WageringQueries,
    ReconcileWalletUseCase,
    ProcessWagerTransactionUseCase,
    PublishOutboxUseCase,
    RetryPendingReferencesUseCase,
    WorkersHost,
  ],
})
export class AppModule {}
