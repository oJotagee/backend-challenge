import { z } from 'zod';

import { WagerTransactionKind } from '@/domain/enums/wager-transaction-kind.enum';

import { moneySchema } from './wallet.dto';

const submittableKinds = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

const id = z.string().min(1).max(255);

export const wagerTransactionSchema = z.strictObject({
  providerId: id,
  externalTransactionId: id,
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: id,
  gameId: id,
  kind: z.enum(submittableKinds),
  money: moneySchema,
  referenceExternalTransactionId: id.optional(),
});
export type WagerTransactionDto = z.infer<typeof wagerTransactionSchema>;

export const idempotencyKeySchema = z.string().trim().min(1).max(255);
