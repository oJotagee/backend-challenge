import type { FailureCode } from '../enums/failure-code.enum';

/**
 * Base de todos os erros do domínio. Três famílias, cada uma com um tratamento:
 * - BusinessRuleViolationError: operação válida recusada pela regra → REJECTED (422);
 * - entrada inválida (InvalidMoney, CurrencyMismatch, InvalidWagerTransaction) → nada gravado (400);
 * - violação de invariante (InvalidTransactionState, UnbalancedLedgerEntry, InvalidAmount) → bug (500).
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Regra de negócio violada por uma operação válida (ex.: aposta sem saldo). Vira REJECTED. */
export class BusinessRuleViolationError extends DomainError {
  readonly code: FailureCode;

  constructor(failureCode: FailureCode, message: string) {
    super(message);
    this.code = failureCode;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(input: string) {
    super(`Invalid money amount: "${input}"`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/** Dados que não formam uma operação válida (ex.: REFUND sem referência, OPENING vindo de fora). */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';

  constructor(message: string) {
    super(message);
  }
}

/** Erro de programação: transição a partir de um estado terminal. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(transactionId: string, from: string, to: string) {
    super(`Transaction ${transactionId} cannot go from ${from} to ${to}`);
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';

  constructor(details: string) {
    super(`Ledger entry is not balanced: ${details}`);
  }
}

export class InvalidAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT';

  constructor(message: string) {
    super(message);
  }
}
