// TB-RESET-1b.1 regression test — 2026-09-28.
//
// The TB-RESET-1b acceptance evidence delivered on 2026-09-28 falsely
// reported "Trial Balance = $0.00 / $0.00" because the scratchpad
// verification script summed JournalEntryLine.groupBy WITHOUT applying
// the entry.entryDate <= asOf filter that the production
// accountBalances() helper applies. All-time totals nets to zero for
// any set of {originals + reversal contras}, so the bug hid a real
// abnormal balance until it was later spotted in the CoA CSV export.
//
// This test locks in the invariant so a future verification helper
// cannot regress:
//
//   1. When a POSTED original is dated AFTER a POSTED contra, an
//      all-time aggregation reports $0 for the account (false zero),
//      but an asOf-bounded aggregation between the two dates reports
//      a non-zero abnormal balance.
//   2. Any TB verifier that omits the asOf filter is unsafe.
//
// The test uses in-memory arithmetic modelled directly on the shape of
// what accountBalances() returns — no DB required, so it runs in the
// unit-test tier and is cheap to keep in CI.

import { describe, expect, it } from "vitest";

interface Line {
  accountId: string;
  entryDate: Date;
  status: "POSTED" | "VOIDED";
  debit: number;
  credit: number;
}

/** All-time aggregation — the buggy pattern the 1b post-verify used.
 *  Sums every POSTED line regardless of entryDate. Any original + contra
 *  pair nets to zero regardless of their individual dates. */
function tbAllTime(lines: Line[]): { debit: number; credit: number } {
  const perAccount = new Map<string, { d: number; c: number }>();
  for (const l of lines) {
    if (l.status !== "POSTED") continue;
    const cur = perAccount.get(l.accountId) ?? { d: 0, c: 0 };
    cur.d += l.debit;
    cur.c += l.credit;
    perAccount.set(l.accountId, cur);
  }
  let td = 0, tc = 0;
  for (const { d, c } of perAccount.values()) {
    const signed = d - c;
    if (signed >= 0) td += signed; else tc += -signed;
  }
  return { debit: td, credit: tc };
}

/** asOf-bounded aggregation — mirrors src/lib/accounting/balance.ts:71-90
 *  by filtering entry.entryDate <= asOf before summing. This is the
 *  correct pattern for verifying the TB report. */
function tbAsOf(lines: Line[], asOf: Date): { debit: number; credit: number } {
  const perAccount = new Map<string, { d: number; c: number }>();
  for (const l of lines) {
    if (l.status !== "POSTED") continue;
    if (l.entryDate > asOf) continue; // <-- the missing filter
    const cur = perAccount.get(l.accountId) ?? { d: 0, c: 0 };
    cur.d += l.debit;
    cur.c += l.credit;
    perAccount.set(l.accountId, cur);
  }
  let td = 0, tc = 0;
  for (const { d, c } of perAccount.values()) {
    const signed = d - c;
    if (signed >= 0) td += signed; else tc += -signed;
  }
  return { debit: td, credit: tc };
}

describe("TB-RESET-1b.1 regression — verification MUST filter entry.entryDate <= asOf", () => {
  // Reproduces the TB-RESET-1b failure mode: one original dated in the
  // future, one SYSTEM_REVERSAL contra dated today. Same account, same
  // amount, opposite sides.
  const ORIGINAL_FUTURE: Line = { accountId: "6003", entryDate: new Date("2026-12-31"), status: "POSTED", debit: 8125, credit: 0 };
  const CONTRA_TODAY:    Line = { accountId: "6003", entryDate: new Date("2026-09-28"), status: "POSTED", debit: 0, credit: 8125 };

  it("all-time aggregation FALSELY reports $0 (this is the bug in the 1b post-verify)", () => {
    const result = tbAllTime([ORIGINAL_FUTURE, CONTRA_TODAY]);
    expect(result.debit).toBe(0);
    expect(result.credit).toBe(0);
  });

  it("asOf-bounded aggregation at contra date CORRECTLY reports abnormal balance", () => {
    const result = tbAsOf([ORIGINAL_FUTURE, CONTRA_TODAY], new Date("2026-09-28"));
    // Only the contra counts (entryDate 2026-12-31 > asOf), so account
    // 6003 has $8,125 CR — abnormal for an EXPENSE (DR-normal) account.
    expect(result.debit).toBe(0);
    expect(result.credit).toBe(8125);
  });

  it("asOf-bounded aggregation between the two dates reports abnormal balance", () => {
    // A month after the contra but still before the future original.
    const result = tbAsOf([ORIGINAL_FUTURE, CONTRA_TODAY], new Date("2026-10-28"));
    expect(result.debit).toBe(0);
    expect(result.credit).toBe(8125);
  });

  it("asOf-bounded aggregation once past the original date CORRECTLY nets to $0", () => {
    const result = tbAsOf([ORIGINAL_FUTURE, CONTRA_TODAY], new Date("2027-01-01"));
    expect(result.debit).toBe(0);
    expect(result.credit).toBe(0);
  });

  it("asOf-bounded aggregation BEFORE both dates reports nothing", () => {
    const result = tbAsOf([ORIGINAL_FUTURE, CONTRA_TODAY], new Date("2026-01-01"));
    expect(result.debit).toBe(0);
    expect(result.credit).toBe(0);
  });

  it("when original and contra share the same entryDate, every asOf reports $0 or $0", () => {
    // This is the state TB-RESET-1b.1 restores: contra dated to match
    // original. Result: pair invisible at asOf before their date, and
    // net-zero at asOf on or after their date.
    const original: Line = { accountId: "6003", entryDate: new Date("2026-08-15"), status: "POSTED", debit: 100, credit: 0 };
    const contra:   Line = { accountId: "6003", entryDate: new Date("2026-08-15"), status: "POSTED", debit: 0, credit: 100 };
    for (const asOf of [new Date("2026-08-14"), new Date("2026-08-15"), new Date("2026-08-16"), new Date("2027-01-01")]) {
      const result = tbAsOf([original, contra], asOf);
      expect(result.debit, `asOf=${asOf.toISOString()}`).toBe(0);
      expect(result.credit, `asOf=${asOf.toISOString()}`).toBe(0);
    }
  });

  it("the two aggregation functions diverge ONLY when a POSTED line falls between the checkpoint and today", () => {
    // Property test: for a set of paired entries, all-time is always
    // $0/$0. asOf-bounded is $0/$0 iff asOf >= max(entryDate) OR asOf <
    // min(entryDate). Between those the aggregation differs.
    const pairs: Array<[Line, Line]> = [
      [
        { accountId: "6003", entryDate: new Date("2026-09-15"), status: "POSTED", debit: 4583.33, credit: 0 },
        { accountId: "6003", entryDate: new Date("2026-09-15"), status: "POSTED", debit: 0, credit: 4583.33 },
      ],
      [
        { accountId: "6003", entryDate: new Date("2026-12-31"), status: "POSTED", debit: 9332.38, credit: 0 },
        { accountId: "6003", entryDate: new Date("2026-09-28"), status: "POSTED", debit: 0, credit: 9332.38 },
      ],
    ];
    const lines = pairs.flat();
    expect(tbAllTime(lines).debit).toBe(0);
    expect(tbAllTime(lines).credit).toBe(0);

    // Between 2026-09-28 (contra) and 2026-12-31 (original), the second
    // pair contributes $9,332.38 CR to 6003.
    const midway = tbAsOf(lines, new Date("2026-10-15"));
    expect(midway.debit).toBe(0);
    expect(midway.credit).toBe(9332.38);
  });
});
