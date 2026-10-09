import { WagerTransaction } from '@/domain/entities/wager-transaction.entity';
import type { FailureCode } from '@/domain/enums/failure-code.enum';
import type { WagerTransactionKind } from '@/domain/enums/wager-transaction-kind.enum';
import type { WagerTransactionStatus } from '@/domain/enums/wager-transaction-status.enum';
import { Money } from '@/domain/value-objects/money.vo';

import type { WagerTransactionModel } from '../models/wager-transaction.model';

const orUndefined = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

export class WagerTransactionMapper {
  static toDomain(m: WagerTransactionModel): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: m.id,
      providerId: m.providerId,
      externalTransactionId: m.externalTransactionId,
      idempotencyKey: m.idempotencyKey,
      payloadHash: m.payloadHash,
      walletId: m.walletId,
      playerId: m.playerId,
      roundId: m.roundId,
      gameId: m.gameId,
      kind: m.kind as WagerTransactionKind,
      money: Money.fromPersistence(m.amount, m.currency),
      referenceExternalTransactionId: orUndefined(m.referenceExternalTransactionId),
      createdAt: m.createdAt,
      status: m.status as WagerTransactionStatus,
      referenceTransactionId: orUndefined(m.referenceTransactionId),
      failureCode: orUndefined(m.failureCode) as FailureCode | undefined,
      balanceAfter: m.balanceAfter == null ? undefined : Money.fromPersistence(m.balanceAfter, m.currency),
      processedAt: orUndefined(m.processedAt),
      attempts: m.attempts,
      nextAttemptAt: orUndefined(m.nextAttemptAt),
    });
  }

  static toModelData(tx: WagerTransaction): WagerTransactionModel {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      payloadHash: tx.payloadHash,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      amount: tx.money.toString(),
      currency: tx.money.currency,
      referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
      createdAt: tx.createdAt,
      ...WagerTransactionMapper.mutableFields(tx),
    };
  }

  static applyChanges(tx: WagerTransaction, model: WagerTransactionModel): void {
    Object.assign(model, WagerTransactionMapper.mutableFields(tx));
  }

  private static mutableFields(tx: WagerTransaction) {
    return {
      status: tx.status,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      failureCode: tx.failureCode ?? null,
      balanceAfter: tx.balanceAfter?.toString() ?? null,
      processedAt: tx.processedAt ?? null,
      attempts: tx.attempts,
      nextAttemptAt: tx.nextAttemptAt ?? null,
    };
  }
}
