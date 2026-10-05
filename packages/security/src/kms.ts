import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import type { KeyWrapper } from './envelope.ts';
import { DecryptionError } from './envelope.ts';

/** Minimal surface used from the AWS SDK so tests can inject a fake. */
export interface KmsLike {
  send(
    command: EncryptCommand | DecryptCommand,
  ): Promise<{ CiphertextBlob?: Uint8Array; Plaintext?: Uint8Array; KeyId?: string }>;
}

/**
 * Production KEK provider: AWS KMS Encrypt/Decrypt wrap each DEK, with the AAD passed as the
 * KMS encryption context. Key rotation is handled by KMS key versions/aliases; `kid` stores the
 * key ARN used. Verified against a mocked KMS client only (see SECURITY.md).
 */
export class AwsKmsKeyWrapper implements KeyWrapper {
  readonly activeKeyId: string;
  private readonly client: KmsLike;

  constructor(keyId: string, client?: KmsLike, region?: string) {
    this.activeKeyId = keyId;
    this.client = client ?? (new KMSClient(region ? { region } : {}) as unknown as KmsLike);
  }

  private context(aad: Buffer): Record<string, string> {
    return { sellrelay_aad: aad.toString('base64') };
  }

  async wrap(dek: Buffer, aad: Buffer): Promise<{ keyId: string; wrapped: string }> {
    const out = await this.client.send(
      new EncryptCommand({
        KeyId: this.activeKeyId,
        Plaintext: dek,
        EncryptionContext: this.context(aad),
      }),
    );
    if (!out.CiphertextBlob) throw new Error('KMS returned no ciphertext');
    return { keyId: this.activeKeyId, wrapped: Buffer.from(out.CiphertextBlob).toString('base64') };
  }

  async unwrap(keyId: string, wrapped: string, aad: Buffer): Promise<Buffer> {
    try {
      const out = await this.client.send(
        new DecryptCommand({
          KeyId: keyId,
          CiphertextBlob: Buffer.from(wrapped, 'base64'),
          EncryptionContext: this.context(aad),
        }),
      );
      if (!out.Plaintext) throw new Error('no plaintext');
      return Buffer.from(out.Plaintext);
    } catch {
      throw new DecryptionError();
    }
  }
}
