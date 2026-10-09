import 'reflect-metadata';

import { MikroORM } from '@mikro-orm/postgresql';

import { SystemClock } from '@/application/ports/clock.port';
import { UuidV7Generator } from '@/application/ports/id-generator.port';
import { OpenWalletUseCase } from '@/application/use-cases/open-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '@/application/use-cases/process-wager-transaction.use-case';
import { PublishOutboxUseCase } from '@/application/use-cases/publish-outbox.use-case';
import { RetryPendingReferencesUseCase } from '@/application/use-cases/retry-pending-references.use-case';
import type { EventPublisher } from '@/application/ports/event-publisher.port';
import type { TransactionRunner } from '@/application/ports/transaction-runner.port';
import { WagerTransactionProcessor } from '@/domain/services/wager-transaction-processor';
import { MikroOrmTransactionRunner } from '@/infrastructure/persistence/mikro-orm-transaction-runner';

import baseConfig from '../../mikro-orm.config';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * Sobe um MikroORM contra o banco `wagering_test` com o schema recriado do zero.
 * Não dá para limpar com TRUNCATE/DELETE: o ledger proíbe (é append-only). Por isso
 * DROP SCHEMA + todas as migrations — o que de quebra testa as migrations.
 */
export async function createTestOrm(): Promise<MikroORM> {
  if (!TEST_DATABASE_URL?.includes('_test')) {
    throw new Error('TEST_DATABASE_URL must point to a *_test database');
  }

  const orm = await MikroORM.init({
    ...baseConfig,
    clientUrl: TEST_DATABASE_URL,
    pool: { min: 0, max: 20 },
    debug: false,
  });
  await orm.em.getConnection().execute('drop schema if exists public cascade; create schema public;');
  await orm.migrator.up();
  return orm;
}

/** Conecta no banco de teste SEM recriar o schema (usado pelos processos filhos). */
export async function connectTestOrm(): Promise<MikroORM> {
  return MikroORM.init({ ...baseConfig, clientUrl: TEST_DATABASE_URL, pool: { min: 0, max: 10 }, debug: false });
}

export function buildUseCases(orm: MikroORM, policy = { baseMs: 1_000, maxMs: 60_000, maxAttempts: 8 }) {
  const runner = new MikroOrmTransactionRunner(orm);
  const clock = new SystemClock();
  const ids = new UuidV7Generator();
  const processor = new WagerTransactionProcessor(policy);
  return {
    runner,
    clock,
    openWallet: new OpenWalletUseCase(runner, clock, ids),
    processWager: new ProcessWagerTransactionUseCase(runner, processor, clock, ids),
    retryPending: new RetryPendingReferencesUseCase(runner, processor, clock, ids),
    publishOutbox: (publisher: EventPublisher, publisherRunner: TransactionRunner = runner) =>
      new PublishOutboxUseCase(publisherRunner, publisher, clock),
  };
}

/** Consultas SQL diretas para os asserts: o teste não confia no próprio código que testa. */
export function dbQueries(orm: MikroORM) {
  const sql = <T>(query: string, params: unknown[] = []) => orm.em.fork().getConnection().execute<T[]>(query, params);

  return {
    sql,
    async walletBalance(walletId: string): Promise<string> {
      const [row] = await sql<{ balance: string }>('select balance from wallets where id = ?', [walletId]);
      return row!.balance;
    },
    /** Saldo reconstruído só pelo ledger: Σ créditos − Σ débitos. */
    async ledgerBalance(walletId: string): Promise<string> {
      const [row] = await sql<{ total: string }>(
        `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(20,2) as total
           from wallet_ledger_entries where wallet_id = ?`,
        [walletId],
      );
      return row!.total;
    },
    async ledgerEntries(walletId: string, direction?: 'DEBIT' | 'CREDIT') {
      return sql<{ transaction_id: string; amount: string }>(
        `select transaction_id, amount from wallet_ledger_entries where wallet_id = ? ${direction ? 'and direction = ?' : ''}`,
        direction ? [walletId, direction] : [walletId],
      );
    },
    async countOutbox(eventType?: string): Promise<number> {
      const [row] = await sql<{ n: string }>(
        `select count(*) as n from outbox_messages ${eventType ? 'where event_type = ?' : ''}`,
        eventType ? [eventType] : [],
      );
      return Number(row!.n);
    },
  };
}

let seq = 0;
/** Gera um payload de transação válido; cada chamada usa um externalTransactionId novo. */
export function wagerCommand(
  walletId: string,
  playerId: string,
  overrides: Partial<{
    kind: string;
    amount: string;
    externalTransactionId: string;
    referenceExternalTransactionId: string;
    roundId: string;
    messageId: string;
  }> = {},
) {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${Date.now()}-${++seq}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    correlationId: `corr-${externalTransactionId}`,
    source: overrides.messageId
      ? ({ type: 'sqs', consumerName: 'wager-transactions', messageId: overrides.messageId } as const)
      : ({ type: 'http' } as const),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId,
      walletId,
      roundId: overrides.roundId ?? 'round-1',
      gameId: 'fortune-chimp',
      kind: (overrides.kind ?? 'BET') as never,
      money: { amount: overrides.amount ?? '10.00', currency: 'BRL' },
      ...(overrides.referenceExternalTransactionId
        ? { referenceExternalTransactionId: overrides.referenceExternalTransactionId }
        : {}),
    },
  };
}
