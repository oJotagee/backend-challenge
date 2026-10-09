import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default('info'),
  INSTANCE_ID: z
    .string()
    .optional()
    .transform((v) => v || process.env.HOSTNAME || String(process.pid)),
  DATABASE_URL: z.string().url(),
  AWS_REGION: z.string().default('us-east-1'),
  SQS_ENDPOINT: z.string().url().optional(),
  SQS_WAGER_QUEUE_URL: z.string().url(),
  SQS_WAGER_DLQ_URL: z.string().url(),
  SQS_EVENTS_QUEUE_URL: z.string().url(),
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().positive().default(5),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_RETRY_BASE_SECONDS: z.coerce.number().int().min(0).default(2),
  SQS_RETRY_MAX_SECONDS: z.coerce.number().int().positive().default(300),
  WORKERS_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(10_000),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  PENDING_REFERENCE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  PENDING_REFERENCE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
});

export type AppConfig = z.infer<typeof schema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return schema.parse(env);
}
