import { bootstrapDatabase } from '../bootstrap.ts';
import { requireEnv } from './env.ts';

await bootstrapDatabase({
  adminUrl: requireEnv('DATABASE_ADMIN_URL'),
  database: process.env['DATABASE_NAME'] ?? 'sellrelay',
  passwords: {
    migrator: requireEnv('DB_MIGRATOR_PASSWORD'),
    api: requireEnv('DB_API_PASSWORD'),
    worker: requireEnv('DB_WORKER_PASSWORD'),
    ops: requireEnv('DB_OPS_PASSWORD'),
  },
});
console.log('bootstrap complete');
