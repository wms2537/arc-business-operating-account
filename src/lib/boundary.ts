import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw Error("Expected an object");
  return Object.fromEntries<unknown>(Object.entries(value));
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw Error("Expected text");
  return value;
}
export function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw Error("Expected a nonnegative safe integer");
  return value;
}
export function uint(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))
    return BigInt(value);
  throw Error("Expected a nonnegative decimal integer");
}
export function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value))
    throw Error("Invalid address");
  return getAddress(value);
}
export function hex(value: unknown): Hex {
  if (typeof value !== "string" || !isHex(value) || value.length % 2 !== 0)
    throw Error("Invalid hex bytes");
  return value;
}
export function hash(value: unknown): Hex {
  const h = hex(value);
  if (h.length !== 66) throw Error("Expected 32-byte hash");
  return h;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error("Expected array");
  return value;
}
export function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw Error("Expected boolean");
  return value;
}
export const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();
export function json(value: unknown): string {
  return JSON.stringify(value, (_: string, v: unknown): unknown =>
    typeof v === "bigint" ? v.toString() : v,
  );
}
export function parseMoney(
  value: string,
  { allowZero = false }: { allowZero?: boolean } = {},
): bigint {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value))
    throw Error("Enter USDC with at most six decimal places");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  if (!allowZero && amount === 0n)
    throw Error("Amount must be greater than zero");
  return amount;
}
export function money(value: bigint | string): string {
  const n = BigInt(value),
    negative = n < 0n,
    a = negative ? -n : n;
  return `${negative ? "-" : ""}${a / 1000000n}.${(a % 1000000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0")}`;
}
