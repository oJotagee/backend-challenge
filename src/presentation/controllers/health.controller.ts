import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';

import { SQS_CLIENT } from '@/infrastructure/messaging/sqs.client';
import { Public } from '@/infrastructure/auth/auth.guard';
import { APP_CONFIG, type AppConfig } from '@/config';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const [postgres, sqs] = await Promise.all([
      this.check(() => this.em.getConnection().execute('select 1')),
      this.check(() =>
        this.sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: this.config.SQS_WAGER_QUEUE_URL, AttributeNames: ['QueueArn'] }),
        ),
      ),
    ]);
    const body = { status: postgres && sqs ? 'ok' : 'unavailable', checks: { postgres, sqs } };
    if (!postgres || !sqs) throw new ServiceUnavailableException(body);
    return body;
  }

  private async check(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
      return true;
    } catch {
      return false;
    }
  }
}
