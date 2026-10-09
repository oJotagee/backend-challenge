import { z } from 'zod';

import { WagerTransactionKind } from '@/domain/enums/wager-transaction-kind.enum';

const id = z.string().min(1).max(255);

/** Contrato da fila wager-transactions.fifo (seção 10). */
export const wagerTransactionRequestedSchema = z.object({
  messageId: id,
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: z.strictObject({
    providerId: id,
    externalTransactionId: id,
    idempotencyKey: id,
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: id,
    gameId: id,
    kind: z.enum([
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]),
    money: z.object({ amount: z.string(), currency: z.string() }),
    referenceExternalTransactionId: id.optional(),
  }),
});

export type WagerTransactionRequested = z.infer<typeof wagerTransactionRequestedSchema>;
