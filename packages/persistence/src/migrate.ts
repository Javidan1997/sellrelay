import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_KEY = 727_274_001;

interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly up: string;
  readonly down: string | null;
  readonly checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.up.sql'))
    .sort();
  return files.map((f) => {
    const [version = '', ...rest] = f.replace('.up.sql', '').split('_');
    const up = readFileSync(join(dir, f), 'utf8');
    let down: string | null;
    try {
      down = readFileSync(join(dir, f.replace('.up.sql', '.down.sql')), 'utf8');
    } catch {
      down = null;
    }
    return {
      version,
      name: rest.join('_'),
      up,
      down,
      checksum: createHash('sha256').update(up).digest('hex'),
    };
  });
}

async function ensureTable(client: pg.Client): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS sellrelay.schema_migrations (
    version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
}

export async function migrateUp(
  connectionString: string,
  log: (m: string) => void = () => undefined,
): Promise<string[]> {
  const client = new pg.Client({ connectionString, application_name: 'sellrelay-migrator' });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query('SET search_path = sellrelay');
    await ensureTable(client);
    const done = new Map(
      (
        await client.query<{ version: string; checksum: string }>(
          'SELECT version, checksum FROM schema_migrations',
        )
      ).rows.map((r) => [r.version, r.checksum]),
    );
    for (const m of loadMigrations()) {
      const existing = done.get(m.version);
      if (existing) {
        if (existing !== m.checksum)
          throw new Error(`Migration ${m.version}_${m.name} was modified after being applied`);
        continue;
      }
      log(`applying ${m.version}_${m.name}`);
      await client.query('BEGIN');
      try {
        await client.query(m.up);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [m.version, m.name, m.checksum],
        );
        await client.query('COMMIT');
        applied.push(m.version);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

export async function migrateDown(
  connectionString: string,
  steps = 1,
  log: (m: string) => void = () => undefined,
): Promise<string[]> {
  const client = new pg.Client({ connectionString, application_name: 'sellrelay-migrator' });
  await client.connect();
  const reverted: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query('SET search_path = sellrelay');
    await ensureTable(client);
    const appliedRows = (
      await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT $1',
        [steps],
      )
    ).rows;
    const byVersion = new Map(loadMigrations().map((m) => [m.version, m]));
    for (const { version } of appliedRows) {
      const m = byVersion.get(version);
      if (!m?.down) throw new Error(`No down migration for ${version}`);
      log(`reverting ${m.version}_${m.name}`);
      await client.query('BEGIN');
      try {
        await client.query(m.down);
        await client.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
        await client.query('COMMIT');
        reverted.push(version);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
    return reverted;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}
