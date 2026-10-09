import { describe, expect, it } from 'bun:test';

import { CurrencyMismatchError, InvalidMoneyError } from '@/domain/errors/domain-error';
import { Money } from '@/domain/value-objects/money.vo';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  it('normaliza para escala fixa de 2', () => {
    expect(brl('25').toString()).toBe('25.00');
    expect(brl('25.5').toString()).toBe('25.50');
    expect(brl('0.01').toJSON()).toEqual({ amount: '0.01', currency: 'BRL' });
  });

  it('soma e subtrai sem erro de ponto flutuante', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
    expect(brl('10.00').subtract(brl('25.00')).toString()).toBe('-15.00');
  });

  it('suporta valores acima de Number.MAX_SAFE_INTEGER', () => {
    expect(brl('90071992547409.93').add(brl('0.01')).toString()).toBe('90071992547409.94');
  });

  it.each(['', 'NaN', 'Infinity', '1e3', '-1.00', '1.001', '01.00', ' 1.00', '1.', '.5', 'abc'])(
    'rejeita entrada inválida %p',
    (input) => {
      expect(() => brl(input)).toThrow(InvalidMoneyError);
    },
  );

  it('rejeita operações entre moedas diferentes', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  it('é imutável', () => {
    const a = brl('10.00');
    a.add(brl('5.00'));
    expect(a.toString()).toBe('10.00');
  });

  it('predicados', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.00').negate().isNegative()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
  });

  it('zero negado não vira "-0.00"', () => {
    expect(Money.zero('BRL').negate().toString()).toBe('0.00');
    expect(brl('5.00').subtract(brl('5.00')).negate().toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  it('não perde precisão no limite do numeric(20,2)', () => {
    const max = brl('999999999999999999.99');
    expect(max.subtract(brl('0.01')).toString()).toBe('999999999999999999.98');
    expect(max.add(brl('0.01')).toString()).toBe('1000000000000000000.00');
  });

  it('reidrata valores do banco', () => {
    expect(Money.fromPersistence('975.00', 'BRL').equals(brl('975'))).toBe(true);
  });
});
