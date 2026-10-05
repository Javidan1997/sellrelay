import { AsyncLocalStorage } from 'node:async_hooks';

/** Correlation context propagated through API requests and worker jobs. */
export interface ExecutionContext {
  readonly correlationId: string;
  readonly tenantId?: string;
  readonly connectionId?: string;
  readonly storeId?: string;
  readonly jobId?: string;
  readonly jobKind?: string;
}

const contextStore = new AsyncLocalStorage<ExecutionContext>();
const txStore = new AsyncLocalStorage<{ readonly label: string }>();

export function runWithContext<T>(ctx: ExecutionContext, fn: () => T): T {
  return contextStore.run(ctx, fn);
}

export function currentContext(): ExecutionContext | undefined {
  return contextStore.getStore();
}

export function withContextFields<T>(fields: Partial<ExecutionContext>, fn: () => T): T {
  const base = contextStore.getStore() ?? { correlationId: fields.correlationId ?? 'none' };
  return contextStore.run({ ...base, ...fields } as ExecutionContext, fn);
}

/** Marks the async scope as being inside an open database transaction. */
export function runInTransactionScope<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return txStore.run({ label }, fn);
}

export class TransactionHeldDuringExternalCallError extends Error {
  constructor(operation: string, txLabel: string) {
    super(`External call "${operation}" attempted while database transaction "${txLabel}" is open`);
    this.name = 'TransactionHeldDuringExternalCallError';
  }
}

/** External HTTP clients call this before sending; DB transactions must not span remote calls. */
export function assertNoOpenTransaction(operation: string): void {
  const tx = txStore.getStore();
  if (tx) throw new TransactionHeldDuringExternalCallError(operation, tx.label);
}
