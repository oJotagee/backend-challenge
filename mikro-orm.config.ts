import 'reflect-metadata';

import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

import { models } from './src/infrastructure/persistence/models';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL,
  entities: models,
  metadataProvider: ReflectMetadataProvider,
  extensions: [Migrator],
  migrations: {
    path: './src/infrastructure/database/migrations',
    pathTs: './src/infrastructure/database/migrations',
    transactional: true,
    allOrNothing: true,
  },
  debug: process.env.LOG_LEVEL === 'debug',
});
