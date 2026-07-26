// Display helpers for the accounting UI. Keeping these out of components
// makes them straightforward to unit-test and prevents one-off `Number(decimal)`
// calls scattered across pages.

import { Prisma } from "@prisma/client";
import { toMoney, type MoneyInput } from "./decimal";

export function fmtMoney(v: MoneyInput, opts?: { showZero?: boolean; parens?: boolean }): string {
  const d = toMoney(v);
  if (!opts?.showZero && d.isZero()) return "—";
  const abs = d.abs().toFixed(2);
  const formatted = "$" + addThousands(abs);
  if (d.lt(0)) return opts?.parens ? `(${formatted})` : `-${formatted}`;
  return formatted;
}

export function fmtMoneyAlways(v: MoneyInput): string {
  return fmtMoney(v, { showZero: true });
}

function addThousands(s: string): string {
  const [whole, dec] = s.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (dec ? "." + dec : "");
}

// Convert a Decimal to a plain JS number for serialization across server →
// client boundaries (e.g. tRPC). Loses precision past 15 digits — only use
// for display values, never re-aggregation.
export function decToNumber(v: Prisma.Decimal | number | string): number {
  return Number(v.toString());
}
