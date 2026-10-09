import { describe, expect, it } from 'bun:test';
import type { WagerTransaction } from '@/domain/entities/wager-transaction.entity';
import type { Wallet } from '@/domain/entities/wallet.entity';
import { FailureCode as F } from '@/domain/enums/failure-code.enum';
import { LedgerDirection } from '@/domain/enums/ledger-direction.enum';
import { WagerTransactionKind as K } from '@/domain/enums/wager-transaction-kind.enum';
import { WagerTransactionStatus as S } from '@/domain/enums/wager-transaction-status.enum';
import { WagerTransactionProcessor } from '@/domain/services/wager-transaction-processor';
import { Money } from '@/domain/value-objects/money.vo';
import { NOW, id, processed, tx, walletWith } from './fixtures';

const processor = new WagerTransactionProcessor({ baseMs: 1000, maxMs: 60_000, maxAttempts: 3 });

function run(
  transaction: WagerTransaction,
  wallet: Wallet,
  extra: { reference?: WagerTransaction; referenceAlreadyReversed?: boolean } = {},
) {
  return processor.process({
    transaction,
    wallet,
    reference: extra.reference,
    referenceAlreadyReversed: extra.referenceAlreadyReversed ?? false,
    ledgerEntryId: id('e'),
    now: NOW,
  });
}

const reversal = (kind: K.Refund | K.Rollback, amount: string, overrides = {}) =>
  tx(kind, amount, { referenceExternalTransactionId: 'bet-1', ...overrides });

describe('BET', () => {
  it('debita e gera 1 lançamento DEBIT', () => {
    const wallet = walletWith('100.00');
    const bet = tx(K.Bet, '25.00');
    const outcome = run(bet, wallet);

    expect(outcome.type).toBe('processed');
    expect(outcome.type === 'processed' && outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toString()).toBe('75.00');
    expect(bet.status).toBe(S.Processed);
    expect(bet.balanceAfter?.toString()).toBe('75.00');
  });

  it('cenário da seção 8 (sequencial): 100 − 80 ok, segunda de 80 REJECTED, saldo 20', () => {
    const wallet = walletWith('100.00');
    const first = tx(K.Bet, '80.00');
    const second = tx(K.Bet, '80.00');

    expect(run(first, wallet).type).toBe('processed');
    expect(run(second, wallet)).toEqual({ type: 'rejected', code: F.InsufficientFunds });
    expect(wallet.balance.toString()).toBe('20.00');
    expect(second.status).toBe(S.Rejected);
    expect(second.balanceAfter?.toString()).toBe('20.00');
  });
});

describe('WIN', () => {
  it('credita sem referência', () => {
    const wallet = walletWith('10.00');
    expect(run(tx(K.Win, '50.00'), wallet).type).toBe('processed');
    expect(wallet.balance.toString()).toBe('60.00');
  });

  it('referência informada mas ausente não bloqueia o WIN', () => {
    const wallet = walletWith('10.00');
    const win = tx(K.Win, '5.00', { referenceExternalTransactionId: 'not-yet' });

    expect(run(win, wallet).type).toBe('processed');
  });

  it('referência presente precisa ser BET da mesma rodada', () => {
    const win = tx(K.Win, '5.00', { referenceExternalTransactionId: 'b' });
    const otherRound = processed(K.Bet, '5.00');
    Object.defineProperty(otherRound, 'roundId', { value: 'round-x' });

    expect(run(win, walletWith('10.00'), { reference: otherRound })).toEqual({ type: 'rejected', code: F.ReferenceMismatch });
  });
});

describe('LOSS', () => {
  it('processa sem mover saldo e sem lançamento', () => {
    const wallet = walletWith('10.00');
    const loss = tx(K.Loss, '0.00');
    const outcome = run(loss, wallet);

    expect(outcome).toEqual({ type: 'processed' });
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
    expect(loss.balanceAfter?.toString()).toBe('10.00');
  });
});

describe('REFUND', () => {
  it('credita o valor da BET referenciada', () => {
    const wallet = walletWith('75.00');
    const refund = reversal(K.Refund, '25.00');
    const outcome = run(refund, wallet, { reference: processed(K.Bet, '25.00') });

    expect(outcome.type).toBe('processed');
    expect(wallet.balance.toString()).toBe('100.00');
    expect(refund.referenceTransactionId).toBeDefined();
  });

  it('só referencia BET', () => {
    expect(run(reversal(K.Refund, '5.00'), walletWith('10.00'), { reference: processed(K.Win, '5.00') })).toEqual({
      type: 'rejected',
      code: F.ReferenceKindNotAllowed,
    });
  });

  it('valor tem que ser igual ao da referência', () => {
    expect(run(reversal(K.Refund, '5.00'), walletWith('10.00'), { reference: processed(K.Bet, '25.00') })).toEqual({
      type: 'rejected',
      code: F.ReversalAmountMismatch,
    });
  });

  it('não reverte duas vezes', () => {
    expect(
      run(reversal(K.Refund, '25.00'), walletWith('10.00'), {
        reference: processed(K.Bet, '25.00'),
        referenceAlreadyReversed: true,
      }),
    ).toEqual({ type: 'rejected', code: F.ReferenceAlreadyReversed });
  });

  it('referência REJECTED não pode ser revertida', () => {
    const rejectedBet = tx(K.Bet, '25.00');
    rejectedBet.reject(F.InsufficientFunds, NOW);

    expect(run(reversal(K.Refund, '25.00'), walletWith('10.00'), { reference: rejectedBet })).toEqual({
      type: 'rejected',
      code: F.ReferenceNotProcessed,
    });
  });

  it('referência de outro player é mismatch', () => {
    const bet = processed(K.Bet, '25.00');
    Object.defineProperty(bet, 'playerId', { value: 'someone-else' });

    expect(run(reversal(K.Refund, '25.00'), walletWith('10.00'), { reference: bet })).toEqual({
      type: 'rejected',
      code: F.ReferenceMismatch,
    });
  });
});

describe('ROLLBACK', () => {
  it('de BET credita', () => {
    const wallet = walletWith('75.00');
    run(reversal(K.Rollback, '25.00'), wallet, { reference: processed(K.Bet, '25.00') });
    expect(wallet.balance.toString()).toBe('100.00');
  });

  it('de WIN debita', () => {
    const wallet = walletWith('150.00');
    const outcome = run(reversal(K.Rollback, '50.00'), wallet, { reference: processed(K.Win, '50.00') });

    expect(outcome.type === 'processed' && outcome.entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toString()).toBe('100.00');
  });

  it('de WIN já gasto: REVERSAL_INSUFFICIENT_FUNDS, distinto de aposta sem saldo (regra 7.9)', () => {
    const wallet = walletWith('10.00');
    const rollback = reversal(K.Rollback, '50.00');

    expect(run(rollback, wallet, { reference: processed(K.Win, '50.00') })).toEqual({
      type: 'rejected',
      code: F.ReversalInsufficientFunds,
    });
    expect(wallet.balance.toString()).toBe('10.00');
    expect(rollback.status).toBe(S.Rejected);
  });

  it('não referencia LOSS', () => {
    expect(run(reversal(K.Rollback, '1.00'), walletWith('10.00'), { reference: processed(K.Loss, '1.00') })).toEqual({
      type: 'rejected',
      code: F.ReferenceKindNotAllowed,
    });
  });
});

describe('referência fora de ordem (7.1)', () => {
  it('sem referência → PENDING_REFERENCE com backoff', () => {
    const refund = reversal(K.Refund, '25.00');
    expect(run(refund, walletWith('10.00'))).toEqual({ type: 'pending_reference' });
    expect(refund.status).toBe(S.PendingReference);
    expect(refund.attempts).toBe(1);
  });

  it('esgotado o limite → REJECTED com REFERENCE_NOT_FOUND', () => {
    const refund = reversal(K.Refund, '25.00');
    const wallet = walletWith('10.00');

    expect(run(refund, wallet).type).toBe('pending_reference');
    expect(run(refund, wallet).type).toBe('pending_reference');
    expect(run(refund, wallet)).toEqual({ type: 'rejected', code: F.ReferenceNotFound });
  });

  it('referência ainda PENDING → espera', () => {
    const inFlightBet = tx(K.Bet, '25.00');
    expect(run(reversal(K.Refund, '25.00'), walletWith('10.00'), { reference: inFlightBet })).toEqual({
      type: 'pending_reference',
    });
  });
});

describe('wallet', () => {
  it('conflito de moeda → CURRENCY_MISMATCH, sem mexer no saldo', () => {
    const wallet = walletWith('100.00', 'USD');
    expect(run(tx(K.Bet, '1.00'), wallet)).toEqual({ type: 'rejected', code: F.CurrencyMismatch });
    expect(wallet.balance.equals(Money.fromPersistence('100.00', 'USD'))).toBe(true);
  });

  it('player diferente do dono da wallet → WALLET_PLAYER_MISMATCH', () => {
    expect(run(tx(K.Bet, '1.00', { playerId: 'intruder' }), walletWith('100.00'))).toEqual({
      type: 'rejected',
      code: F.WalletPlayerMismatch,
    });
  });
});
