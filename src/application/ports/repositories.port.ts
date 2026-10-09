import type { InboxMessage } from '@/domain/entities/inbox-message.entity';
import type { OutboxMessage } from '@/domain/entities/outbox-message.entity';
import type { WagerTransaction } from '@/domain/entities/wager-transaction.entity';
import type { Wallet } from '@/domain/entities/wallet.entity';
import type { WalletLedgerEntry } from '@/domain/entities/wallet-ledger-entry.entity';
import type { WagerTransactionKind } from '@/domain/enums/wager-transaction-kind.enum';

export interface WalletRepository {
  findByIdForUpdate(walletId: string): Promise<Wallet | undefined>;
  add(wallet: Wallet): void;
  update(wallet: Wallet): void;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean>;
  findDuePendingReference(now: Date, limit: number): Promise<{ id: string; walletId: string }[]>;
  expeditePendingReferencing(providerId: string, externalTransactionId: string, now: Date): Promise<void>;
  add(transaction: WagerTransaction): void;
  update(transaction: WagerTransaction): void;
}

export interface LedgerSummary {
  calculatedBalance: string;
  entryCount: number;
}

export interface LedgerRepository {
  add(entry: WalletLedgerEntry): void;
  summarize(walletId: string): Promise<LedgerSummary>;
}

export interface InboxRepository {
  tryReceive(message: InboxMessage): Promise<boolean>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  update(message: OutboxMessage): void;
  oldestPendingOccurredAt(): Promise<Date | undefined>;
}

export interface Repositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}
