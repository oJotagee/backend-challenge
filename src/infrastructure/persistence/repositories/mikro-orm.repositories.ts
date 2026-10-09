import { type EntityManager, LockMode } from '@mikro-orm/postgresql';

import type {
  InboxRepository,
  LedgerRepository,
  LedgerSummary,
  OutboxRepository,
  Repositories,
  WagerTransactionRepository,
  WalletRepository,
} from '@/application/ports/repositories.port';
import type { InboxMessage } from '@/domain/entities/inbox-message.entity';
import { OutboxMessage } from '@/domain/entities/outbox-message.entity';
import type { WagerTransaction } from '@/domain/entities/wager-transaction.entity';
import type { Wallet } from '@/domain/entities/wallet.entity';
import type { WalletLedgerEntry } from '@/domain/entities/wallet-ledger-entry.entity';
import type { WagerTransactionKind } from '@/domain/enums/wager-transaction-kind.enum';
import { WagerTransactionStatus } from '@/domain/enums/wager-transaction-status.enum';

import { LedgerEntryMapper } from '../mappers/ledger-entry.mapper';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper';
import { WalletMapper } from '../mappers/wallet.mapper';
import { OutboxMessageModel } from '../models/outbox-message.model';
import { WagerTransactionModel } from '../models/wager-transaction.model';
import { WalletLedgerEntryModel } from '../models/wallet-ledger-entry.model';
import { WalletModel } from '../models/wallet.model';

/**
 * Repositórios presos a UM EntityManager transacional. `add`/`update` só registram a
 * mudança no Unit of Work; o MikroORM grava tudo no flush que antecede o COMMIT.
 */
export function createRepositories(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findByIdForUpdate(walletId: string): Promise<Wallet | undefined> {
    const model = await this.em.findOne(
      WalletModel,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return model ? WalletMapper.toDomain(model) : undefined;
  }

  add(wallet: Wallet): void {
    this.em.persist(this.em.create(WalletModel, WalletMapper.toModelData(wallet)));
  }

  update(wallet: Wallet): void {
    WalletMapper.applyChanges(wallet, this.em.getReference(WalletModel, wallet.id));
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.one({ id });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.one({ idempotencyKey });
  }

  async findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.one({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean> {
    const count = await this.em.count(WagerTransactionModel, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async findDuePendingReference(now: Date, limit: number): Promise<{ id: string; walletId: string }[]> {
    const models = await this.em.find(
      WagerTransactionModel,
      { status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: now } },
      { orderBy: { nextAttemptAt: 'asc' }, limit, fields: ['id', 'walletId'] },
    );
    return models.map((m) => ({ id: m.id, walletId: m.walletId }));
  }

  async expeditePendingReferencing(providerId: string, externalTransactionId: string, now: Date): Promise<void> {
    await this.em.execute(
      `update wager_transactions set next_attempt_at = ?
        where provider_id = ? and reference_external_transaction_id = ? and status = 'PENDING_REFERENCE'`,
      [now, providerId, externalTransactionId],
    );
  }

  add(transaction: WagerTransaction): void {
    this.em.persist(this.em.create(WagerTransactionModel, WagerTransactionMapper.toModelData(transaction)));
  }

  update(transaction: WagerTransaction): void {
    WagerTransactionMapper.applyChanges(transaction, this.em.getReference(WagerTransactionModel, transaction.id));
  }

  private async one(where: Partial<WagerTransactionModel>): Promise<WagerTransaction | undefined> {
    const model = await this.em.findOne(WagerTransactionModel, where);
    return model ? WagerTransactionMapper.toDomain(model) : undefined;
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async summarize(walletId: string): Promise<LedgerSummary> {
    const [row] = await this.em.execute<{ total: string; entries: string }[]>(
      `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(20,2)::text as total,
              count(*)::text as entries
         from wallet_ledger_entries where wallet_id = ?`,
      [walletId],
    );
    return { calculatedBalance: row!.total, entryCount: Number(row!.entries) };
  }

  add(entry: WalletLedgerEntry): void {
    this.em.persist(this.em.create(WalletLedgerEntryModel, LedgerEntryMapper.toModelData(entry) as WalletLedgerEntryModel));
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryReceive(message: InboxMessage): Promise<boolean> {
    const rows = await this.em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    return rows.length > 0;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.execute(`update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ?`, [
      message.processedAt,
      message.consumerName,
      message.messageId,
    ]);
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    this.em.persist(
      this.em.create(OutboxMessageModel, {
        id: message.id,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: { ...message.payload },
        occurredAt: message.occurredAt,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
        publishedAt: message.publishedAt ?? null,
      }),
    );
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const models = await this.em.find(
      OutboxMessageModel,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      { orderBy: { occurredAt: 'asc' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return models.map((m) =>
      OutboxMessage.rehydrate({
        id: m.id,
        aggregateId: m.aggregateId,
        eventType: m.eventType,
        payload: m.payload,
        occurredAt: m.occurredAt,
        attempts: m.attempts,
        nextAttemptAt: m.nextAttemptAt,
        publishedAt: m.publishedAt ?? undefined,
      }),
    );
  }

  update(message: OutboxMessage): void {
    const model = this.em.getReference(OutboxMessageModel, message.id);
    model.attempts = message.attempts;
    model.nextAttemptAt = message.nextAttemptAt ?? model.nextAttemptAt;
    model.publishedAt = message.publishedAt ?? null;
  }

  async oldestPendingOccurredAt(): Promise<Date | undefined> {
    const [row] = await this.em.execute<{ oldest: Date | null }[]>(
      'select min(occurred_at) as oldest from outbox_messages where published_at is null',
    );
    return row?.oldest ?? undefined;
  }
}
