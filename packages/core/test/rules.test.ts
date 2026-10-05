import { describe, expect, it } from 'vitest';
import {
  FREE_PLAN,
  NO_ENTITLEMENTS,
  compareVersions,
  computeBackoffMs,
  evaluateSyncPermission,
  hasFeature,
  isNewerVersion,
  parseRetryAfter,
  type Entitlements,
} from '../src/index.ts';

describe('backoff', () => {
  it('grows exponentially with full jitter and caps at max', () => {
    const max = () => 0.999999;
    expect(computeBackoffMs(1, { baseMs: 1000, maxMs: 60_000 }, undefined, max)).toBeLessThan(1000);
    expect(computeBackoffMs(4, { baseMs: 1000, maxMs: 60_000 }, undefined, max)).toBeLessThan(8000);
    expect(computeBackoffMs(4, { baseMs: 1000, maxMs: 60_000 }, undefined, max)).toBeGreaterThan(
      7000,
    );
    expect(
      computeBackoffMs(30, { baseMs: 1000, maxMs: 60_000 }, undefined, max),
    ).toBeLessThanOrEqual(60_000);
  });

  it('never retries before Retry-After', () => {
    for (let i = 0; i < 50; i++) {
      expect(computeBackoffMs(1, { baseMs: 1000, maxMs: 5000 }, 30_000)).toBeGreaterThanOrEqual(
        30_000,
      );
    }
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('1.5')).toBe(1500);
    const now = new Date('2026-10-05T00:00:00Z');
    expect(parseRetryAfter('Mon, 05 Oct 2026 00:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('garbage')).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

describe('versioning', () => {
  it('compares integer and timestamp versions', () => {
    expect(compareVersions('10', '9')).toBe(1);
    expect(compareVersions('2026-10-05T10:00:00Z', '2026-10-05T10:00:01Z')).toBe(-1);
    expect(isNewerVersion('2026-10-05T10:00:00Z', null)).toBe(true);
    expect(isNewerVersion('2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z')).toBe(false);
    expect(() => compareVersions('abc', '1')).toThrow();
  });
});

describe('sync activation', () => {
  const active: Entitlements = {
    ...NO_ENTITLEMENTS,
    status: 'active',
    features: ['inventory_sync'],
    planKey: 'pro',
  };
  const base = {
    connection: {
      state: 'connected' as const,
      syncEnabled: true,
      activatedAt: 'x',
      initialPreviewCompletedAt: 'x',
    },
    installationActive: true,
    entitlements: active,
    killSwitchActive: false,
  };

  it('allows sync only when every precondition holds', () => {
    expect(evaluateSyncPermission(base)).toEqual({ allowed: true });
  });

  it('a successful connection alone does not enable sync', () => {
    const r = evaluateSyncPermission({
      ...base,
      connection: {
        state: 'connected',
        syncEnabled: false,
        activatedAt: null,
        initialPreviewCompletedAt: null,
      },
    });
    expect(r).toEqual({ allowed: false, reason: 'preview_required' });
    expect(
      evaluateSyncPermission({ ...base, connection: { ...base.connection, activatedAt: null } }),
    ).toEqual({ allowed: false, reason: 'not_activated' });
  });

  it('blocks on kill switch, uninstall, expiry and missing entitlement', () => {
    expect(evaluateSyncPermission({ ...base, killSwitchActive: true })).toMatchObject({
      reason: 'kill_switch',
    });
    expect(evaluateSyncPermission({ ...base, installationActive: false })).toMatchObject({
      reason: 'installation_inactive',
    });
    expect(
      evaluateSyncPermission({ ...base, connection: { ...base.connection, state: 'expired' } }),
    ).toMatchObject({ reason: 'not_connected' });
    expect(evaluateSyncPermission({ ...base, entitlements: NO_ENTITLEMENTS })).toMatchObject({
      reason: 'not_entitled',
    });
  });

  it('entitlement checks fail closed', () => {
    expect(hasFeature({ ...active, status: 'unknown' }, 'inventory_sync')).toBe(false);
    expect(hasFeature({ ...active, status: 'frozen' }, 'inventory_sync')).toBe(false);
    expect(FREE_PLAN.features).not.toContain('inventory_sync');
  });
});
