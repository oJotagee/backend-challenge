import { OutboxMessage } from '@/domain/entities/outbox-message.entity';
import type { WagerTransaction } from '@/domain/entities/wager-transaction.entity';
import type { Wallet } from '@/domain/entities/wallet.entity';
import type { EventContext, IntegrationEvent } from '@/domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '@/domain/events/wager-transaction-events';
import type { ProcessOutcome } from '@/domain/services/wager-transaction-processor';

import type { Repositories } from '../ports/repositories.port';

export interface RecordOutcomeInput {
  outcome: ProcessOutcome;
  transaction: WagerTransaction;
  wallet: Wallet;
  isNewTransaction: boolean;
  eventContext: () => EventContext;
}

/**
 * Registra no Unit of Work tudo que um resultado produz: transação, saldo, lançamento e
 * eventos na outbox. Compartilhado pela entrada (HTTP/SQS) e pelo worker de referências.
 */
export async function recordOutcome(repos: Repositories, input: RecordOutcomeInput): Promise<void> {
  const { outcome, transaction, wallet } = input;

  if (input.isNewTransaction) repos.transactions.add(transaction);
  else repos.transactions.update(transaction);

  if (outcome.type === 'processed' && outcome.entry) {
    repos.wallets.update(wallet);
    repos.ledger.add(outcome.entry);
  }

  for (const event of eventsFor(input)) repos.outbox.add(OutboxMessage.enqueue(event));

  if (outcome.type === 'processed') {
    await repos.transactions.expeditePendingReferencing(
      transaction.providerId,
      transaction.externalTransactionId,
      transaction.processedAt!,
    );
  }
}

function eventsFor({ outcome, transaction, wallet, eventContext }: RecordOutcomeInput): IntegrationEvent<unknown>[] {
  switch (outcome.type) {
    case 'processed':
      return outcome.entry
        ? [WagerTransactionProcessed.from(transaction, eventContext()), WalletBalanceChanged.from(wallet, outcome.entry, eventContext())]
        : [WagerTransactionProcessed.from(transaction, eventContext())];
    case 'rejected':
      return [WagerTransactionRejected.from(transaction, eventContext())];
    case 'pending_reference':
      return [WagerTransactionPendingReference.from(transaction, eventContext())];
  }
}
