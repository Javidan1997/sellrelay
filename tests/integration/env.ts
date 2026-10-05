/** Shared test configuration. Roles are cluster-wide, so passwords must match the dev .env. */
const pw = (name: string) => process.env[name] ?? 'change-me-local-only';

export const TEST_DB = process.env['TEST_DATABASE_NAME'] ?? 'sellrelay_test';
export const ADMIN_URL =
  process.env['TEST_DATABASE_ADMIN_URL'] ??
  process.env['DATABASE_ADMIN_URL'] ??
  'postgres://postgres:postgres-local-only@localhost:5432/postgres';

const host = new URL(ADMIN_URL).host;
const url = (role: string, password: string) =>
  `postgres://${role}:${encodeURIComponent(password)}@${host}/${TEST_DB}`;

export const PASSWORDS = {
  migrator: pw('DB_MIGRATOR_PASSWORD'),
  api: pw('DB_API_PASSWORD'),
  worker: pw('DB_WORKER_PASSWORD'),
  ops: pw('DB_OPS_PASSWORD'),
};

export const URLS = {
  migrator: url('sellrelay_migrator', PASSWORDS.migrator),
  api: url('sellrelay_api', PASSWORDS.api),
  worker: url('sellrelay_worker', PASSWORDS.worker),
  ops: url('sellrelay_ops', PASSWORDS.ops),
};

export const REDIS_URL =
  process.env['TEST_REDIS_URL'] ?? process.env['REDIS_URL'] ?? 'redis://localhost:6379/15';
