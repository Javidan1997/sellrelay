import { ProviderFailure, type OperationOutcome } from '@sellrelay/core';

/** Unwrap an adapter outcome, converting failures into ProviderFailure for job classification. */
export function unwrap<T>(o: OperationOutcome<T>, what: string): T {
  switch (o.status) {
    case 'ok':
      return o.value;
    case 'failed':
      throw new ProviderFailure(o.error);
    case 'unknown':
      throw new ProviderFailure({
        code: 'timeout',
        message: `${what}: outcome unknown (${o.reason})`,
      });
    case 'unsupported':
      throw new ProviderFailure({
        code: 'permanent',
        message: `${what}: unsupported (${o.reason})`,
      });
  }
}
