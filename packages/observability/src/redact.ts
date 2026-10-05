/**
 * PII and secret redaction for logs, traces, exports and fixtures.
 * Keys are matched case-insensitively; values in free text are scrubbed by pattern.
 */
const SECRET_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'client_secret',
  'clientsecret',
  'password',
  'secret',
  'api_key',
  'apikey',
  'token',
  'id_token',
  'session_token',
  'x-shopify-hmac-sha256',
  'x-shopify-access-token',
  'envelope',
  'private_key',
];
const PII_KEYS = [
  'email',
  'phone',
  'first_name',
  'last_name',
  'firstname',
  'lastname',
  'address1',
  'address2',
  'address',
  'zip',
  'postal_code',
  'postalcode',
  'city',
  'company',
  'customer',
  'billing_address',
  'shipping_address',
  'ip',
  'browser_ip',
  'note',
  'contact_email',
  'phone_number',
];

const SECRET_SET = new Set(SECRET_KEYS);
const PII_SET = new Set(PII_KEYS);

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const SHOPIFY_TOKEN_RE = /\bshp(at|ca|pa|ss|rt)_[A-Za-z0-9]+/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

export const REDACTED = '[REDACTED]';

export function redactText(text: string): string {
  return text
    .replace(BEARER_RE, '$1 [REDACTED]')
    .replace(SHOPIFY_TOKEN_RE, REDACTED)
    .replace(JWT_RE, REDACTED)
    .replace(EMAIL_RE, '[EMAIL]')
    .replace(PHONE_RE, '[PHONE]');
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = k.toLowerCase();
      if (SECRET_SET.has(key)) out[k] = REDACTED;
      else if (PII_SET.has(key)) out[k] = v === null || v === undefined ? v : '[PII]';
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
