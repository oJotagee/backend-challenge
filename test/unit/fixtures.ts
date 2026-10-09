import { WagerTransaction, type CreateWagerTransactionProps } from '@/domain/entities/wager-transaction.entity';
import { Wallet } from '@/domain/entities/wallet.entity';
import { WagerTransactionKind } from '@/domain/enums/wager-transaction-kind.enum';
import { Money } from '@/domain/value-objects/money.vo';

export const NOW = new Date('2026-07-29T15:00:00.000Z');
export const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
export const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';

let seq = 0;
export const id = (prefix = 'id') => `${prefix}-${++seq}`;

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

export function walletWith(balance: string, currency = 'BRL'): Wallet {
  return Wallet.rehydrate({
    id: WALLET_ID,
    playerId: PLAYER_ID,
    currency,
    balance: Money.fromPersistence(balance, currency),
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

export function tx(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? id('ext');
  return WagerTransaction.create({
    id: id('tx'),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'a'.repeat(64),
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    now: NOW,
    ...overrides,
  });
}

/** Uma transação já PROCESSED, para servir de referência. */
export function processed(kind: WagerTransactionKind, amount: string, balanceAfter = '0.00'): WagerTransaction {
  const t = tx(kind, amount, kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback
    ? { referenceExternalTransactionId: 'whatever' }
    : {});
  t.markProcessed(undefined, Money.fromPersistence(balanceAfter, 'BRL'), NOW);
  return t;
}
