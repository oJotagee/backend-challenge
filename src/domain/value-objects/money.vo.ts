import Decimal from 'decimal.js';

import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain-error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const SIGNED_AMOUNT_PATTERN = /^-?(0|[1-9]\d*)(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

/**
 * Valor monetário exato. Internamente usa `Decimal` (decimal.js, base 10, sem ponto flutuante);
 * na borda é sempre string decimal com escala fixa de 2.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /**
   * Contrato de entrada: rejeita negativos, NaN, Infinity, notação científica e > 2 casas.
   * A validação é por regex ANTES do Decimal, porque o Decimal aceitaria "1e3" e "Infinity".
   */
  static from(props: MoneyProps): Money {
    if (!AMOUNT_PATTERN.test(props.amount)) throw new InvalidMoneyError(props.amount);

    return new Money(new MoneyDecimal(props.amount), Money.assertCurrency(props.currency));
  }

  /** Reidratação a partir do banco (numeric(20,2)), aceita sinal. */
  static fromPersistence(amount: string, currency: string): Money {
    if (!SIGNED_AMOUNT_PATTERN.test(amount)) throw new InvalidMoneyError(amount);

    return new Money(new MoneyDecimal(amount), Money.assertCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(new MoneyDecimal(0), Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Sempre 2 casas. Zero nunca sai como "-0.00" (o Decimal distingue -0 de 0). */
  toString(): string {
    return this.value.isZero() ? (0).toFixed(SCALE) : this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }

  private static assertCurrency(currency: string): string {
    if (!CURRENCY_PATTERN.test(currency)) throw new InvalidMoneyError(`currency ${currency}`);

    return currency;
  }
}
