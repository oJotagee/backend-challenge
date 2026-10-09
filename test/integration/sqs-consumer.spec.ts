import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

import { TransientInfrastructureError } from '@/application/errors/application-errors';
import type { ProcessWagerTransactionCommand } from '@/application/use-cases/process-wager-transaction.use-case';
import type { MessageDisposition, SqsWagerConsumer } from '@/infrastructure/messaging/sqs-wager-consumer';

import { buildUseCases, createTestOrm, dbQueries, wagerCommand } from '../support/database';
import {
  createTestQueues,
  receiveAll,
  sendRaw,
  sendWagerMessage,
  testConsumer,
  testSqsClient,
  type TestQueues,
} from '../support/sqs';

/** PostgreSQL e LocalStack reais. Cada execução usa filas próprias. */
describe('consumer SQS', () => {
  let orm: MikroORM;
  let uc: ReturnType<typeof buildUseCases>;
  let db: ReturnType<typeof dbQueries>;
  let sqs: SQSClient;
  let queues: TestQueues;

  beforeAll(async () => {
    orm = await createTestOrm();
    uc = buildUseCases(orm);
    db = dbQueries(orm);
    sqs = testSqsClient();
    queues = await createTestQueues(sqs, 'consumer-test');
  });

  afterAll(async () => {
    await queues?.destroy();
    await orm.close(true);
  });

  const realProcess = (command: ProcessWagerTransactionCommand) => uc.processWager.execute(command);

  async function openWallet(amount = '100.00') {
    const playerId = crypto.randomUUID();
    const wallet = await uc.openWallet.execute({ playerId, initialBalance: { amount, currency: 'BRL' }, correlationId: 't' });
    return { walletId: wallet.id, playerId };
  }

  async function pollUntil(consumer: SqsWagerConsumer, wanted: MessageDisposition, timeoutMs = 15_000) {
    const seen: MessageDisposition[] = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      seen.push(...(await consumer.pollOnce()));
      if (seen.includes(wanted)) return seen;
    }
    throw new Error(`timeout waiting for ${wanted}; saw ${seen.join(',')}`);
  }

  async function expectConsistent(walletId: string) {
    expect(await db.ledgerBalance(walletId)).toBe(await db.walletBalance(walletId));
  }

  it('processa, grava inbox e faz ack depois do commit', async () => {
    const { walletId, playerId } = await openWallet();
    const command = wagerCommand(walletId, playerId, { amount: '30.00' });
    const messageId = await sendWagerMessage(sqs, queues.queueUrl, command);

    expect(await pollUntil(testConsumer(sqs, queues, { process: realProcess }), 'acked')).toEqual(['acked']);

    expect(await db.walletBalance(walletId)).toBe('70.00');
    const [inbox] = await db.sql<{ processed_at: Date | null }>('select processed_at from inbox_messages where message_id = ?', [
      messageId,
    ]);
    expect(inbox?.processed_at).not.toBeNull();
    expect(await receiveAll(sqs, queues.queueUrl)).toHaveLength(0);
  });

  it('mesma mensagem entregue duas vezes → um único débito', async () => {
    const { walletId, playerId } = await openWallet();
    const command = wagerCommand(walletId, playerId, { amount: '30.00' });
    const messageId = `msg-${crypto.randomUUID()}`;
    await sendWagerMessage(sqs, queues.queueUrl, command, { messageId });
    await sendWagerMessage(sqs, queues.queueUrl, command, { messageId });

    const consumer = testConsumer(sqs, queues, { process: realProcess });
    const seen: MessageDisposition[] = [];
    while (seen.length < 2) seen.push(...(await consumer.pollOnce()));

    expect(seen).toEqual(['acked', 'acked']);
    expect(await db.walletBalance(walletId)).toBe('70.00');
    expect(await db.ledgerEntries(walletId, 'DEBIT')).toHaveLength(1);
  });

  it('erro de negócio (wallet inexistente) → ack, não vai para a DLQ', async () => {
    await sendWagerMessage(sqs, queues.queueUrl, wagerCommand(crypto.randomUUID(), crypto.randomUUID()));

    expect(await pollUntil(testConsumer(sqs, queues, { process: realProcess }), 'acked')).toEqual(['acked']);
    expect(await receiveAll(sqs, queues.dlqUrl)).toHaveLength(0);
  });

  it('mensagem malformada (permanente) → DLQ imediatamente, com o motivo', async () => {
    await sendRaw(sqs, queues.queueUrl, '{"messageId":"x","type":"WagerTransactionRequested"}');

    expect(await pollUntil(testConsumer(sqs, queues, { process: realProcess }), 'dead-lettered')).toEqual([
      'dead-lettered',
    ]);
    const [dead] = await receiveAll(sqs, queues.dlqUrl, { waitSeconds: 2 });
    expect(dead?.MessageAttributes?.failureCode?.StringValue).toBe('INVALID_MESSAGE');
  });

  it('falha transitória → retry com backoff → DLQ ao atingir o limite de tentativas', async () => {
    const { walletId, playerId } = await openWallet();
    await sendWagerMessage(sqs, queues.queueUrl, wagerCommand(walletId, playerId));
    const alwaysDown = async (): Promise<never> => {
      throw new TransientInfrastructureError('database unavailable');
    };

    const seen = await pollUntil(testConsumer(sqs, queues, { process: alwaysDown }), 'dead-lettered');

    expect(seen).toEqual(['retry', 'retry', 'dead-lettered']); // maxReceiveCount = 3
    const [dead] = await receiveAll(sqs, queues.dlqUrl, { waitSeconds: 2 });
    expect(dead?.MessageAttributes?.failureCode?.StringValue).toBe('RETRIES_EXHAUSTED');
    expect(await db.walletBalance(walletId)).toBe('100.00');
  }, 30_000);

  it('falha transitória que se recupera → processado uma vez na nova entrega', async () => {
    const { walletId, playerId } = await openWallet();
    await sendWagerMessage(sqs, queues.queueUrl, wagerCommand(walletId, playerId, { amount: '10.00' }));
    let calls = 0;
    const flaky = async (command: ProcessWagerTransactionCommand) => {
      if (++calls === 1) throw new TransientInfrastructureError('lock timeout');
      return realProcess(command);
    };

    expect(await pollUntil(testConsumer(sqs, queues, { process: flaky }), 'acked')).toEqual(['retry', 'acked']);
    expect(await db.walletBalance(walletId)).toBe('90.00');
  }, 30_000);

  it('13.5: worker morre depois do commit e antes do ack → redelivery vira replay, um único débito', async () => {
    const { walletId, playerId } = await openWallet();
    const command = wagerCommand(walletId, playerId, { amount: '40.00' });
    const messageId = await sendWagerMessage(sqs, queues.queueUrl, command);

    // "Worker 1": recebe, processa (COMMIT) e morre sem DeleteMessage.
    const [received] = await receiveAll(sqs, queues.queueUrl, { visibilityTimeout: 1 });
    expect(received).toBeDefined();
    const first = await realProcess({ ...command, source: { type: 'sqs', consumerName: 'wager-transactions', messageId } });
    expect(first.idempotentReplay).toBe(false);

    // "Worker 2": a mensagem volta após o visibility timeout.
    let replayed = false;
    const consumer = testConsumer(sqs, queues, {
      process: async (c) => {
        const r = await realProcess(c);
        replayed = r.idempotentReplay;
        return r;
      },
    });
    expect(await pollUntil(consumer, 'acked')).toContain('acked');

    expect(replayed).toBe(true);
    expect(await db.walletBalance(walletId)).toBe('60.00');
    expect(await db.ledgerEntries(walletId, 'DEBIT')).toHaveLength(1);
    await expectConsistent(walletId);
  }, 30_000);

  it('SIGTERM: conclui a mensagem em andamento e devolve as que não começaram', async () => {
    const { walletId, playerId } = await openWallet();
    for (let i = 0; i < 3; i++) {
      await sendWagerMessage(sqs, queues.queueUrl, wagerCommand(walletId, playerId, { amount: '1.00' }));
    }

    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => (started = resolve));
    let processedCount = 0;
    const slow = async (command: ProcessWagerTransactionCommand) => {
      started();
      await Bun.sleep(500);
      const r = await realProcess(command);
      processedCount++;
      return r;
    };

    const consumer = testConsumer(sqs, queues, { process: slow });
    consumer.start();
    await firstStarted;
    await consumer.stop();

    expect(processedCount).toBe(1);
    expect(await db.walletBalance(walletId)).toBe('99.00');
    // Devolvidas com visibility 0: disponíveis já, sem esperar os 30s do visibility timeout.
    const released = await receiveAll(sqs, queues.queueUrl, { waitSeconds: 2 });
    expect(released).toHaveLength(2);
  }, 30_000);

  it('13.8: reinício — instância A para no meio, instância B termina; nada perdido nem duplicado', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    for (let i = 0; i < 6; i++) {
      await sendWagerMessage(sqs, queues.queueUrl, wagerCommand(walletId, playerId, { amount: '5.00' }));
    }

    let processedByA = 0;
    let stopA!: () => void;
    const aStopped = new Promise<void>((resolve) => (stopA = resolve));
    const instanceA = testConsumer(sqs, queues, {
      process: async (c) => {
        const r = await realProcess(c);
        if (++processedByA === 2) stopA();
        return r;
      },
    });
    instanceA.start();
    await aStopped;
    await instanceA.stop();

    const instanceB = testConsumer(sqs, queues, { process: realProcess });
    const deadline = Date.now() + 15_000;
    while ((await db.ledgerEntries(walletId, 'DEBIT')).length < 6 && Date.now() < deadline) await instanceB.pollOnce();

    expect(await db.ledgerEntries(walletId, 'DEBIT')).toHaveLength(6);
    expect(await db.walletBalance(walletId)).toBe('70.00');
    await expectConsistent(walletId);
  }, 30_000);
});
