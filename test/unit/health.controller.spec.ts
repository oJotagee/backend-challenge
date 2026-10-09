import { describe, expect, it } from 'bun:test';
import { ServiceUnavailableException } from '@nestjs/common';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';

import type { AppConfig } from '@/config';
import { HealthController } from '@/presentation/controllers/health.controller';

const config = { SQS_WAGER_QUEUE_URL: 'http://queue' } as AppConfig;
const em = (ok: boolean) =>
  ({ getConnection: () => ({ execute: () => (ok ? Promise.resolve([]) : Promise.reject(new Error('db down'))) }) }) as unknown as EntityManager;
const sqs = (ok: boolean) =>
  ({ send: () => (ok ? Promise.resolve({}) : Promise.reject(new Error('sqs down'))) }) as unknown as SQSClient;

describe('HealthController', () => {
  it('live não depende de nada', () => {
    expect(new HealthController(em(false), sqs(false), config).live()).toEqual({ status: 'ok' });
  });

  it('ready = 503 apontando qual dependência caiu', async () => {
    const controller = new HealthController(em(true), sqs(false), config);

    try {
      await controller.ready();
      throw new Error('should have failed');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getResponse()).toEqual({
        status: 'unavailable',
        checks: { postgres: true, sqs: false },
      });
    }
  });

  it('ready = ok quando tudo responde', async () => {
    expect(await new HealthController(em(true), sqs(true), config).ready()).toEqual({
      status: 'ok',
      checks: { postgres: true, sqs: true },
    });
  });
});
