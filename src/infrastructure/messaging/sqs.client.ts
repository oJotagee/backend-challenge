import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '@/config';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.AWS_REGION,
    ...(config.SQS_ENDPOINT ? { endpoint: config.SQS_ENDPOINT } : {}),
  });
}
