import { describe, expect, it } from 'vitest';
import { addMoney, formatMoney, parseMoney } from '../src/index.ts';

describe('money', () => {
  it('parses decimal strings into integer minor units without floats', () => {
    expect(parseMoney('19.99', 'EUR')).toEqual({ amountMinor: 1999n, currency: 'EUR' });
    expect(parseMoney('0.1', 'EUR').amountMinor + parseMoney('0.2', 'EUR').amountMinor).toBe(30n);
    expect(parseMoney('1500', 'JPY')).toEqual({ amountMinor: 1500n, currency: 'JPY' });
    expect(parseMoney('1.234', 'KWD').amountMinor).toBe(1234n);
    expect(parseMoney('-5.50', 'PLN').amountMinor).toBe(-550n);
    expect(parseMoney('10.500', 'EUR').amountMinor).toBe(1050n);
  });

  it('rejects excess precision and malformed input', () => {
    expect(() => parseMoney('1.005', 'EUR')).toThrow(/precision/);
    expect(() => parseMoney('1e3', 'EUR')).toThrow(/Invalid/);
    expect(() => parseMoney('12', 'XXX')).toThrow(/Unsupported currency/);
  });

  it('formats and adds', () => {
    expect(formatMoney({ amountMinor: 5n, currency: 'EUR' })).toBe('0.05');
    expect(formatMoney({ amountMinor: -12345n, currency: 'EUR' })).toBe('-123.45');
    expect(formatMoney(addMoney(parseMoney('0.10', 'EUR'), parseMoney('0.20', 'EUR')))).toBe(
      '0.30',
    );
    expect(() => addMoney(parseMoney('1', 'EUR'), parseMoney('1', 'USD'))).toThrow(/mismatch/);
  });
});
