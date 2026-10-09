import { FailureCode } from '@/domain/enums/failure-code.enum';
import { DomainError } from '@/domain/errors/domain-error';

/**
 * Wallet inexistente. Não vira transação REJECTED gravada: a FK wallet_id impede gravar
 * transação para wallet que não existe. Responde com o failureCode, sem persistir.
 */
export class WalletNotFoundError extends DomainError {
  readonly code = FailureCode.WalletNotFound;

  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends DomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(reference: string) {
    super(`Transaction ${reference} not found`);
  }
}

export class InvalidCursorError extends DomainError {
  readonly code = 'INVALID_CURSOR';

  constructor() {
    super('Invalid pagination cursor');
  }
}

/** Já existe wallet para este player + moeda. */
export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`Wallet for player ${playerId} in ${currency} already exists`);
  }
}

/** Mesma idempotency key com payload diferente: conflito, nunca replay (seção 9). */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';

  constructor(
    idempotencyKey: string,
    readonly existingTransactionId: string,
  ) {
    super(`Idempotency key ${idempotencyKey} was already used with a different payload`);
  }
}

/** Outra transação gravou a mesma chave única primeiro. Interno: o use case trata. */
export class UniqueConflictError extends Error {
  constructor(readonly constraint: string | undefined) {
    super(`Unique constraint conflict${constraint ? ` (${constraint})` : ''}`);
    this.name = 'UniqueConflictError';
  }
}

/** Falha temporária (lock timeout, deadlock, banco fora). Seguro tentar de novo: 503 / retry na fila. */
export class TransientInfrastructureError extends Error {
  readonly code = 'TRANSIENT_INFRASTRUCTURE_ERROR';

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransientInfrastructureError';
  }
}
