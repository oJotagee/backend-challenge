import { FailureCode } from '../enums/failure-code.enum';
import { LedgerDirection } from '../enums/ledger-direction.enum';
import { BusinessRuleViolationError, InvalidAmountError } from '../errors/domain-error';
import { Money } from '../value-objects/money.vo';
import { WalletLedgerEntry } from './wallet-ledger-entry.entity';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingEntryId: string;
  now: Date;
}

export interface BalanceMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export interface DebitMovement extends BalanceMovement {
  insufficientFundsCode?: FailureCode.InsufficientFunds | FailureCode.ReversalInsufficientFunds;
}

/**
 * Aggregate root. O saldo só muda por `debit`/`credit`, e cada um devolve o lançamento
 * correspondente: é impossível mudar o saldo sem produzir o ledger (e vice-versa).
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já com o saldo inicial e version = 1.
   * Se o saldo inicial for > 0, devolve também o lançamento CREDIT da transação OPENING.
   */
  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    const { initialBalance, now } = props;

    if (initialBalance.isNegative()) {
      throw new InvalidAmountError(`Initial balance cannot be negative, got ${initialBalance.toString()}`);
    }

    const wallet = new Wallet(props.id, props.playerId, initialBalance.currency, initialBalance, 1, now, now);
    if (initialBalance.isZero()) return { wallet };

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: now,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);

    return !this._balance.isLessThan(money);
  }

  debit(movement: DebitMovement): WalletLedgerEntry {
    this.assertMovement(movement);

    if (!this.canDebit(movement.money)) {
      const code = movement.insufficientFundsCode ?? FailureCode.InsufficientFunds;

      throw new BusinessRuleViolationError(
        code,
        `Wallet ${this.id} has ${this._balance.toString()}, cannot debit ${movement.money.toString()}`,
      );
    }

    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: BalanceMovement): WalletLedgerEntry {
    this.assertMovement(movement);

    return this.apply(LedgerDirection.Credit, movement);
  }

  /** Único ponto que altera o saldo: calcula, cria o lançamento (que valida a aritmética) e só então muta. */
  private apply(direction: LedgerDirection, movement: BalanceMovement): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(movement.money) : before.subtract(movement.money);

    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: movement.at,
    });

    this._balance = after;
    this._version += 1;
    this._updatedAt = movement.at;

    return entry;
  }

  private assertMovement(movement: BalanceMovement): void {
    this.assertSameCurrency(movement.money);

    if (!movement.money.isPositive()) {
      throw new InvalidAmountError(`Movement amount must be positive, got ${movement.money.toString()}`);
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new BusinessRuleViolationError(
        FailureCode.CurrencyMismatch,
        `Wallet ${this.id} is ${this.currency}, operation is ${money.currency}`,
      );
    }
  }
}
