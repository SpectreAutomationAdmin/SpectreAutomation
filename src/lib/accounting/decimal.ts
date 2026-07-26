// Money math helpers. Prisma's `Decimal` type returns a Decimal.js instance
// at the runtime boundary; arithmetic stays precise as long as we use these
// helpers rather than `Number()`.
//
// CONVENTION: all monetary values entering the GL pass through `toMoney()` so
// we never accidentally feed in NaN, Infinity, or a string with stray spaces.

import { Prisma } from "@prisma/client";

export type MoneyInput = number | string | Prisma.Decimal | null | undefined;

export const ZERO = new Prisma.Decimal(0);

export function toMoney(v: MoneyInput): Prisma.Decimal {
  if (v == null || v === "") return ZERO;
  if (v instanceof Prisma.Decimal) return v;
  // Reject NaN / Infinity early — they would corrupt running balances silently.
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("Non-finite money value");
    return new Prisma.Decimal(v.toString());
  }
  return new Prisma.Decimal(v);
}

export function eqMoney(a: MoneyInput, b: MoneyInput): boolean {
  return toMoney(a).equals(toMoney(b));
}

export function sumMoney(values: MoneyInput[]): Prisma.Decimal {
  let s = ZERO;
  for (const v of values) s = s.plus(toMoney(v));
  return s;
}

// Money formatter used by services that want a single render path.
// For UI we keep src/lib/finance.ts formatCurrency for consistency with AR
// pages — that helper also accepts Decimal via `.toNumber()` callers.
export function moneyToNumber(v: MoneyInput): number {
  return toMoney(v).toDecimalPlaces(2).toNumber();
}

// "Compare with zero" — short-hand used in posting validation.
export function isZero(v: MoneyInput): boolean {
  return toMoney(v).isZero();
}

export function isPositive(v: MoneyInput): boolean {
  return toMoney(v).gt(0);
}

export function isNegative(v: MoneyInput): boolean {
  return toMoney(v).lt(0);
}
