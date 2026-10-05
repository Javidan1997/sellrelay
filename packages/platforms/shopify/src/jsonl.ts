import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { ProviderFailure } from '@sellrelay/core';
import { assertNoOpenTransaction } from '@sellrelay/observability';
import { validateOutboundUrl } from '@sellrelay/security';
import type { FetchLike } from './http.ts';

/**
 * Stream a bulk-operation JSONL result line by line (constant memory). `fromLine` skips lines
 * already committed by a previous run so imports resume from their checkpoint.
 * The URL comes from Shopify's API response; it is still validated (https, public host).
 */
export async function* readJsonlLines(
  url: string,
  fromLine: number,
  opts: { fetch?: FetchLike; signal?: AbortSignal } = {},
): AsyncGenerator<{ line: number; value: Record<string, unknown> }> {
  assertNoOpenTransaction('bulk JSONL download');
  validateOutboundUrl(url);
  const res = await (opts.fetch ?? fetch)(url, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    redirect: 'follow',
  });
  if (res.status === 403 || res.status === 404 || res.status === 410) {
    throw new ProviderFailure({
      code: 'not_found',
      httpStatus: res.status,
      message: 'Bulk result URL expired or unavailable',
    });
  }
  if (!res.ok || !res.body)
    throw new ProviderFailure({
      code: 'transient',
      httpStatus: res.status,
      message: 'Bulk result download failed',
    });
  const rl = createInterface({ input: Readable.fromWeb(res.body as never), crlfDelay: Infinity });
  let line = 0;
  for await (const text of rl) {
    if (text.trim() === '') continue;
    const current = line++;
    if (current < fromLine) continue;
    yield { line: current, value: JSON.parse(text) as Record<string, unknown> };
  }
}
