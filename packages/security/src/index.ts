export * from './envelope.ts';
export * from './kms.ts';
export * from './ssrf.ts';
export * from './hashing.ts';

import { LocalKeyring, SecretBox, type KeyWrapper } from './envelope.ts';
import { AwsKmsKeyWrapper } from './kms.ts';

/** Build the configured secret box. Production must use `aws-kms`. */
export function secretBoxFromEnv(env: NodeJS.ProcessEnv = process.env): SecretBox {
  const provider = env['SECRETS_PROVIDER'] ?? 'local';
  let wrapper: KeyWrapper;
  if (provider === 'aws-kms') {
    const keyId = env['SECRETS_KMS_KEY_ID'];
    if (!keyId) throw new Error('SECRETS_KMS_KEY_ID is required for aws-kms');
    wrapper = new AwsKmsKeyWrapper(keyId, undefined, env['AWS_REGION']);
  } else if (provider === 'local') {
    if (env['DEPLOY_ENV'] === 'production')
      throw new Error('Local keyring is not allowed in production');
    wrapper = LocalKeyring.fromEnv(env['SECRETS_KEYRING'], env['SECRETS_ACTIVE_KEY_ID']);
  } else {
    throw new Error(`Unknown SECRETS_PROVIDER ${provider}`);
  }
  return new SecretBox(wrapper);
}
