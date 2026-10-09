import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../ports/clock.port';
import { EVENT_PUBLISHER, type EventPublisher } from '../ports/event-publisher.port';
import { TRANSACTION_RUNNER, type TransactionRunner } from '../ports/transaction-runner.port';

export interface PublishOutboxResult {
  published: number;
  failed: number;
}

/**
 * Publica um lote de eventos pendentes. As linhas são reservadas com FOR UPDATE SKIP LOCKED:
 * vários publishers (instâncias) pegam lotes diferentes, nunca o mesmo evento ao mesmo tempo.
 * Se o processo morrer depois de publicar e antes do COMMIT, o lock é liberado, a linha
 * continua pendente e outra instância publica de novo — duplicata segura pelo eventId.
 */
@Injectable()
export class PublishOutboxUseCase {
  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly runner: TransactionRunner,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(batchSize: number): Promise<PublishOutboxResult> {
    return this.runner.run(async (repos) => {
      const messages = await repos.outbox.claimDue(this.clock.now(), batchSize);
      if (messages.length === 0) return { published: 0, failed: 0 };

      const accepted = await this.publisher.publish(messages).catch(() => new Set<string>());
      const now = this.clock.now();

      for (const message of messages) {
        if (accepted.has(message.id)) message.markPublished(now);
        else message.scheduleRetry(now);
        repos.outbox.update(message);
      }

      return { published: accepted.size, failed: messages.length - accepted.size };
    });
  }

  /** Idade, em segundos, do evento confirmado mais antigo ainda não publicado. */
  async lagSeconds(): Promise<number> {
    const oldest = await this.runner.run((repos) => repos.outbox.oldestPendingOccurredAt());
    return oldest ? Math.max(0, (this.clock.now().getTime() - new Date(oldest).getTime()) / 1000) : 0;
  }
}
