import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
  type MikroORM,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';

import { TransientInfrastructureError, UniqueConflictError } from '@/application/errors/application-errors';
import type { Repositories } from '@/application/ports/repositories.port';
import type { TransactionRunner } from '@/application/ports/transaction-runner.port';

import { createRepositories } from './repositories/mikro-orm.repositories';

const LOCK_TIMEOUT = '5s';

export type ConflictKind = 'unique' | 'lock_timeout' | 'deadlock';

export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(
    private readonly orm: MikroORM,
    private readonly onConflict: (kind: ConflictKind) => void = () => {},
  ) {}

  async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    const em = this.orm.em.fork();

    try {
      return await em.transactional(async (tx) => {
        await tx.execute(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
        return work(createRepositories(tx));
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** Traduz exceções do driver para os erros que a camada de aplicação entende. */
  private translate(error: unknown): unknown {
    if (error instanceof UniqueConstraintViolationException) {
      this.onConflict('unique');
      return new UniqueConflictError((error as { constraint?: string }).constraint);
    }
    if (error instanceof LockWaitTimeoutException || error instanceof DeadlockException) {
      this.onConflict(error instanceof DeadlockException ? 'deadlock' : 'lock_timeout');
      return new TransientInfrastructureError(error.message, error);
    }
    if (error instanceof ConnectionException) return new TransientInfrastructureError(error.message, error);
    return error;
  }
}
