/**
 * Integer-money helpers for the Business Account kernel.
 *
 * All values are in USDC 6-decimal units (bigint).
 * Divides ALL demo monetary amounts by 1000 for on-chain amounts per spec:
 *   - "Full" scenario amounts are the canonical description.
 *   - On-chain amounts divide by 1000 (not quantities or IDs).
 *
 * Import from here for all money arithmetic and display.
 * Never import raw parseUnits / formatUnits on a money path.
 */

import { parseUsdc, formatUsdc } from '@/onchain-money';
import { USDC_DECIMALS as _USDC_DECIMALS } from '@/onchain-facts';

export const USDC_DECIMALS = _USDC_DECIMALS;

/** Parse a human decimal USDC string to 6-dec integer units. */
export function parseMoney(value: string): bigint {
  return parseUsdc(value);
}

/** Format 6-dec integer units to human decimal string (e.g. "6.5"). */
export function formatMoney(raw: bigint): string {
  return formatUsdc(raw);
}

/** Format with a fixed number of fraction digits (e.g. for display). */
export function formatMoneyFixed(raw: bigint, digits = 6): string {
  const s = formatMoney(raw);
  const [whole, fraction = ''] = s.split('.');
  const frac = fraction.padEnd(digits, '0').slice(0, digits);
  return `${whole}.${frac}`;
}

/**
 * Scale a "full scenario" amount (in whole USDC) to the on-chain demo amount
 * by dividing by 1000. Quantities and IDs are NOT scaled.
 *
 * Example: fullScenarioUsdc("900") → parseMoney("0.9") → 900_000n (6-dec units)
 */
export function demoAmount(wholeUsdc: string): bigint {
  // Convert whole number to 6-dec units then divide by 1000.
  const raw = parseUsdc(wholeUsdc + '.000000');
  return raw / 1000n;
}

/**
 * Scale a pre-parsed 6-dec USDC amount (scenario scale) to demo scale (/1000).
 * Use when the scenario amount is already in raw bigint form.
 */
export function toDemoScale(rawAmount: bigint): bigint {
  return rawAmount / 1000n;
}

/** Display a raw 6-dec amount as "0.000000 USDC" with full precision. */
export function displayUsdc(raw: bigint): string {
  return formatMoneyFixed(raw, 6) + ' USDC';
}

/** Display a raw 6-dec amount compactly: drop trailing zeros after decimal. */
export function displayUsdcCompact(raw: bigint): string {
  return formatMoney(raw) + ' USDC';
}

/** Returns true if a >= b (both in same decimal units). */
export function gte(a: bigint, b: bigint): boolean {
  return a >= b;
}

/** Returns true if a + b would not overflow a reasonable on-chain cap (2^128). */
export function safeAdd(a: bigint, b: bigint): bigint {
  const result = a + b;
  const MAX_U128 = (1n << 128n) - 1n;
  if (result > MAX_U128) throw new RangeError('Amount overflow (> 2^128)');
  return result;
}
