import type { OutboxMessage } from '@/domain/entities/outbox-message.entity';

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

export interface EventPublisher {
  /**
   * Publica os eventos na ordem recebida e devolve os ids dos que foram aceitos.
   * Os demais (falha parcial ou total) continuam pendentes e são retentados.
   */
  publish(messages: readonly OutboxMessage[]): Promise<ReadonlySet<string>>;
}
