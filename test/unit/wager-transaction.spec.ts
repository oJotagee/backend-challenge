import { describe, expect, it } from 'bun:test';
import { WagerTransaction } from '@/domain/entities/wager-transaction.entity';
import { FailureCode } from '@/domain/enums/failure-code.enum';
import { LedgerDirection } from '@/domain/enums/ledger-direction.enum';
import { WagerTransactionKind as K } from '@/domain/enums/wager-transaction-kind.enum';
import { WagerTransactionStatus as S } from '@/domain/enums/wager-transaction-status.enum';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '@/domain/errors/domain-error';
import { NOW, WALLET_ID, PLAYER_ID, brl, processed, tx } from './fixtures';

const policy = { baseMs: 1000, maxMs: 60_000 };

describe('WagerTransaction.create', () => {
  it('nasce PENDING', () => {
    expect(tx(K.Bet, '25.00').status).toBe(S.Pending);
  });

  it('OPENING não pode ser submetido de fora', () => {
    expect(() => tx(K.Opening, '10.00')).toThrow(InvalidWagerTransactionError);
  });

  it('providerId "internal" é reservado para transações internas', () => {
    expect(() => tx(K.Bet, '10.00', { providerId: 'internal' })).toThrow(InvalidWagerTransactionError);
  });

  it('REFUND e ROLLBACK exigem referência', () => {
    expect(() => tx(K.Refund, '10.00')).toThrow(InvalidWagerTransactionError);
    expect(() => tx(K.Rollback, '10.00')).toThrow(InvalidWagerTransactionError);
    expect(tx(K.Refund, '10.00', { referenceExternalTransactionId: 'b1' }).requiresReference()).toBe(true);
  });

  it('BET e LOSS não aceitam referência; WIN aceita', () => {
    expect(() => tx(K.Bet, '1.00', { referenceExternalTransactionId: 'x' })).toThrow(InvalidWagerTransactionError);
    expect(() => tx(K.Loss, '0.00', { referenceExternalTransactionId: 'x' })).toThrow(InvalidWagerTransactionError);
    expect(tx(K.Win, '1.00', { referenceExternalTransactionId: 'x' }).referenceExternalTransactionId).toBe('x');
  });

  it('valor zero só é aceito em LOSS', () => {
    expect(() => tx(K.Bet, '0.00')).toThrow(InvalidWagerTransactionError);
    expect(() => tx(K.Win, '0.00')).toThrow(InvalidWagerTransactionError);
    expect(tx(K.Loss, '0.00').affectsBalance()).toBe(false);
  });
});

describe('WagerTransaction transições', () => {
  it('PENDING → PROCESSED guarda referência, saldo observado e data', () => {
    const t = tx(K.Bet, '25.00');
    t.markProcessed('ref-id', brl('75.00'), NOW);

    expect(t.status).toBe(S.Processed);
    expect(t.referenceTransactionId).toBe('ref-id');
    expect(t.balanceAfter?.toString()).toBe('75.00');
    expect(t.processedAt).toEqual(NOW);
    expect(t.isTerminal()).toBe(true);
  });

  it('PENDING → PENDING_REFERENCE → PENDING_REFERENCE agenda com backoff', () => {
    const t = tx(K.Refund, '10.00', { referenceExternalTransactionId: 'b1' });
    t.markPendingReference(NOW, policy);
    expect(t.status).toBe(S.PendingReference);
    expect(t.attempts).toBe(1);
    expect(t.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 1000);

    t.markPendingReference(NOW, policy);
    expect(t.attempts).toBe(2);
    expect(t.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 2000);
    expect(t.isTerminal()).toBe(false);
  });

  it('PENDING_REFERENCE → PROCESSED', () => {
    const t = tx(K.Refund, '10.00', { referenceExternalTransactionId: 'b1' });
    t.markPendingReference(NOW, policy);
    t.markProcessed('b1-id', brl('10.00'), NOW);

    expect(t.status).toBe(S.Processed);
    expect(t.nextAttemptAt).toBeUndefined();
  });

  it('reject e fail guardam failureCode', () => {
    const r = tx(K.Bet, '1.00');
    r.reject(FailureCode.InsufficientFunds, NOW, brl('0.50'));
    expect(r.status).toBe(S.Rejected);
    expect(r.failureCode).toBe(FailureCode.InsufficientFunds);

    const f = tx(K.Bet, '1.00');
    f.fail(FailureCode.PermanentProcessingError, NOW);
    expect(f.status).toBe(S.Failed);
  });

  it.each([
    ['PROCESSED', (t: WagerTransaction) => t.markProcessed(undefined, brl('1.00'), NOW)],
    ['REJECTED', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, NOW)],
    ['FAILED', (t: WagerTransaction) => t.fail(FailureCode.PermanentProcessingError, NOW)],
  ])('%s é terminal: qualquer nova transição lança', (_, toTerminal) => {
    const t = tx(K.Bet, '1.00');
    toTerminal(t);

    expect(() => t.markProcessed(undefined, brl('1.00'), NOW)).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference(NOW, policy)).toThrow(InvalidTransactionStateError);
    expect(() => t.reject(FailureCode.InsufficientFunds, NOW)).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.PermanentProcessingError, NOW)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction consultas', () => {
  it('matchesPayload compara o hash', () => {
    const t = tx(K.Bet, '1.00', { payloadHash: 'b'.repeat(64) });

    expect(t.matchesPayload('b'.repeat(64))).toBe(true);
    expect(t.matchesPayload('c'.repeat(64))).toBe(false);
  });

  it('direção do ledger por kind', () => {
    expect(tx(K.Bet, '1.00').ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(tx(K.Win, '1.00').ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx(K.Refund, '1.00', { referenceExternalTransactionId: 'b' }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(() => tx(K.Loss, '0.00').ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  it('ROLLBACK inverte a direção da referência', () => {
    const rollback = tx(K.Rollback, '1.00', { referenceExternalTransactionId: 'r' });

    expect(rollback.ledgerDirectionFor(processed(K.Bet, '1.00'))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(processed(K.Win, '1.00'))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(processed(K.Refund, '1.00'))).toBe(LedgerDirection.Debit);
  });

  it('opening nasce PROCESSED com chave interna', () => {
    const o = WagerTransaction.opening({ id: 'o1', walletId: WALLET_ID, playerId: PLAYER_ID, money: brl('10.00'), now: NOW });

    expect(o.kind).toBe(K.Opening);
    expect(o.status).toBe(S.Processed);
    expect(o.idempotencyKey).toBe(`internal:opening:${WALLET_ID}`);
  });
});
