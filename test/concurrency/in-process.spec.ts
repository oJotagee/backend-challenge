import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';

import { buildUseCases, createTestOrm, dbQueries, wagerCommand } from '../support/database';

describe('concorrência (uma instância, transações paralelas)', () => {
  let orm: MikroORM;
  let uc: ReturnType<typeof buildUseCases>;
  let db: ReturnType<typeof dbQueries>;

  beforeAll(async () => {
    orm = await createTestOrm();
    uc = buildUseCases(orm);
    db = dbQueries(orm);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  async function openWallet(amount: string) {
    const playerId = crypto.randomUUID();
    const wallet = await uc.openWallet.execute({
      playerId,
      initialBalance: { amount, currency: 'BRL' },
      correlationId: 'test',
    });
    return { walletId: wallet.id, playerId };
  }

  async function expectLedgerConsistent(walletId: string) {
    expect(await db.ledgerBalance(walletId)).toBe(await db.walletBalance(walletId));
  }

  it('seção 8: saldo 100, duas apostas de 80 simultâneas → uma PROCESSED, outra REJECTED, saldo 20', async () => {
    const { walletId, playerId } = await openWallet('100.00');

    const results = await Promise.all([
      uc.processWager.execute(wagerCommand(walletId, playerId, { amount: '80.00' })),
      uc.processWager.execute(wagerCommand(walletId, playerId, { amount: '80.00' })),
    ]);

    const statuses = results.map((r): string => r.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.status === 'REJECTED')?.failureCode as string).toBe('INSUFFICIENT_FUNDS');
    expect(await db.walletBalance(walletId)).toBe('20.00');
    expect(await db.ledgerEntries(walletId, 'DEBIT')).toHaveLength(1);
    await expectLedgerConsistent(walletId);
  });

  it('a mesma aposta 50 vezes em paralelo → um único débito, 49 replays', async () => {
    const { walletId, playerId } = await openWallet('100.00');
    const command = wagerCommand(walletId, playerId, { amount: '25.00' });

    const results = await Promise.all(Array.from({ length: 50 }, () => uc.processWager.execute(command)));

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(results.every((r) => r.status === 'PROCESSED' && r.balance?.amount === '75.00')).toBe(true);
    expect(await db.walletBalance(walletId)).toBe('75.00');
    expect(await db.ledgerEntries(walletId, 'DEBIT')).toHaveLength(1);
    await expectLedgerConsistent(walletId);
  });

  it('hot wallet: 40 apostas diferentes de 5.00 sobre 100.00 → exatamente 20 aceitas, saldo 0', async () => {
    const { walletId, playerId } = await openWallet('100.00');

    const results = await Promise.all(
      Array.from({ length: 40 }, () => uc.processWager.execute(wagerCommand(walletId, playerId, { amount: '5.00' }))),
    );

    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(20);
    expect(results.filter((r) => r.status === 'REJECTED')).toHaveLength(20);
    expect(await db.walletBalance(walletId)).toBe('0.00');
    expect(await db.ledgerEntries(walletId, 'DEBIT')).toHaveLength(20);
    await expectLedgerConsistent(walletId);
  });

  it('wallets distintas em paralelo não interferem entre si', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet('50.00')));

    await Promise.all(
      wallets.flatMap(({ walletId, playerId }) => [
        uc.processWager.execute(wagerCommand(walletId, playerId, { kind: 'BET', amount: '20.00' })),
        uc.processWager.execute(wagerCommand(walletId, playerId, { kind: 'WIN', amount: '5.00' })),
        uc.processWager.execute(wagerCommand(walletId, playerId, { kind: 'BET', amount: '10.00' })),
      ]),
    );

    for (const { walletId } of wallets) {
      expect(await db.walletBalance(walletId)).toBe('25.00');
      await expectLedgerConsistent(walletId);
    }
  });

  it('duas wallets para o mesmo player + moeda em paralelo → uma só é criada', async () => {
    const playerId = crypto.randomUUID();
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        uc.openWallet.execute({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' }, correlationId: 't' }),
      ),
    );

    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const errors = attempts.filter((a): a is PromiseRejectedResult => a.status === 'rejected');
    expect(errors.every((e) => (e.reason as { code: string }).code === 'WALLET_ALREADY_EXISTS')).toBe(true);
  });
});
