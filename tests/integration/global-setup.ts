import pg from 'pg';
import { bootstrapDatabase, migrateUp } from '../../packages/persistence/src/index.ts';
import { ADMIN_URL, PASSWORDS, TEST_DB, URLS } from './env.ts';

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(TEST_DB)} WITH (FORCE)`);
  await admin.end();
  await bootstrapDatabase({ adminUrl: ADMIN_URL, database: TEST_DB, passwords: PASSWORDS });
  await migrateUp(URLS.migrator);
}
