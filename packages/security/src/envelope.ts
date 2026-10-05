import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for server-side secrets.
 * - A fresh 256-bit data key (DEK) per secret encrypts the payload with AES-256-GCM.
 * - The DEK is wrapped by a key-encryption key (KEK): local keyring (dev/test) or KMS (production).
 * - Additional authenticated data (AAD) binds the ciphertext to its owner row/tenant, so an
 *   envelope copied into another tenant's row fails to decrypt.
 * - `kid` records the KEK version, enabling rotation via `rewrap` without touching plaintext.
 */
export interface Envelope {
  readonly v: 1;
  readonly alg: 'A256GCM';
  readonly kid: string;
  readonly wdek: string;
  readonly iv: string;
  readonly tag: string;
  readonly ct: string;
}

export interface KeyWrapper {
  readonly activeKeyId: string;
  wrap(dek: Buffer, aad: Buffer): Promise<{ keyId: string; wrapped: string }>;
  unwrap(keyId: string, wrapped: string, aad: Buffer): Promise<Buffer>;
}

export class DecryptionError extends Error {
  constructor(message = 'Unable to decrypt secret') {
    super(message);
    this.name = 'DecryptionError';
  }
}

function gcmEncrypt(
  key: Buffer,
  plaintext: Buffer,
  aad: Buffer,
): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

function gcmDecrypt(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, aad: Buffer): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}

/** Local KEK keyring for development and tests. Keys are versioned by id. */
export class LocalKeyring implements KeyWrapper {
  private readonly keys: Map<string, Buffer>;
  readonly activeKeyId: string;

  constructor(keys: readonly { id: string; key: string }[], activeKeyId: string) {
    this.keys = new Map(
      keys.map((k) => {
        const buf = Buffer.from(k.key, 'base64');
        if (buf.length !== 32) throw new Error(`Keyring key ${k.id} must be 32 bytes (base64)`);
        return [k.id, buf];
      }),
    );
    if (!this.keys.has(activeKeyId)) throw new Error(`Active key ${activeKeyId} not in keyring`);
    this.activeKeyId = activeKeyId;
  }

  static fromEnv(json: string | undefined, activeKeyId: string | undefined): LocalKeyring {
    if (!json || !activeKeyId)
      throw new Error(
        'SECRETS_KEYRING and SECRETS_ACTIVE_KEY_ID are required for the local provider',
      );
    return new LocalKeyring(JSON.parse(json) as { id: string; key: string }[], activeKeyId);
  }

  async wrap(dek: Buffer, aad: Buffer): Promise<{ keyId: string; wrapped: string }> {
    const kek = this.keys.get(this.activeKeyId)!;
    const { iv, tag, ct } = gcmEncrypt(kek, dek, aad);
    return { keyId: this.activeKeyId, wrapped: Buffer.concat([iv, tag, ct]).toString('base64') };
  }

  async unwrap(keyId: string, wrapped: string, aad: Buffer): Promise<Buffer> {
    const kek = this.keys.get(keyId);
    if (!kek) throw new DecryptionError(`Unknown key id ${keyId}`);
    const raw = Buffer.from(wrapped, 'base64');
    return gcmDecrypt(kek, raw.subarray(0, 12), raw.subarray(12, 28), raw.subarray(28), aad);
  }
}

export class SecretBox {
  private readonly wrapper: KeyWrapper;

  constructor(wrapper: KeyWrapper) {
    this.wrapper = wrapper;
  }

  async seal(plaintext: unknown, aad: string): Promise<Envelope> {
    const dek = randomBytes(32);
    const aadBuf = Buffer.from(aad, 'utf8');
    try {
      const { iv, tag, ct } = gcmEncrypt(
        dek,
        Buffer.from(JSON.stringify(plaintext), 'utf8'),
        aadBuf,
      );
      const { keyId, wrapped } = await this.wrapper.wrap(dek, aadBuf);
      return {
        v: 1,
        alg: 'A256GCM',
        kid: keyId,
        wdek: wrapped,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ct: ct.toString('base64'),
      };
    } finally {
      dek.fill(0);
    }
  }

  async open<T = unknown>(envelope: Envelope, aad: string): Promise<T> {
    if (envelope.v !== 1 || envelope.alg !== 'A256GCM')
      throw new DecryptionError('Unsupported envelope');
    const aadBuf = Buffer.from(aad, 'utf8');
    const dek = await this.wrapper.unwrap(envelope.kid, envelope.wdek, aadBuf);
    try {
      const pt = gcmDecrypt(
        dek,
        Buffer.from(envelope.iv, 'base64'),
        Buffer.from(envelope.tag, 'base64'),
        Buffer.from(envelope.ct, 'base64'),
        aadBuf,
      );
      return JSON.parse(pt.toString('utf8')) as T;
    } finally {
      dek.fill(0);
    }
  }

  needsRewrap(envelope: Envelope): boolean {
    return envelope.kid !== this.wrapper.activeKeyId;
  }

  /** Key rotation: re-wrap the DEK under the active KEK; ciphertext of the secret is unchanged. */
  async rewrap(envelope: Envelope, aad: string): Promise<Envelope> {
    if (!this.needsRewrap(envelope)) return envelope;
    const aadBuf = Buffer.from(aad, 'utf8');
    const dek = await this.wrapper.unwrap(envelope.kid, envelope.wdek, aadBuf);
    try {
      const { keyId, wrapped } = await this.wrapper.wrap(dek, aadBuf);
      return { ...envelope, kid: keyId, wdek: wrapped };
    } finally {
      dek.fill(0);
    }
  }
}

/** AAD convention binding an envelope to its credential row. */
export function credentialAad(
  tenantId: string,
  ownerKind: string,
  ownerId: string,
  kind: string,
): string {
  return `sellrelay:v1:${tenantId}:${ownerKind}:${ownerId}:${kind}`;
}
