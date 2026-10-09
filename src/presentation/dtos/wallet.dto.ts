import { z } from 'zod';

export const moneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

export const createWalletSchema = z.strictObject({
  playerId: z.uuid(),
  initialBalance: moneySchema,
});
export type CreateWalletDto = z.infer<typeof createWalletSchema>;

export const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type LedgerQueryDto = z.infer<typeof ledgerQuerySchema>;

export const uuidParamSchema = z.uuid();
