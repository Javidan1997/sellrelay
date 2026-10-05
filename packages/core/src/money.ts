/**
 * Money is represented as integer minor units (bigint) plus ISO 4217 currency metadata.
 * Floating-point arithmetic is never used for monetary values.
 */
export type CurrencyCode = string;

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

/** ISO 4217 minor-unit exponents for currencies relevant to planned channels. */
const MINOR_UNITS: Readonly<Record<string, number>> = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  PLN: 2,
  CZK: 2,
  HUF: 2,
  SEK: 2,
  DKK: 2,
  NOK: 2,
  CHF: 2,
  RON: 2,
  BGN: 2,
  TRY: 2,
  CAD: 2,
  AUD: 2,
  MXN: 2,
  BRL: 2,
  INR: 2,
  CNY: 2,
  SGD: 2,
  AED: 2,
  JPY: 0,
  KRW: 0,
  ISK: 0,
  CLP: 0,
  KWD: 3,
  BHD: 3,
  JOD: 3,
  OMR: 3,
  TND: 3,
};

export function minorUnitsFor(currency: CurrencyCode): number {
  const exp = MINOR_UNITS[currency.toUpperCase()];
  if (exp === undefined) throw new Error(`Unsupported currency: ${currency}`);
  return exp;
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parse a decimal string (e.g. "19.99") into minor units without floating point.
 * Rejects values with more fractional digits than the currency supports unless they are zeros.
 */
export function parseMoney(decimal: string, currency: CurrencyCode): Money {
  const match = DECIMAL_RE.exec(decimal.trim());
  if (!match) throw new Error(`Invalid decimal amount: ${decimal}`);
  const [, sign, whole = '0', fraction = ''] = match;
  const exp = minorUnitsFor(currency);
  const extra = fraction.slice(exp);
  if (extra.length > 0 && /[^0]/.test(extra)) {
    throw new Error(`Amount ${decimal} has more precision than ${currency} supports`);
  }
  const frac = fraction.slice(0, exp).padEnd(exp, '0');
  const minor = BigInt(whole) * 10n ** BigInt(exp) + (exp > 0 ? BigInt(frac) : 0n);
  return { amountMinor: sign ? -minor : minor, currency: currency.toUpperCase() };
}

export function formatMoney(money: Money): string {
  const exp = minorUnitsFor(money.currency);
  const negative = money.amountMinor < 0n;
  const abs = negative ? -money.amountMinor : money.amountMinor;
  if (exp === 0) return `${negative ? '-' : ''}${abs.toString()}`;
  const base = 10n ** BigInt(exp);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(exp, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error('Currency mismatch');
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}
