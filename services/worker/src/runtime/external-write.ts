import type { OperationOutcome } from '@sellrelay/core';
import { ProviderFailure } from '@sellrelay/core';
import { ledger } from '@sellrelay/persistence';
import type { JobContext } from './types.ts';

export type RemoteCheck =
  { found: true; externalRef: string } | { found: false } | { unsupported: true };

export interface ExternalWriteSpec {
  readonly targetKind: 'store' | 'channel' | 'crm';
  readonly targetId: string;
  readonly operation: string;
  /** Deterministic key, e.g. `order:<sourceOrderId>`; also passed to providers that officially support idempotency keys. */
  readonly idempotencyKey: string;
  readonly request: unknown;
  readonly send: (signal: AbortSignal) => Promise<OperationOutcome<{ externalRef: string }>>;
  /**
   * Look up remote state by documented external reference (e.g. order by source reference).
   * Required to safely retry after an "outcome unknown" or a crash after sending.
   */
  readonly checkRemote: (signal: AbortSignal) => Promise<RemoteCheck>;
}

export type ExternalWriteResult =
  | {
      readonly status: 'succeeded';
      readonly externalRef: string;
      readonly via: 'send' | 'ledger' | 'reconciled';
    }
  | { readonly status: 'unsupported'; readonly reason: string };

/**
 * Ledger protocol for external writes (at-least-once, no exactly-once claim):
 * 1. persist intent (pending) — committed before any remote call;
 * 2. if a previous attempt may have reached the provider (sent/unknown), check remote state first;
 * 3. mark sent (committed), then call the provider with no transaction open;
 * 4. record the outcome. Timeouts become "unknown" and are reconciled on the next attempt.
 */
export async function executeExternalWrite(
  ctx: JobContext,
  spec: ExternalWriteSpec,
): Promise<ExternalWriteResult> {
  const { entry } = await ctx.tx((tx) =>
    ledger.beginOperation(tx, {
      targetKind: spec.targetKind,
      targetId: spec.targetId,
      operation: spec.operation,
      idempotencyKey: spec.idempotencyKey,
      request: spec.request,
      jobId: ctx.job.id,
    }),
  );
  if (entry.status === 'succeeded' && entry.external_ref) {
    return { status: 'succeeded', externalRef: entry.external_ref, via: 'ledger' };
  }
  if (entry.status === 'sent' || entry.status === 'unknown') {
    const check = await spec.checkRemote(ctx.signal);
    if ('unsupported' in check) {
      throw new ProviderFailure({
        code: 'permanent',
        message: `Outcome of ${spec.operation} unknown and remote state cannot be checked; manual review required`,
      });
    }
    if (check.found) {
      await ctx.tx((tx) =>
        ledger.recordOperationOutcome(tx, entry.id, {
          status: 'succeeded',
          externalRef: check.externalRef,
        }),
      );
      return { status: 'succeeded', externalRef: check.externalRef, via: 'reconciled' };
    }
  }
  await ctx.tx((tx) => ledger.markOperationSent(tx, entry.id));
  let outcome: OperationOutcome<{ externalRef: string }>;
  try {
    outcome = await spec.send(ctx.signal);
  } catch (e) {
    await ctx.tx((tx) =>
      ledger.recordOperationOutcome(tx, entry.id, {
        status: 'unknown',
        error: { message: e instanceof Error ? e.message : 'error' },
      }),
    );
    throw new ProviderFailure({
      code: 'timeout',
      message: `Outcome of ${spec.operation} unknown; will reconcile before retrying`,
    });
  }
  switch (outcome.status) {
    case 'ok':
      await ctx.tx((tx) =>
        ledger.recordOperationOutcome(tx, entry.id, {
          status: 'succeeded',
          externalRef: outcome.value.externalRef,
        }),
      );
      return { status: 'succeeded', externalRef: outcome.value.externalRef, via: 'send' };
    case 'unknown':
      await ctx.tx((tx) =>
        ledger.recordOperationOutcome(tx, entry.id, {
          status: 'unknown',
          error: { reason: outcome.reason },
        }),
      );
      throw new ProviderFailure({
        code: 'timeout',
        message: `Outcome of ${spec.operation} unknown; will reconcile before retrying`,
      });
    case 'failed':
      await ctx.tx((tx) =>
        ledger.recordOperationOutcome(tx, entry.id, {
          status: 'failed',
          error: { ...outcome.error },
        }),
      );
      throw new ProviderFailure(outcome.error);
    case 'unsupported':
      await ctx.tx((tx) =>
        ledger.recordOperationOutcome(tx, entry.id, {
          status: 'failed',
          error: { reason: outcome.reason },
        }),
      );
      return { status: 'unsupported', reason: outcome.reason };
  }
}
