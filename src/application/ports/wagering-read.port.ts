import type { WagerTransaction } from '@/domain/entities/wager-transaction.entity';
import type { Wallet } from '@/domain/entities/wallet.entity';
import type { WalletLedgerEntry } from '@/domain/entities/wallet-ledger-entry.entity';

export const WAGERING_READ_REPOSITORY = Symbol('WAGERING_READ_REPOSITORY');

export interface LedgerPage {
  entries: { entry: WalletLedgerEntry; sequence: string }[];
  hasMore: boolean;
}

/** Leituras das consultas da API: sem transação e sem lock. */
export interface WageringReadRepository {
  findWallet(walletId: string): Promise<Wallet | undefined>;
  listLedger(walletId: string, afterSequence: string | undefined, limit: number): Promise<LedgerPage>;
  findTransaction(transactionId: string): Promise<WagerTransaction | undefined>;
  findTransactionByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
}
