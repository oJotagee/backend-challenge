import type { Repositories } from './repositories.port';

export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');

export interface TransactionRunner {
  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}
