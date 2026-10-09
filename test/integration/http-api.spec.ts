import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';

import { createTestOrm, dbQueries } from '../support/database';

describe('API HTTP (Nest + PostgreSQL reais)', () => {
  let orm: MikroORM;
  let app: INestApplication;
  let db: ReturnType<typeof dbQueries>;
  let base: string;

  beforeAll(async () => {
    orm = await createTestOrm();
    db = dbQueries(orm);

    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'silent';
    process.env.WORKERS_ENABLED = 'false';
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('@/app.module');

    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0);
    base = (await app.getUrl()).replace('[::1]', 'localhost');
  });

  afterAll(async () => {
    await app?.close();
    await orm.close(true);
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const get = (path: string) => fetch(`${base}${path}`);

  async function createWallet(amount = '100.00') {
    const playerId = crypto.randomUUID();
    const res = await post('/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
    expect(res.status).toBe(201);
    const wallet = (await res.json()) as { id: string };
    return { walletId: wallet.id, playerId };
  }

  let ext = 0;
  function wager(walletId: string, playerId: string, extra: Record<string, unknown> = {}) {
    const externalTransactionId = `http-${Date.now()}-${++ext}`;
    const body = {
      providerId: 'provider-a',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...extra,
    };
    return { body, headers: { 'Idempotency-Key': `provider-a:${externalTransactionId}` } };
  }

  describe('POST /wallets', () => {
    it('201 com saldo e version 1', async () => {
      const playerId = crypto.randomUUID();
      const res = await post('/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    });

    it('409 para wallet duplicada (mesmo player + moeda)', async () => {
      const playerId = crypto.randomUUID();
      const body = { playerId, initialBalance: { amount: '1.00', currency: 'BRL' } };
      await post('/wallets', body);

      const res = await post('/wallets', body);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: 'WALLET_ALREADY_EXISTS' } });
    });

    it.each([
      ['notação científica', { amount: '1e3', currency: 'BRL' }],
      ['mais de 2 casas', { amount: '1.001', currency: 'BRL' }],
      ['negativo', { amount: '-1.00', currency: 'BRL' }],
      ['número em vez de string', { amount: 10, currency: 'BRL' }],
    ])('400 para valor inválido: %s', async (_, initialBalance) => {
      const res = await post('/wallets', { playerId: crypto.randomUUID(), initialBalance });
      expect(res.status).toBe(400);
    });

    it('400 para campo desconhecido no payload', async () => {
      const res = await post('/wallets', {
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '1.00', currency: 'BRL' },
        balance: '999.00',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /wallets/:id', () => {
    it('200, 404 e 400', async () => {
      const { walletId } = await createWallet('42.00');

      expect(await (await get(`/wallets/${walletId}`)).json()).toMatchObject({ balance: { amount: '42.00' } });
      expect((await get(`/wallets/${crypto.randomUUID()}`)).status).toBe(404);
      expect((await get('/wallets/not-a-uuid')).status).toBe(400);
    });
  });

  describe('POST /wagering/transactions', () => {
    it('400 sem Idempotency-Key', async () => {
      const { walletId, playerId } = await createWallet();
      const { body } = wager(walletId, playerId);

      const res = await post('/wagering/transactions', body);
      expect(res.status).toBe(400);
    });

    it('201 na primeira vez, 200 com idempotentReplay no replay', async () => {
      const { walletId, playerId } = await createWallet();
      const { body, headers } = wager(walletId, playerId);

      const first = await post('/wagering/transactions', body, headers);
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as Record<string, unknown>;
      expect(firstBody).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00' }, idempotentReplay: false });

      const replay = await post('/wagering/transactions', body, headers);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ...firstBody, idempotentReplay: true });
    });

    it('409 para a mesma key com payload diferente', async () => {
      const { walletId, playerId } = await createWallet();
      const { body, headers } = wager(walletId, playerId);
      await post('/wagering/transactions', body, headers);

      const res = await post('/wagering/transactions', { ...body, money: { amount: '26.00', currency: 'BRL' } }, headers);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_CONFLICT' } });
    });

    it('422 com failureCode para rejeição de negócio', async () => {
      const { walletId, playerId } = await createWallet('10.00');
      const { body, headers } = wager(walletId, playerId);

      const res = await post('/wagering/transactions', body, headers);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    });

    it('202 para REFUND cuja BET ainda não chegou', async () => {
      const { walletId, playerId } = await createWallet();
      const { body, headers } = wager(walletId, playerId, {
        kind: 'REFUND',
        referenceExternalTransactionId: 'bet-que-ainda-nao-chegou',
      });

      const res = await post('/wagering/transactions', body, headers);
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ status: 'PENDING_REFERENCE' });
    });

    it('404 para wallet inexistente; 400 para OPENING', async () => {
      const unknown = wager(crypto.randomUUID(), crypto.randomUUID());
      expect((await post('/wagering/transactions', unknown.body, unknown.headers)).status).toBe(404);

      const { walletId, playerId } = await createWallet();
      const opening = wager(walletId, playerId, { kind: 'OPENING' });
      expect((await post('/wagering/transactions', opening.body, opening.headers)).status).toBe(400);
    });
  });

  describe('consultas de transação', () => {
    it('por id interno e por (provider, externalId)', async () => {
      const { walletId, playerId } = await createWallet();
      const { body, headers } = wager(walletId, playerId);
      const { transactionId } = (await (await post('/wagering/transactions', body, headers)).json()) as {
        transactionId: string;
      };

      const byId = await (await get(`/wagering/transactions/${transactionId}`)).json();
      const byExternal = await (
        await get(`/providers/provider-a/wagering/transactions/${body.externalTransactionId}`)
      ).json();

      expect(byId).toEqual(byExternal);
      expect(byId).toMatchObject({ id: transactionId, kind: 'BET', status: 'PROCESSED', money: { amount: '25.00' } });
      expect((await get(`/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
    });
  });

  describe('GET /wallets/:id/ledger', () => {
    it('pagina com cursor estável sem repetir nem pular lançamentos', async () => {
      const { walletId, playerId } = await createWallet('100.00');
      for (let i = 0; i < 4; i++) {
        const { body, headers } = wager(walletId, playerId, { money: { amount: '1.00', currency: 'BRL' } });
        await post('/wagering/transactions', body, headers);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await get(`/wallets/${walletId}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        const page = (await res.json()) as { items: { id: string }[]; nextCursor: string | null };
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        pages++;
      } while (cursor);

      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(5);
    });

    it('400 para cursor inválido', async () => {
      const { walletId } = await createWallet();
      expect((await get(`/wallets/${walletId}/ledger?cursor=lixo`)).status).toBe(400);
    });
  });

  describe('POST /wallets/:id/reconciliation', () => {
    it('consistente após operações', async () => {
      const { walletId, playerId } = await createWallet('100.00');
      const { body, headers } = wager(walletId, playerId);
      await post('/wagering/transactions', body, headers);

      const res = await post(`/wallets/${walletId}/reconciliation`, {});
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        walletId,
        storedBalance: { amount: '75.00', currency: 'BRL' },
        calculatedBalance: { amount: '75.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 2,
      });
    });

    it('sinaliza divergência sem corrigir', async () => {
      const { walletId } = await createWallet('100.00');
      await db.sql('update wallets set balance = 130 where id = ?', [walletId]);

      const result = await (await post(`/wallets/${walletId}/reconciliation`, {})).json();
      expect(result).toMatchObject({ consistent: false, difference: { amount: '30.00' } });
      expect(await db.walletBalance(walletId)).toBe('130.00');
    });
  });

  it('GET /health/live sem autenticação', async () => {
    expect((await get('/health/live')).status).toBe(200);
  });

  it('GET /health/ready verifica PostgreSQL e SQS', async () => {
    const res = await get('/health/ready');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', checks: { postgres: true, sqs: true } });
  });

  describe('GET /metrics', () => {
    const metricValue = (text: string, line: string) => {
      const found = text.split('\n').find((l) => l.startsWith(line));
      return found ? Number(found.split(' ').pop()) : 0;
    };

    it('conta transações por status, duplicatas e latência', async () => {
      const before = await (await get('/metrics')).text();
      const { walletId, playerId } = await createWallet('10.00');
      const ok = wager(walletId, playerId, { money: { amount: '5.00', currency: 'BRL' } });
      await post('/wagering/transactions', ok.body, ok.headers);
      await post('/wagering/transactions', ok.body, ok.headers);
      const broke = wager(walletId, playerId, { money: { amount: '50.00', currency: 'BRL' } });
      await post('/wagering/transactions', broke.body, broke.headers);

      const after = await (await get('/metrics')).text();
      const delta = (line: string) => metricValue(after, line) - metricValue(before, line);

      expect(delta('wager_transactions_total{kind="BET",status="PROCESSED",failure_code=""}')).toBe(1);
      expect(delta('wager_transactions_total{kind="BET",status="REJECTED",failure_code="INSUFFICIENT_FUNDS"}')).toBe(1);
      expect(delta('wager_duplicates_total{source="http"}')).toBe(1);
      expect(delta('wager_processing_duration_seconds_count{source="http"}')).toBe(3);
      expect(after).toContain('outbox_lag_seconds');
      expect(after).toContain('wager_dlq_messages_total');
      expect(after).toContain('wager_lock_conflicts_total');
    });
  });
});
