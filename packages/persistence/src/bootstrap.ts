import pg from 'pg';

export interface BootstrapOptions {
  /** Superuser/admin connection to the `postgres` maintenance database (local dev / CI only). */
  readonly adminUrl: string;
  readonly database: string;
  readonly passwords: {
    readonly migrator: string;
    readonly api: string;
    readonly worker: string;
    readonly ops: string;
  };
}

const RUNTIME_ATTRS = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';

/**
 * Idempotently creates the database, roles and schema. Production equivalents are managed by
 * infrastructure (see infra/terraform and docs/runbooks/database.md); this is for local/CI use.
 */
export async function bootstrapDatabase(opts: BootstrapOptions): Promise<void> {
  const admin = new pg.Client({
    connectionString: opts.adminUrl,
    application_name: 'sellrelay-bootstrap',
  });
  await admin.connect();
  try {
    const roles: [string, string, string][] = [
      ['sellrelay_migrator', RUNTIME_ATTRS, opts.passwords.migrator],
      ['sellrelay_api', `${RUNTIME_ATTRS} NOINHERIT`, opts.passwords.api],
      ['sellrelay_worker', `${RUNTIME_ATTRS} NOINHERIT`, opts.passwords.worker],
      ['sellrelay_ops', `${RUNTIME_ATTRS} NOINHERIT`, opts.passwords.ops],
    ];
    for (const [name, attrs, password] of roles) {
      const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]))
        .rowCount;
      const verb = exists ? 'ALTER' : 'CREATE';
      await admin.query(`${verb} ROLE ${name} ${attrs} PASSWORD ${admin.escapeLiteral(password)}`);
    }
    // NOLOGIN owner of SECURITY DEFINER system functions (documented RLS exception).
    if (
      !(await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'sellrelay_definer'")).rowCount
    ) {
      await admin.query('CREATE ROLE sellrelay_definer NOLOGIN BYPASSRLS');
    }
    await admin.query('GRANT sellrelay_definer TO sellrelay_migrator WITH INHERIT FALSE, SET TRUE');

    const dbExists = (
      await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [opts.database])
    ).rowCount;
    if (!dbExists) await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(opts.database)}`);
  } finally {
    await admin.end();
  }

  const url = new URL(opts.adminUrl);
  url.pathname = `/${opts.database}`;
  const db = new pg.Client({
    connectionString: url.toString(),
    application_name: 'sellrelay-bootstrap',
  });
  await db.connect();
  try {
    const dbIdent = db.escapeIdentifier(opts.database);
    await db.query(`REVOKE ALL ON DATABASE ${dbIdent} FROM PUBLIC`);
    await db.query(
      `GRANT CONNECT, TEMPORARY ON DATABASE ${dbIdent} TO sellrelay_migrator, sellrelay_api, sellrelay_worker, sellrelay_ops`,
    );
    await db.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await db.query('CREATE SCHEMA IF NOT EXISTS sellrelay AUTHORIZATION sellrelay_migrator');
    for (const role of [
      'sellrelay_migrator',
      'sellrelay_api',
      'sellrelay_worker',
      'sellrelay_ops',
    ]) {
      await db.query(`ALTER ROLE ${role} IN DATABASE ${dbIdent} SET search_path = sellrelay`);
    }
  } finally {
    await db.end();
  }
}
