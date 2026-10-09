import { Inject, Injectable } from '@nestjs/common';

import { InboxMessage } from '@/domain/entities/inbox-message.entity';
import { WagerTransaction } from '@/domain/entities/wager-transaction.entity';
import type { FailureCode } from '@/domain/enums/failure-code.enum';
import { WagerTransactionKind } from '@/domain/enums/wager-transaction-kind.enum';
import type { WagerTransactionStatus } from '@/domain/enums/wager-transaction-status.enum';
import { payloadHash } from '@/domain/services/payload-hash';
import { WagerTransactionProcessor } from '@/domain/services/wager-transaction-processor';
import { Money, type MoneyProps } from '@/domain/value-objects/money.vo';

import {
  IdempotencyConflictError,
  TransientInfrastructureError,
  UniqueConflictError,
  WalletNotFoundError,
} from '../errors/application-errors';
import { CLOCK, type Clock } from '../ports/clock.port';
import { ID_GENERATOR, type IdGenerator } from '../ports/id-generator.port';
import type { Repositories } from '../ports/repositories.port';
import { recordOutcome } from '../services/wager-outcome-recorder';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../ports/transaction-runner.port';
import {
  noopWageringObserver,
  WAGERING_OBSERVER,
  type WageringObserver,
} from '../ports/wagering-observer.port';

export interface WagerTransactionData {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export type CommandSource = { type: 'http' } | { type: 'sqs'; consumerName: string; messageId: string };

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  data: WagerTransactionData;
  correlationId: string;
  source: CommandSource;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export const WAGER_TRANSACTION_PROCESSOR = Symbol('WAGER_TRANSACTION_PROCESSOR');

const MAX_ATTEMPTS = 3;

/**
 * Processa uma transação de aposta. Mesmo use case para HTTP e SQS (seção 10).
 *
 * Tudo acontece em UMA transação SQL, com a wallet travada (FOR UPDATE):
 * inbox → lock → idempotência → regras → transação + saldo + ledger + outbox → COMMIT.
 */
@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly runner: TransactionRunner,
    @Inject(WAGER_TRANSACTION_PROCESSOR) private readonly processor: WagerTransactionProcessor,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(WAGERING_OBSERVER) private readonly observer: WageringObserver = noopWageringObserver,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    const hash = payloadHash(command.data);
    const startedAt = performance.now();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result = await this.runner.run((repos) => this.process(repos, command, hash));
        this.observer.transactionDecided({
          result,
          source: command.source.type,
          kind: command.data.kind,
          walletId: command.data.walletId,
          providerId: command.data.providerId,
          correlationId: command.correlationId,
          messageId: command.source.type === 'sqs' ? command.source.messageId : undefined,
          durationMs: performance.now() - startedAt,
        });
        return result;
      } catch (error) {
        if (error instanceof UniqueConflictError && attempt < MAX_ATTEMPTS) continue;
        if (error instanceof UniqueConflictError) {
          throw new TransientInfrastructureError('Unresolved unique conflict after retries', error);
        }
        throw error;
      }
    }
    throw new TransientInfrastructureError('Unreachable');
  }

  private async process(
    repos: Repositories,
    command: ProcessWagerTransactionCommand,
    hash: string,
  ): Promise<ProcessWagerTransactionResult> {
    const { data, idempotencyKey } = command;
    const now = this.clock.now();

    const inbox = this.receiveInbox(command, hash, now);
    if (inbox && !(await repos.inbox.tryReceive(inbox))) {
      return this.replayExisting(repos, idempotencyKey, data, hash);
    }

    const wallet = await repos.wallets.findByIdForUpdate(data.walletId);
    if (!wallet) throw new WalletNotFoundError(data.walletId);

    const replay = await this.findReplay(repos, idempotencyKey, data, hash);
    if (replay) {
      if (inbox) await repos.inbox.markProcessed(this.processed(inbox, now));
      return replay;
    }

    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      idempotencyKey,
      payloadHash: hash,
      walletId: data.walletId,
      playerId: data.playerId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: data.kind,
      money: Money.from(data.money),
      referenceExternalTransactionId: data.referenceExternalTransactionId,
      now,
    });

    const reference = data.referenceExternalTransactionId
      ? await repos.transactions.findByProviderExternalId(data.providerId, data.referenceExternalTransactionId)
      : undefined;
    const referenceAlreadyReversed =
      reference && transaction.requiresReference()
        ? await repos.transactions.hasProcessedReversal(reference.id, transaction.kind)
        : false;

    const outcome = this.processor.process({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      now,
    });

    await recordOutcome(repos, {
      outcome,
      transaction,
      wallet,
      isNewTransaction: true,
      eventContext: () => ({
        eventId: this.ids.next(),
        correlationId: command.correlationId,
        causationId: command.source.type === 'sqs' ? command.source.messageId : undefined,
        occurredAt: now,
      }),
    });
    if (inbox) await repos.inbox.markProcessed(this.processed(inbox, now));

    return toResult(transaction, false);
  }

  private async findReplay(
    repos: Repositories,
    idempotencyKey: string,
    data: WagerTransactionData,
    hash: string,
  ): Promise<ProcessWagerTransactionResult | undefined> {
    const byKey = await repos.transactions.findByIdempotencyKey(idempotencyKey);
    if (byKey) {
      if (!byKey.matchesPayload(hash)) throw new IdempotencyConflictError(idempotencyKey, byKey.id);
      return toResult(byKey, true);
    }

    const byExternalId = await repos.transactions.findByProviderExternalId(data.providerId, data.externalTransactionId);
    if (byExternalId) throw new IdempotencyConflictError(idempotencyKey, byExternalId.id);

    return undefined;
  }

  private async replayExisting(
    repos: Repositories,
    idempotencyKey: string,
    data: WagerTransactionData,
    hash: string,
  ): Promise<ProcessWagerTransactionResult> {
    const replay = await this.findReplay(repos, idempotencyKey, data, hash);
    if (!replay) throw new Error(`Inbox has message for ${idempotencyKey} but no transaction exists`);
    return replay;
  }

  private receiveInbox(command: ProcessWagerTransactionCommand, hash: string, now: Date): InboxMessage | undefined {
    if (command.source.type !== 'sqs') return undefined;
    return InboxMessage.receive({
      messageId: command.source.messageId,
      consumerName: command.source.consumerName,
      payloadHash: hash,
      receivedAt: now,
    });
  }

  private processed(inbox: InboxMessage, now: Date): InboxMessage {
    inbox.markProcessed(now);
    return inbox;
  }

}

export function toResult(transaction: WagerTransaction, idempotentReplay: boolean): ProcessWagerTransactionResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(transaction.balanceAfter ? { balance: transaction.balanceAfter.toJSON() } : {}),
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    idempotentReplay,
  };
}
