import { FailureCode } from '../enums/failure-code.enum';
import { LedgerDirection } from '../enums/ledger-direction.enum';
import { WagerTransactionKind } from '../enums/wager-transaction-kind.enum';
import { TERMINAL_STATUSES, WagerTransactionStatus } from '../enums/wager-transaction-status.enum';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../errors/domain-error';
import { type BackoffPolicy, nextAttemptAt } from '../services/exponential-backoff';
import { Money } from '../value-objects/money.vo';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  now: Date;
}

export interface CreateOpeningProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  now: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  balanceAfter?: Money;
  processedAt?: Date;
  attempts: number;
  nextAttemptAt?: Date;
}

export const INTERNAL_PROVIDER_ID = 'internal';

const REQUIRES_REFERENCE = new Set([WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);

export const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>>> =
  {
    [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
    [WagerTransactionKind.Rollback]: new Set([
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
    ]),
  };

/**
 * Transições válidas:
 *
 *   PENDING ───────────► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE ─► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
 *   PROCESSED, REJECTED, FAILED → terminais: qualquer transição lança InvalidTransactionStateError.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _attempts: number,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _balanceAfter?: Money,
    private _processedAt?: Date,
    private _nextAttemptAt?: Date,
  ) {}

  /** Entrada externa (API ou fila). Nasce em PENDING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money, referenceExternalTransactionId } = props;

    if (kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING is internal and cannot be submitted');
    }

    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
    }

    if (REQUIRES_REFERENCE.has(kind) && !referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(`${kind} requires referenceExternalTransactionId`);
    }

    if (!REQUIRES_REFERENCE.has(kind) && kind !== WagerTransactionKind.Win && referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(`${kind} cannot have a reference`);
    }

    if (kind !== WagerTransactionKind.Loss && !money.isPositive()) {
      throw new InvalidWagerTransactionError(`${kind} amount must be positive`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      kind,
      money,
      referenceExternalTransactionId,
      props.now,
      WagerTransactionStatus.Pending,
      0,
    );
  }

  /** Transação interna de abertura da wallet. Já nasce PROCESSED. */
  static opening(props: CreateOpeningProps): WagerTransaction {
    const key = `${INTERNAL_PROVIDER_ID}:opening:${props.walletId}`;

    const tx = new WagerTransaction(
      props.id,
      INTERNAL_PROVIDER_ID,
      `opening:${props.walletId}`,
      key,
      '0'.repeat(64),
      props.walletId,
      props.playerId,
      'opening',
      'opening',
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.now,
      WagerTransactionStatus.Pending,
      0,
    );

    tx.markProcessed(undefined, props.money, props.now);

    return tx;
  }

  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.attempts,
      s.referenceTransactionId,
      s.failureCode,
      s.balanceAfter,
      s.processedAt,
      s.nextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  /** Saldo observado quando a transação ficou terminal — devolvido em replays (regra 7.7). */
  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  markProcessed(referenceTransactionId: string | undefined, balanceAfter: Money, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._balanceAfter = balanceAfter;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Referência ainda não chegou: agenda nova tentativa com backoff exponencial. */
  markPendingReference(now: Date, policy: BackoffPolicy): void {
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.PendingReference;
    this._attempts += 1;
    this._nextAttemptAt = nextAttemptAt(now, this._attempts, policy);
  }

  reject(code: FailureCode, at: Date, observedBalance?: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = observedBalance;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** false para LOSS: registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REQUIRES_REFERENCE.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento:
   * BET → DEBIT · WIN, REFUND, OPENING → CREDIT · ROLLBACK → inverso da referência.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidWagerTransactionError('ROLLBACK direction depends on its reference');
        const referenced = reference.ledgerDirectionFor();
        return referenced === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS does not produce a ledger entry');
    }
  }

  private assertNotTerminal(to: WagerTransactionStatus): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this.id, this._status, to);
  }
}
