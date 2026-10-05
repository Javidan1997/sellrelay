/**
 * Compare two version markers. Versions are either ISO-8601 timestamps or non-negative
 * integer strings. Returns >0 if a is newer, <0 if older, 0 if equal.
 */
export function compareVersions(a: string, b: string): number {
  const intRe = /^\d+$/;
  if (intRe.test(a) && intRe.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x === y ? 0 : x > y ? 1 : -1;
  }
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) throw new Error(`Incomparable versions: ${a} vs ${b}`);
  return ta === tb ? 0 : ta > tb ? 1 : -1;
}

/** Accept an incoming update only if it is strictly newer than what was last applied. */
export function isNewerVersion(incoming: string, current: string | null | undefined): boolean {
  if (current === null || current === undefined) return true;
  return compareVersions(incoming, current) > 0;
}

/** Convert an ISO timestamp to a sortable integer version (epoch ms). */
export function timestampVersion(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp: ${iso}`);
  return String(ms);
}
