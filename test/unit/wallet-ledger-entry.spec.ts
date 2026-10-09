import { describe, expect, it } from 'bun:test';
import { WalletLedgerEntry } from '@/domain/entities/wallet-ledger-entry.entity';
import { LedgerDirection } from '@/domain/enums/ledger-direction.enum';
import { CurrencyMismatchError, InvalidAmountError, UnbalancedLedgerEntryError } from '@/domain/errors/domain-error';
import { Money } from '@/domain/value-objects/money.vo';
import { NOW, brl } from './fixtures';

const base = {
  id: 'e1',
  walletId: 'w1',
  transactionId: 't1',
  createdAt: NOW,
};

describe('WalletLedgerEntry', () => {
  it('aceita lançamento balanceado', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  it('rejeita aritmética errada', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('75.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('rejeita valor zero e saldo negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow(InvalidAmountError);

    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: Money.fromPersistence('-5.00', 'BRL'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('rejeita moedas misturadas', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '1.00', currency: 'USD' }),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('2.00'),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it('é estruturalmente imutável: sem setters nem métodos de transição', () => {
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter((m) => m !== 'constructor');
    expect(methods).toEqual(['isBalanced']);
  });
});
