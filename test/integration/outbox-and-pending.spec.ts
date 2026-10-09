import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

import type { EventPublisher } from '@/application/ports/event-publisher.port';
import type { TransactionRunner } from '@/application/ports/transaction-runner.port';
import type { OutboxMessage } from '@/domain/entities/outbox-message.entity';
import { WagerTransactionStatus as S } from '@/domain/enums/wager-transaction-status.enum';
import { SqsEventPublisher } from '@/infrastructure/messaging/sqs-event-publisher';

import { buildUseCases, createTestOrm, dbQueries, wagerCommand } from '../support/database';
import { createTestQueues, receiveAll, testSqsClient, type TestQueues } from '../support/sqs';

class CountingPublisher implements EventPublisher {
  readonly calls: string[] = [];

  constructor(
    private readonly inner: EventPublisher,
    private readonly delayMs = 0,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<ReadonlySet<string>> {
    this.calls.push(...messages.map((m) => m.id));
    if (this.delayMs) await Bun.sleep(this.delayMs);
    return this.inner.publish(messages);
  }
}

describe('outbox e referências pendentes', () => {
  let orm: MikroORM;
  let uc: ReturnType<typeof buildUseCases>;
  let db: ReturnType<typeof dbQueries>;
  let sqs: SQSClient;
  let queues: TestQueues;
  let sqsPublisher: SqsEventPublisher;

  beforeAll(async () => {
    orm = await createTestOrm();
    uc = buildUseCases(orm);
    db = dbQueries(orm);
    sqs = testSqsClient();
    queues = await createTestQueues(sqs, 'outbox-test');
    sqsPublisher = new SqsEventPublisher(sqs, queues.eventsUrl);
  });

  afterAll(async () => {
    await queues?.destroy();
    await orm.close(true);
  });

  async function drainOutbox() {
    while ((await uc.publishOutbox(sqsPublisher).execute(100)).published > 0);
    while ((await receiveAll(sqs, queues.eventsUrl, { waitSeconds: 0 })).length > 0);
  }

  async function pendingCount(): Promise<number> {
    const [row] = await db.sql<{ n: string }>('select count(*) as n from outbox_messages where published_at is null');
    return Number(row!.n);
  }

  async function openWallet(amount = '100.00') {
    const playerId = crypto.randomUUID();
    const wallet = await uc.openWallet.execute({ playerId, initialBalance: { amount, currency: 'BRL' }, correlationId: 't' });
    return { walletId: wallet.id, playerId };
  }

  beforeEach(drainOutbox);

  describe('publicação', () => {
    it('publica os eventos pendentes no SQS e marca como publicados', async () => {
      const { walletId, playerId } = await openWallet();
      await uc.processWager.execute(wagerCommand(walletId, playerId, { amount: '10.00' }));
      const pending = await pendingCount();
      expect(pending).toBe(3); // WalletBalanceChanged (abertura) + Processed + WalletBalanceChanged (aposta)

      const result = await uc.publishOutbox(sqsPublisher).execute(50);

      expect(result).toEqual({ published: 3, failed: 0 });
      expect(await pendingCount()).toBe(0);
      const received = await receiveAll(sqs, queues.eventsUrl, { waitSeconds: 2 });
      const types = received.map((m) => JSON.parse(m.Body!).eventType).sort();
      expect(types).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged', 'WalletBalanceChanged']);
      expect(JSON.parse(received[0]!.Body!).data.money.amount).toMatch(/^\d+\.\d{2}$/);
    });

    it('publica em lotes de 10 por chamada (SendMessageBatch): 25 eventos → 3 chamadas, todos entregues', async () => {
      await Promise.all(Array.from({ length: 25 }, () => openWallet())); // 1 evento por abertura
      expect(await pendingCount()).toBe(25);

      let sqsCalls = 0;
      const countingSqs = {
        send: (command: Parameters<SQSClient['send']>[0]) => {
          sqsCalls++;
          return sqs.send(command);
        },
      } as unknown as SQSClient;

      const result = await uc.publishOutbox(new SqsEventPublisher(countingSqs, queues.eventsUrl)).execute(50);

      expect(result).toEqual({ published: 25, failed: 0 });
      expect(sqsCalls).toBe(3);
      const received = new Set<string>();
      for (let i = 0; i < 5 && received.size < 25; i++) {
        for (const m of await receiveAll(sqs, queues.eventsUrl, { waitSeconds: 1 })) {
          received.add(JSON.parse(m.Body!).eventId);
        }
      }
      expect(received.size).toBe(25);
    });

    it('13.6: dois publishers concorrentes → cada evento publicado exatamente uma vez', async () => {
      const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet()));
      await Promise.all(
        wallets.map(({ walletId, playerId }) => uc.processWager.execute(wagerCommand(walletId, playerId))),
      );
      const total = await pendingCount();
      expect(total).toBe(15);

      const a = new CountingPublisher(sqsPublisher, 20);
      const b = new CountingPublisher(sqsPublisher, 20);
      while ((await pendingCount()) > 0) {
        await Promise.all([uc.publishOutbox(a).execute(4), uc.publishOutbox(b).execute(4)]);
      }

      const all = [...a.calls, ...b.calls];
      expect(all).toHaveLength(total);
      expect(new Set(all).size).toBe(total);
      expect(a.calls.length).toBeGreaterThan(0);
      expect(b.calls.length).toBeGreaterThan(0);
    });

    it('processo morre depois de publicar e antes do COMMIT → outra instância republica (duplicata segura)', async () => {
      const { walletId, playerId } = await openWallet();
      await uc.processWager.execute(wagerCommand(walletId, playerId));
      const pending = await pendingCount();

      const crashing: TransactionRunner = {
        run: (work) =>
          uc.runner.run(async (repos) => {
            await work(repos);
            throw new Error('process died after publishing');
          }),
      };
      const dying = new CountingPublisher(sqsPublisher);
      await expect(uc.publishOutbox(dying, crashing).execute(50)).rejects.toThrow('process died');
      expect(dying.calls).toHaveLength(pending);
      expect(await pendingCount()).toBe(pending); // nada foi marcado: o COMMIT não aconteceu

      const survivor = new CountingPublisher(sqsPublisher);
      await uc.publishOutbox(survivor).execute(50);

      expect(survivor.calls.sort()).toEqual(dying.calls.sort()); // mesmos eventIds publicados de novo
      expect(await pendingCount()).toBe(0);
      const received = await receiveAll(sqs, queues.eventsUrl, { waitSeconds: 2 });
      // A FIFO deduplica pelo eventId (MessageDeduplicationId) dentro de 5 min;
      // fora dessa janela o consumidor deduplica pelo mesmo eventId.
      expect(new Set(received.map((m) => JSON.parse(m.Body!).eventId)).size).toBe(received.length);
    });

    it('SQS indisponível → mantém pendente com backoff, sem perder o evento', async () => {
      const { walletId, playerId } = await openWallet();
      await uc.processWager.execute(wagerCommand(walletId, playerId));
      const down: EventPublisher = {
        publish: async () => {
          throw new Error('sqs unavailable');
        },
      };

      const result = await uc.publishOutbox(down).execute(50);

      expect(result.published).toBe(0);
      expect(result.failed).toBeGreaterThan(0);
      const rows = await db.sql<{ attempts: number; next_attempt_at: Date }>(
        'select attempts, next_attempt_at from outbox_messages where published_at is null',
      );
      expect(rows.every((r) => r.attempts === 1 && new Date(r.next_attempt_at) > new Date())).toBe(true);
      // Ainda não venceu o backoff: a próxima rodada não pega nada.
      expect(await uc.publishOutbox(sqsPublisher).execute(50)).toEqual({ published: 0, failed: 0 });
    });
  });

  describe('worker de PENDING_REFERENCE (7.1)', () => {
    it('13.7: REFUND chega antes da BET → fica pendente → BET chega → worker aplica o REFUND', async () => {
      const { walletId, playerId } = await openWallet('100.00');
      const betId = `bet-${crypto.randomUUID()}`;

      const refund = await uc.processWager.execute(
        wagerCommand(walletId, playerId, { kind: 'REFUND', amount: '25.00', referenceExternalTransactionId: betId }),
      );
      expect(refund.status).toBe(S.PendingReference);

      await uc.processWager.execute(wagerCommand(walletId, playerId, { amount: '25.00', externalTransactionId: betId }));
      expect(await db.walletBalance(walletId)).toBe('75.00');

      // A BET antecipou o próximo retry do REFUND (next_attempt_at = agora).
      const result = await uc.retryPending.execute(50);
      expect(result.outcomes.processed).toBeGreaterThanOrEqual(1);

      const [row] = await db.sql<{ status: string }>('select status from wager_transactions where id = ?', [
        refund.transactionId,
      ]);
      expect(row?.status).toBe('PROCESSED');
      expect(await db.walletBalance(walletId)).toBe('100.00');
      expect(await db.ledgerBalance(walletId)).toBe('100.00');
    });

    it('referência que nunca chega → REJECTED com REFERENCE_NOT_FOUND e evento publicado', async () => {
      const impatient = buildUseCases(orm, { baseMs: 0, maxMs: 0, maxAttempts: 2 });
      const { walletId, playerId } = await openWallet();

      const refund = await impatient.processWager.execute(
        wagerCommand(walletId, playerId, {
          kind: 'ROLLBACK',
          amount: '5.00',
          referenceExternalTransactionId: `never-${crypto.randomUUID()}`,
        }),
      );
      expect(refund.status).toBe(S.PendingReference);

      await impatient.retryPending.execute(50);

      const [row] = await db.sql<{ status: string; failure_code: string }>(
        'select status, failure_code from wager_transactions where id = ?',
        [refund.transactionId],
      );
      expect(row).toEqual({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
      const [event] = await db.sql<{ n: string }>(
        `select count(*) as n from outbox_messages where event_type = 'WagerTransactionRejected' and aggregate_id = ?`,
        [refund.transactionId],
      );
      expect(Number(event!.n)).toBe(1);
      expect(await db.walletBalance(walletId)).toBe('100.00');
    });

    it('duas instâncias rodando o worker ao mesmo tempo não aplicam a reversão duas vezes', async () => {
      const { walletId, playerId } = await openWallet('100.00');
      const betId = `bet-${crypto.randomUUID()}`;
      await uc.processWager.execute(
        wagerCommand(walletId, playerId, { kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: betId }),
      );
      await uc.processWager.execute(wagerCommand(walletId, playerId, { amount: '10.00', externalTransactionId: betId }));

      const [a, b] = await Promise.all([uc.retryPending.execute(50), uc.retryPending.execute(50)]);

      expect(a.outcomes.processed + b.outcomes.processed).toBe(1);
      expect(await db.walletBalance(walletId)).toBe('100.00');
      expect(await db.ledgerEntries(walletId, 'CREDIT')).toHaveLength(2); // abertura + refund
    });
  });
});
