import { ConfigError } from "./errors.ts";

/**
 * bKash sends and receives amounts as decimal strings ("4.59", "500"). Parsing
 * those to a JS number and adding them up is how refunds end up a poisha off,
 * so everything here works in integer poisha (1 BDT = 100 poisha) and only
 * formats back to a string at the edge.
 */

const AMOUNT_RE = /^-?\d+(\.\d{1,2})?$/;

/** Parse a BDT decimal string or number into integer poisha. */
export function toPoisha(amount: string | number): bigint {
  const text = typeof amount === "number" ? formatNumber(amount) : amount.trim();
  if (!AMOUNT_RE.test(text)) {
    throw new ConfigError(
      `Invalid BDT amount ${JSON.stringify(amount)}: expected a decimal with at most 2 places, e.g. "12.50".`,
      { code: "invalid_amount" },
    );
  }
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const poisha = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -poisha : poisha;
}

/** Format integer poisha back into the 2-decimal string the gateway expects. */
export function fromPoisha(poisha: bigint): string {
  const negative = poisha < 0n;
  const abs = negative ? -poisha : poisha;
  const whole = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Normalise any accepted amount into the canonical "123.45" form.
 * Use this on every amount before it goes into a request body.
 */
export function toAmountString(amount: string | number): string {
  return fromPoisha(toPoisha(amount));
}

/** -1, 0 or 1 — a total order on amounts that does not go through floats. */
export function compareAmount(a: string | number, b: string | number): -1 | 0 | 1 {
  const left = toPoisha(a);
  const right = toPoisha(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function addAmount(a: string | number, b: string | number): string {
  return fromPoisha(toPoisha(a) + toPoisha(b));
}

export function subtractAmount(a: string | number, b: string | number): string {
  return fromPoisha(toPoisha(a) - toPoisha(b));
}

/** Sum a list of amounts. Useful for checking partial refunds against a total. */
export function sumAmounts(amounts: Array<string | number>): string {
  return fromPoisha(amounts.reduce<bigint>((total, a) => total + toPoisha(a), 0n));
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new ConfigError(`Invalid BDT amount ${value}: not a finite number.`, { code: "invalid_amount" });
  }
  return value.toFixed(2);
}
