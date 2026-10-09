import { WalletLedgerEntryModel } from './wallet-ledger-entry.model';
import { WagerTransactionModel } from './wager-transaction.model';
import { OutboxMessageModel } from './outbox-message.model';
import { InboxMessageModel } from './inbox-message.model';
import { WalletModel } from './wallet.model';

export { InboxMessageModel, OutboxMessageModel, WagerTransactionModel, WalletModel, WalletLedgerEntryModel };

export const models = [
  WalletModel,
  WagerTransactionModel,
  WalletLedgerEntryModel,
  InboxMessageModel,
  OutboxMessageModel,
];
