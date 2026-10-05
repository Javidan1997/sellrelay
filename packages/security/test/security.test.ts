import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AwsKmsKeyWrapper,
  DecryptionError,
  LocalKeyring,
  OutboundUrlError,
  SecretBox,
  credentialAad,
  isBlockedAddress,
  pseudonymize,
  resolvePublicAddress,
  safeRequest,
  secretBoxFromEnv,
  validateOutboundUrl,
  type KmsLike,
} from '../src/index.ts';

const k = () => randomBytes(32).toString('base64');

describe('envelope encryption', () => {
  const k1 = { id: 'k1', key: k() };
  const k2 = { id: 'k2', key: k() };
  const aad = credentialAad('t-1', 'installation', 'i-1', 'shopify_offline_token');

  it('round-trips and never stores plaintext', async () => {
    const box = new SecretBox(new LocalKeyring([k1], 'k1'));
    const env = await box.seal({ accessToken: 'shpat_secret', refreshToken: 'shprt_secret' }, aad);
    expect(JSON.stringify(env)).not.toContain('shpat_secret');
    expect(env.kid).toBe('k1');
    expect(await box.open(env, aad)).toEqual({
      accessToken: 'shpat_secret',
      refreshToken: 'shprt_secret',
    });
  });

  it('binds ciphertext to its owner via AAD (cross-tenant copy fails)', async () => {
    const box = new SecretBox(new LocalKeyring([k1], 'k1'));
    const env = await box.seal({ t: 1 }, aad);
    await expect(
      box.open(env, credentialAad('t-2', 'installation', 'i-1', 'shopify_offline_token')),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('detects tampering', async () => {
    const box = new SecretBox(new LocalKeyring([k1], 'k1'));
    const env = await box.seal({ t: 1 }, aad);
    const ct = Buffer.from(env.ct, 'base64');
    ct[0] = ct[0]! ^ 0xff;
    await expect(box.open({ ...env, ct: ct.toString('base64') }, aad)).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it('rotates keys by re-wrapping the data key', async () => {
    const oldBox = new SecretBox(new LocalKeyring([k1], 'k1'));
    const env = await oldBox.seal({ secret: 'x' }, aad);
    const newBox = new SecretBox(new LocalKeyring([k1, k2], 'k2'));
    expect(newBox.needsRewrap(env)).toBe(true);
    const rotated = await newBox.rewrap(env, aad);
    expect(rotated.kid).toBe('k2');
    expect(rotated.ct).toBe(env.ct);
    expect(await new SecretBox(new LocalKeyring([k2], 'k2')).open(rotated, aad)).toEqual({
      secret: 'x',
    });
  });

  it('wraps data keys with KMS using the AAD as encryption context (mocked KMS)', async () => {
    const seen: Record<string, string>[] = [];
    const fake: KmsLike = {
      async send(cmd) {
        const input = cmd.input as {
          Plaintext?: Uint8Array;
          CiphertextBlob?: Uint8Array;
          EncryptionContext?: Record<string, string>;
        };
        seen.push(input.EncryptionContext ?? {});
        if (input.Plaintext)
          return {
            CiphertextBlob: Buffer.concat([Buffer.from('wrapped:'), Buffer.from(input.Plaintext)]),
          };
        return { Plaintext: Buffer.from(input.CiphertextBlob!).subarray(8) };
      },
    };
    const box = new SecretBox(
      new AwsKmsKeyWrapper('arn:aws:kms:eu-central-1:000000000000:key/test', fake),
    );
    const env = await box.seal({ a: 1 }, aad);
    expect(await box.open(env, aad)).toEqual({ a: 1 });
    expect(seen[0]?.['sellrelay_aad']).toBe(Buffer.from(aad).toString('base64'));
  });

  it('refuses the local keyring in production', () => {
    expect(() => secretBoxFromEnv({ DEPLOY_ENV: 'production', SECRETS_PROVIDER: 'local' })).toThrow(
      /not allowed in production/,
    );
  });
});

describe('SSRF defenses', () => {
  it('accepts only https public hostnames on allowed ports', () => {
    expect(validateOutboundUrl('https://hooks.slack.com/services/T/B/X').hostname).toBe(
      'hooks.slack.com',
    );
    for (const bad of [
      'http://hooks.slack.com/x',
      'https://user:pw@example.com/',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/',
      'https://metadata.google.internal/',
      'https://example.com:8443/',
      'file:///etc/passwd',
    ]) {
      expect(() => validateOutboundUrl(bad), bad).toThrow(OutboundUrlError);
    }
    expect(() =>
      validateOutboundUrl('https://evil.com/', { allowedHosts: ['hooks.slack.com'] }),
    ).toThrow(/Host not allowed/);
    expect(
      validateOutboundUrl('https://shop-1.myshopify.com/admin', {
        allowedHosts: ['.myshopify.com'],
      }).hostname,
    ).toBe('shop-1.myshopify.com');
  });

  it('blocks private, loopback, link-local, metadata and mapped addresses', () => {
    for (const a of [
      '10.1.2.3',
      '172.16.5.4',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      'not-an-ip',
    ]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ['93.184.216.34', '2606:4700::1111'])
      expect(isBlockedAddress(a), a).toBe(false);
  });

  it('rejects hostnames that resolve to private addresses (DNS rebinding defense)', async () => {
    const rebinding = async () => [
      { address: '203.0.113.10', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    await expect(resolvePublicAddress('attacker.example', rebinding)).rejects.toThrow(
      /private or reserved/,
    );
    await expect(
      safeRequest('https://attacker.example/hook', {
        resolver: async () => [{ address: '169.254.169.254', family: 4 }],
      }),
    ).rejects.toThrow(/private or reserved/);
  });
});

describe('pseudonymization', () => {
  it('is deterministic per key and not reversible by inspection', () => {
    expect(pseudonymize('k', 'customer@example.com')).toBe(
      pseudonymize('k', 'customer@example.com'),
    );
    expect(pseudonymize('k', 'customer@example.com')).not.toContain('example');
    expect(pseudonymize('k2', 'customer@example.com')).not.toBe(
      pseudonymize('k', 'customer@example.com'),
    );
  });
});
