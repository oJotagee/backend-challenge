import { describe, expect, it } from 'bun:test';
import { Wallet } from '@/domain/entities/wallet.entity';
import { FailureCode } from '@/domain/enums/failure-code.enum';
import { LedgerDirection } from '@/domain/enums/ledger-direction.enum';
import { BusinessRuleViolationError, InvalidAmountError } from '@/domain/errors/domain-error';
import { Money } from '@/domain/value-objects/money.vo';
import { NOW, PLAYER_ID, WALLET_ID, brl, id, walletWith } from './fixtures';

const move = (amount: string) => ({ entryId: id('e'), transactionId: id('tx'), money: brl(amount), at: NOW });

describe('Wallet.open', () => {
  it('abre com version 1 e lançamento OPENING quando saldo > 0', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: brl('1000.00'),
      openingTransactionId: 'tx-open',
      openingEntryId: 'e-open',
      now: NOW,
    });

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
  });

  it('saldo inicial zero não gera lançamento', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: brl('0.00'),
      openingTransactionId: 'tx-open',
      openingEntryId: 'e-open',
      now: NOW,
    });

    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  it('rejeita saldo inicial negativo', () => {
    expect(() =>
      Wallet.open({
        id: WALLET_ID,
        playerId: PLAYER_ID,
        initialBalance: Money.fromPersistence('-1.00', 'BRL'),
        openingTransactionId: 'tx-open',
        openingEntryId: 'e-open',
        now: NOW,
      }),
    ).toThrow(InvalidAmountError);
  });
});

describe('Wallet debit/credit', () => {
  it('debita, gera lançamento consistente e incrementa a version', () => {
    const wallet = walletWith('100.00');
    const entry = wallet.debit(move('80.00'));

    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('20.00');
    expect(entry.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  it('credita e incrementa a version', () => {
    const wallet = walletWith('20.00');
    wallet.credit(move('5.50'));

    expect(wallet.balance.toString()).toBe('25.50');
    expect(wallet.version).toBe(2);
  });

  it('pode zerar o saldo exatamente', () => {
    const wallet = walletWith('80.00');
    wallet.debit(move('80.00'));

    expect(wallet.balance.isZero()).toBe(true);
  });

  it('nunca fica negativa: rejeita com INSUFFICIENT_FUNDS e não muda estado', () => {
    const wallet = walletWith('20.00');

    try {
      wallet.debit(move('80.00'));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessRuleViolationError);
      expect((error as BusinessRuleViolationError).code).toBe(FailureCode.InsufficientFunds);
    }
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(1);
  });

  it('usa o código de reversão quando pedido (regra 7.9)', () => {
    const wallet = walletWith('10.00');

    expect(() =>
      wallet.debit({ ...move('50.00'), insufficientFundsCode: FailureCode.ReversalInsufficientFunds }),
    ).toThrow(expect.objectContaining({ code: FailureCode.ReversalInsufficientFunds }));
  });

  it('rejeita moeda diferente da wallet', () => {
    const wallet = walletWith('100.00');
    const usd = { ...move('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };

    expect(() => wallet.credit(usd)).toThrow(expect.objectContaining({ code: FailureCode.CurrencyMismatch }));
    expect(wallet.version).toBe(1);
  });

  it('rejeita movimento zero', () => {
    expect(() => walletWith('100.00').credit(move('0.00'))).toThrow(InvalidAmountError);
  });

  it('version só incrementa quando o saldo muda', () => {
    const wallet = walletWith('100.00');
    expect(() => wallet.debit(move('500.00'))).toThrow();
    wallet.credit(move('1.00'));
    wallet.debit(move('1.00'));

    expect(wallet.version).toBe(3);
  });
});
