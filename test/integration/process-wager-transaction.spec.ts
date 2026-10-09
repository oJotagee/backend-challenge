import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';

import { IdempotencyConflictError, WalletNotFoundError } from '@/application/errors/application-errors';
import type { TransactionRunner } from '@/application/ports/transaction-runner.port';
import { SystemClock } from '@/application/ports/clock.port';
import { UuidV7Generator } from '@/application/ports/id-generator.port';
import { ProcessWagerTransactionUseCase } from '@/application/use-cases/process-wager-transaction.use-case';
import { WagerTransactionStatus as S } from '@/domain/enums/wager-transaction-status.enum';
import { WagerTransactionProcessor } from '@/domain/services/wager-transaction-processor';

import { buildUseCases, createTestOrm, dbQueries, wagerCommand } from '../support/database';

describe('ProcessWagerTransaction (PostgreSQL real)', () => {
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

  async function openWallet(amount = '100.00') {
    const playerId = crypto.randomUUID();
    const wallet = await uc.openWallet.execute({ playerId, initialBalance: { amount, currency: 'BRL' }, correlationId: 't' });
    return { walletId: wallet.id, playerId };
  }

  describe('abertura de wallet', () => {
    it('grava wallet + OPENING + lançamento CREDIT + evento na mesma transação', async () => {
      const { walletId } = await openWallet('1000.00');

      expect(await db.walletBalance(walletId)).toBe('1000.00');
      const [opening] = await db.sql<{ kind: string; status: string }>(
        'select kind, status from wager_transactions where wallet_id = ?',
        [walletId],
      );
      expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED' });
      expect(await db.ledgerEntries(walletId, 'CREDIT')).toHaveLength(1);
      expect(await db.ledgerBalance(walletId)).toBe('1000.00');
    });

    it('saldo inicial zero não gera OPENING nem lançamento', async () => {
      const { walletId } = await openWallet('0.00');

      expect(await db.ledgerEntries(walletId)).toHaveLength(0);
      expect(await db.walletBalance(walletId)).toBe('0.00');
    });
  });

  describe('idempotência', () => {
    it('requisição idêntica → mesma resposta com idempotentReplay: true', async () => {
      const { walletId, playerId } = await openWallet();
      const command = wagerCommand(walletId, playerId, { amount: '25.00' });

      const first = await uc.processWager.execute(command);
      await uc.processWager.execute(wagerCommand(walletId, playerId, { amount: '10.00' }));
      const replay = await uc.processWager.execute(command);

      expect(first.idempotentReplay).toBe(false);
      expect(replay).toEqual({ ...first, idempotentReplay: true });
      expect(replay.balance).toEqual({ amount: '75.00', currency: 'BRL' });
      expect(await db.walletBalance(walletId)).toBe('65.00');
    });

    it('mesma key com payload diferente → conflito, sem efeito no saldo', async () => {
      const { walletId, playerId } = await openWallet();
      const command = wagerCommand(walletId, playerId, { amount: '25.00' });
      await uc.processWager.execute(command);

      const divergent = { ...command, data: { ...command.data, money: { amount: '26.00', currency: 'BRL' } } };

      await expect(uc.processWager.execute(divergent)).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(await db.walletBalance(walletId)).toBe('75.00');
    });

    it('mesmo externalTransactionId com outra key → conflito', async () => {
      const { walletId, playerId } = await openWallet();
      const command = wagerCommand(walletId, playerId);
      await uc.processWager.execute(command);

      await expect(uc.processWager.execute({ ...command, idempotencyKey: 'outra-key' })).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
    });

    it('rejeição também é idempotente: o replay devolve o mesmo REJECTED', async () => {
      const { walletId, playerId } = await openWallet('10.00');
      const command = wagerCommand(walletId, playerId, { amount: '50.00' });

      const first = await uc.processWager.execute(command);
      await uc.processWager.execute(wagerCommand(walletId, playerId, { kind: 'WIN', amount: '100.00' }));
      const replay = await uc.processWager.execute(command);

      expect(first.status).toBe(S.Rejected);
      expect(replay).toEqual({ ...first, idempotentReplay: true });
    });
  });

  describe('inbox (entrada pela fila)', () => {
    it('mesma mensagem entregue duas vezes → processa uma vez, segunda é replay', async () => {
      const { walletId, playerId } = await openWallet();
      const command = wagerCommand(walletId, playerId, { amount: '30.00', messageId: `msg-${crypto.randomUUID()}` });

      const first = await uc.processWager.execute(command);
      const redelivery = await uc.processWager.execute(command);

      expect(first.idempotentReplay).toBe(false);
      expect(redelivery.idempotentReplay).toBe(true);
      expect(await db.walletBalance(walletId)).toBe('70.00');
      const [inbox] = await db.sql<{ processed_at: Date | null }>(
        'select processed_at from inbox_messages where message_id = ?',
        [command.source.type === 'sqs' ? command.source.messageId : ''],
      );
      expect(inbox?.processed_at).not.toBeNull();
    });
  });

  describe('referência fora de ordem', () => {
    it('REFUND antes da BET fica PENDING_REFERENCE e não mexe no saldo', async () => {
      const { walletId, playerId } = await openWallet();
      const betId = `bet-${crypto.randomUUID()}`;

      const refund = await uc.processWager.execute(
        wagerCommand(walletId, playerId, { kind: 'REFUND', amount: '20.00', referenceExternalTransactionId: betId }),
      );

      expect(refund.status).toBe(S.PendingReference);
      expect(refund.balance).toBeUndefined();
      expect(await db.walletBalance(walletId)).toBe('100.00');
      expect(await db.countOutbox('WagerTransactionPendingReference')).toBeGreaterThan(0);
    });

    it('REFUND depois da BET credita, e um segundo REFUND da mesma BET é rejeitado', async () => {
      const { walletId, playerId } = await openWallet();
      const betId = `bet-${crypto.randomUUID()}`;
      await uc.processWager.execute(wagerCommand(walletId, playerId, { amount: '20.00', externalTransactionId: betId }));

      const refund = (n: string) =>
        uc.processWager.execute(
          wagerCommand(walletId, playerId, {
            kind: 'REFUND',
            amount: '20.00',
            referenceExternalTransactionId: betId,
            externalTransactionId: `refund-${n}-${betId}`,
          }),
        );

      expect((await refund('1')).status).toBe(S.Processed);
      expect(await refund('2')).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });
      expect(await db.walletBalance(walletId)).toBe('100.00');
      expect(await db.ledgerBalance(walletId)).toBe('100.00');
    });
  });

  describe('falhas', () => {
    it('wallet inexistente → WalletNotFoundError, nada gravado', async () => {
      const before = await db.countOutbox();
      await expect(uc.processWager.execute(wagerCommand(crypto.randomUUID(), crypto.randomUUID()))).rejects.toBeInstanceOf(
        WalletNotFoundError,
      );
      expect(await db.countOutbox()).toBe(before);
    });

    it('atomicidade: erro antes do COMMIT desfaz transação, saldo, ledger, inbox e outbox', async () => {
      const { walletId, playerId } = await openWallet();
      const outboxBefore = await db.countOutbox();

      const crashingRunner: TransactionRunner = {
        run: (work) =>
          uc.runner.run(async (repos) => {
            await work(repos);
            throw new Error('process died before commit');
          }),
      };
      const crashing = new ProcessWagerTransactionUseCase(
        crashingRunner,
        new WagerTransactionProcessor({ baseMs: 1000, maxMs: 60_000, maxAttempts: 8 }),
        new SystemClock(),
        new UuidV7Generator(),
      );
      const messageId = `msg-${crypto.randomUUID()}`;
      const command = wagerCommand(walletId, playerId, { amount: '40.00', messageId });

      await expect(crashing.execute(command)).rejects.toThrow('process died before commit');

      expect(await db.walletBalance(walletId)).toBe('100.00');
      expect(await db.ledgerEntries(walletId, 'DEBIT')).toHaveLength(0);
      expect(await db.countOutbox()).toBe(outboxBefore);
      expect(await db.sql('select 1 from inbox_messages where message_id = ?', [messageId])).toHaveLength(0);
      expect(
        await db.sql('select 1 from wager_transactions where external_transaction_id = ?', [
          command.data.externalTransactionId,
        ]),
      ).toHaveLength(0);

      expect((await uc.processWager.execute(command)).status).toBe(S.Processed);
      expect(await db.walletBalance(walletId)).toBe('60.00');
    });
  });
});
