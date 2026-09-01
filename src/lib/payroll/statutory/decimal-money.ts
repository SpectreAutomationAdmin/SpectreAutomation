// Payroll-3B-5B-2b (2026-09-01) — canonical Decimal money helpers.
//
// EVERY dollar amount the Payroll calculator produces flows through
// these helpers. JavaScript binary floating point (Number,
// parseFloat, *, /, Math.round) is FORBIDDEN in statutory arithmetic.
//
// The helpers are thin wrappers over Prisma's Decimal (which is
// Decimal.js under the hood) so they compose cleanly with what
// Prisma already emits for Decimal columns.
//
// Rounding rules used everywhere:
//   • Cent rounding = HALF_UP to 2 decimal places
//     (matches Package.rounding.mode set by the H1/H2 packages).
//   • Intermediate arithmetic stays UNROUNDED (Decimal 30 dp
//     internal precision) until the final cent-round on the line
//     the DB persists — never round every step "because the column
//     stores two decimals".

import { Decimal } from "@prisma/client/runtime/library";

export { Decimal };

/** The canonical two-decimal HALF_UP round used for every Payroll cent. */
export function roundCentsHalfUp(value: Decimal | string | number): Decimal {
  return toDecimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Convert an arbitrary numeric input into a Decimal without JS float drift. */
export function toDecimal(value: Decimal | string | number | null | undefined): Decimal {
  if (value == null) return new Decimal(0);
  if (value instanceof Decimal) return value;
  if (typeof value === "number") {
    // Route numbers through String() so we never introduce binary
    // rounding artefacts. Callers should already avoid raw numbers.
    return new Decimal(String(value));
  }
  return new Decimal(value);
}

/** max(0, value) — used to floor statutory sub-expressions at zero. */
export function nonNegative(value: Decimal): Decimal {
  return value.lt(0) ? new Decimal(0) : value;
}

/** Persist as a two-decimal HALF_UP string suitable for a Prisma Decimal write. */
export function toCentString(value: Decimal | string | number): string {
  return roundCentsHalfUp(value).toFixed(2);
}

/** Sum an array of Decimals safely (no reduce-into-JS-number path). */
export function sum(values: Array<Decimal | string | number>): Decimal {
  let acc = new Decimal(0);
  for (const v of values) acc = acc.plus(toDecimal(v));
  return acc;
}
