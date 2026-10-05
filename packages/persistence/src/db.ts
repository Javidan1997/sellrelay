import pg from 'pg';
import { isUuid } from '@sellrelay/core';
import { runInTransactionScope } from '@sellrelay/observability';

export type Row = Record<string, unknown>;

/** Minimal query interface shared by pooled clients inside transactions. */
export interface Tx {
  query<R extends pg.QueryResultRow = Row>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export interface PoolOptions {
  readonly applicationName: string;
  readonly max?: number;
  readonly statementTimeoutMs?: number;
}

const INT8_OID = 20;

/** int8 values are parsed as BigInt so monetary minor units never lose precision. */
const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8_OID && format !== 'binary') return (v: string) => BigInt(v);
    return pg.types.getTypeParser(oid, format as 'text');
  },
} as unknown as pg.CustomTypesConfig;

export function createPool(connectionString: string, opts: PoolOptions): pg.Pool {
  return new pg.Pool({
    connectionString,
    application_name: opts.applicationName,
    max: opts.max ?? 10,
    statement_timeout: opts.statementTimeoutMs ?? 30_000,
    // Guard rail: a transaction left idle (e.g. awaiting a remote call) is terminated.
    idle_in_transaction_session_timeout: 15_000,
    connectionTimeoutMillis: 5_000,
    types,
  });
}

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

async function runTx<T>(
  pool: pg.Pool,
  label: string,
  setup: (c: pg.PoolClient) => Promise<void>,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setup(client);
    const result = await runInTransactionScope(label, () => fn(client));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Run fn in a transaction whose RLS tenant context is set transaction-locally
 * (`set_config(..., true)`), so the setting never leaks to the next pool user.
 * The tenant id MUST come from verified identity/membership or a trusted job record.
 */
export function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!isUuid(tenantId))
    return Promise.reject(new TenantContextError('Invalid tenant id for tenant context'));
  return runTx(
    pool,
    `tenant:${tenantId}`,
    async (c) => {
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    },
    fn,
  );
}

/** Transaction without tenant context: only SECURITY DEFINER system functions return data here. */
export function withSystemTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runTx(pool, 'system', async () => undefined, fn);
}

export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}
