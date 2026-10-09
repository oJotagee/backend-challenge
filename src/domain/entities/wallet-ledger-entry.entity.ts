import { LedgerDirection } from '../enums/ledger-direction.enum';
import { InvalidAmountError, UnbalancedLedgerEntryError } from '../errors/domain-error';
import { Money } from '../value-objects/money.vo';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento do ledger. Imutável por ESTRUTURA: todos os campos são readonly e não existe
 * nenhum método que altere estado. A aritmética é verificada na criação.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.build(props);

    if (!entry.money.isPositive()) {
      throw new InvalidAmountError(`Ledger amount must be positive, got ${entry.money.toString()}`);
    }

    if (entry.balanceBefore.isNegative() || entry.balanceAfter.isNegative()) {
      throw new UnbalancedLedgerEntryError('balances cannot be negative');
    }

    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `${entry.balanceBefore.toString()} ${entry.direction} ${entry.money.toString()} != ${entry.balanceAfter.toString()}`,
      );
    }

    return entry;
  }

  /** Reconstrói a partir do banco. Não revalida: o que está persistido já passou pelas constraints. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  /** balanceBefore ± money === balanceAfter. Também lança se as moedas forem diferentes. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expected.equals(this.balanceAfter);
  }

  private static build(p: CreateLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      p.id,
      p.walletId,
      p.transactionId,
      p.direction,
      p.money,
      p.balanceBefore,
      p.balanceAfter,
      p.createdAt,
    );
  }
}
