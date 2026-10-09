import { Inject, Injectable } from '@nestjs/common';

import type { WagerTransaction } from '@/domain/entities/wager-transaction.entity';
import type { FailureCode } from '@/domain/enums/failure-code.enum';
import type { LedgerDirection } from '@/domain/enums/ledger-direction.enum';
import type { WagerTransactionKind } from '@/domain/enums/wager-transaction-kind.enum';
import type { WagerTransactionStatus } from '@/domain/enums/wager-transaction-status.enum';
import type { MoneyProps } from '@/domain/value-objects/money.vo';

import { InvalidCursorError, TransactionNotFoundError, WalletNotFoundError } from '../errors/application-errors';
import { WAGERING_READ_REPOSITORY, type WageringReadRepository } from '../ports/wagering-read.port';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  failureCode: FailureCode | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balanceAfter: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export const MAX_LEDGER_PAGE_SIZE = 200;

/** Consultas da API (wallet, ledger, transação). Só leitura: nada aqui altera estado. */
@Injectable()
export class WageringQueries {
  constructor(@Inject(WAGERING_READ_REPOSITORY) private readonly read: WageringReadRepository) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.read.findWallet(walletId);
    if (!wallet) throw new WalletNotFoundError(walletId);

    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  async listLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    const afterSequence = cursor ? decodeCursor(cursor) : undefined;
    if (!(await this.read.findWallet(walletId))) throw new WalletNotFoundError(walletId);

    const page = await this.read.listLedger(walletId, afterSequence, Math.min(limit, MAX_LEDGER_PAGE_SIZE));
    const last = page.entries.at(-1);
    return {
      items: page.entries.map(({ entry }) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.hasMore && last ? encodeCursor(last.sequence) : null,
    };
  }

  async getTransaction(transactionId: string): Promise<WagerTransactionView> {
    const tx = await this.read.findTransaction(transactionId);
    if (!tx) throw new TransactionNotFoundError(transactionId);
    return toTransactionView(tx);
  }

  async getTransactionByProviderExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const tx = await this.read.findTransactionByProviderExternalId(providerId, externalTransactionId);
    if (!tx) throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    return toTransactionView(tx);
  }
}

/**
 * Cursor opaco = base64url de `{"s": "<sequence>"}`. Estável: novos lançamentos só entram
 * com sequence maior (inserções na mesma wallet são serializadas pelo lock).
 */
export function encodeCursor(sequence: string): string {
  return Buffer.from(JSON.stringify({ s: sequence })).toString('base64url');
}

export function decodeCursor(cursor: string): string {
  try {
    const { s } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown };
    if (typeof s !== 'string' || !/^\d+$/.test(s)) throw new Error();
    return s;
  } catch {
    throw new InvalidCursorError();
  }
}

function toTransactionView(tx: WagerTransaction): WagerTransactionView {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    balanceAfter: tx.balanceAfter?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}
