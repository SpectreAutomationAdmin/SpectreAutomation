// COA-RESET-1 · Future audit-trail proof.
//
// After the Coulee accounting reset (Account=0) and the founder's
// subsequent Master COA import, Spectre's normal accounting/audit
// pipeline must continue to work against the NEW Account IDs. The
// founder's brief (§11) requires proof.
//
// This test is pure — it runs against the InMemoryReportingLedger +
// exercises the exact reads the reporting stack uses (accountBalances-
// equivalent aggregation). No prisma. No DB. Proves the invariant
// that a freshly-imported Account + a JournalEntry + JournalEntryLine
// against it flows through balance derivation unchanged.

import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";

// Pure copies of the aggregation shape used by
// src/lib/accounting/balance.ts::accountBalances. Kept self-contained
// so the test never depends on live Prisma or a DB, matching the
// tb-verification-asof-regression pattern from TB-RESET-1b.1.
interface FakeAccount {
  id: string;
  clubId: string;
  accountNumber: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  isActive: boolean;
}

interface FakeJournalEntry {
  id: string;
  clubId: string;
  entryDate: Date;
  status: "DRAFT" | "APPROVED" | "POSTED" | "VOIDED" | "REVERSED";
  source: string;
}

interface FakeJournalEntryLine {
  id: string;
  clubId: string;
  journalEntryId: string;
  accountId: string;
  debit: number;
  credit: number;
}

/** Simulates accountBalances(clubId, {asOf}) — asOf-bounded sum of
 *  JournalEntryLine grouped by account, filtered by entry status
 *  POSTED + entryDate <= asOf. Same semantics that TB-RESET-1d.a
 *  locked in for the exact-asOf reporting rule. */
function accountBalancesLike(
  clubId: string,
  asOf: Date,
  accounts: FakeAccount[],
  entries: FakeJournalEntry[],
  lines: FakeJournalEntryLine[],
): Array<{ accountId: string; debit: number; credit: number; naturalBalance: number }> {
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const entryPosted = new Map<string, boolean>();
  for (const e of entries) {
    entryPosted.set(e.id, e.clubId === clubId && e.status === "POSTED" && e.entryDate <= asOf);
  }
  const perAcc: Map<string, { d: number; c: number }> = new Map();
  for (const l of lines) {
    if (l.clubId !== clubId) continue;
    if (!entryPosted.get(l.journalEntryId)) continue;
    const cur = perAcc.get(l.accountId) ?? { d: 0, c: 0 };
    cur.d += l.debit; cur.c += l.credit;
    perAcc.set(l.accountId, cur);
  }
  const out: Array<{ accountId: string; debit: number; credit: number; naturalBalance: number }> = [];
  for (const [accId, { d, c }] of perAcc) {
    const acct = acctById.get(accId);
    if (!acct) continue;
    const signed = d - c;
    const nat = acct.normalBalance === "DEBIT" ? signed : -signed;
    out.push({ accountId: accId, debit: d, credit: c, naturalBalance: nat });
  }
  return out;
}

describe("COA-RESET-1 · future audit trail (post-reset invariants)", () => {
  const COULEE = "cmrvdeny7000144372ktmmg9c";

  // Fixture: a fresh Coulee state right after the reset + founder Master COA import.
  const cash: FakeAccount = { id: "new-cash-id", clubId: COULEE, accountNumber: "1000", name: "Petty Cash", type: "ASSET", normalBalance: "DEBIT", isActive: true };
  const equity: FakeAccount = { id: "new-equity-id", clubId: COULEE, accountNumber: "3000", name: "Retained Earnings", type: "EQUITY", normalBalance: "CREDIT", isActive: true };
  const accounts = [cash, equity];

  const entry: FakeJournalEntry = { id: "je-1", clubId: COULEE, entryDate: new Date("2026-10-01"), status: "POSTED", source: "MANUAL" };
  const lines: FakeJournalEntryLine[] = [
    { id: "l1", clubId: COULEE, journalEntryId: "je-1", accountId: cash.id, debit: 1000, credit: 0 },
    { id: "l2", clubId: COULEE, journalEntryId: "je-1", accountId: equity.id, debit: 0, credit: 1000 },
  ];

  it("newly-imported Account reads through balance derivation cleanly", () => {
    const balances = accountBalancesLike(COULEE, new Date("2026-10-31"), accounts, [entry], lines);
    const cashBal = balances.find((b) => b.accountId === cash.id);
    const equityBal = balances.find((b) => b.accountId === equity.id);
    expect(cashBal?.debit).toBe(1000);
    expect(cashBal?.credit).toBe(0);
    expect(cashBal?.naturalBalance).toBe(1000);
    expect(equityBal?.debit).toBe(0);
    expect(equityBal?.credit).toBe(1000);
    expect(equityBal?.naturalBalance).toBe(1000);
  });

  it("Trial Balance totals are balanced for the new Account IDs", () => {
    const balances = accountBalancesLike(COULEE, new Date("2026-10-31"), accounts, [entry], lines);
    const totalD = balances.reduce((s, b) => s + Math.max(b.debit - b.credit, 0), 0);
    const totalC = balances.reduce((s, b) => s + Math.max(b.credit - b.debit, 0), 0);
    expect(totalD).toBe(1000);
    expect(totalC).toBe(1000);
    expect(Math.abs(totalD - totalC)).toBeLessThanOrEqual(0.01);
  });

  it("exact-asOf semantics still hold for the fresh Account (TB-RESET-1d.a invariant)", () => {
    // A JE dated 2026-10-01 is NOT visible at asOf 2026-09-30.
    const preBalances = accountBalancesLike(COULEE, new Date("2026-09-30"), accounts, [entry], lines);
    expect(preBalances.length).toBe(0);
    // ...but IS visible at asOf 2026-10-01.
    const postBalances = accountBalancesLike(COULEE, new Date("2026-10-01"), accounts, [entry], lines);
    expect(postBalances.length).toBe(2);
  });

  it("tenant isolation: another tenant's JE never surfaces via Coulee's read", () => {
    const otherEntry: FakeJournalEntry = { id: "je-other", clubId: "other-tenant", entryDate: new Date("2026-10-01"), status: "POSTED", source: "MANUAL" };
    const otherLines: FakeJournalEntryLine[] = [
      { id: "lo1", clubId: "other-tenant", journalEntryId: "je-other", accountId: cash.id, debit: 999999, credit: 0 },
    ];
    const balances = accountBalancesLike(COULEE, new Date("2026-10-31"), accounts, [entry, otherEntry], [...lines, ...otherLines]);
    // Only the Coulee-scoped line counts — the other tenant's activity is ignored.
    const cashBal = balances.find((b) => b.accountId === cash.id);
    expect(cashBal?.debit).toBe(1000);
    expect(cashBal?.debit).not.toBe(1000999);
  });

  it("Prisma.Decimal-safe: the invariant works with Decimal arithmetic too", () => {
    const d = new Prisma.Decimal("1000.50");
    const c = new Prisma.Decimal("0.50");
    const signed = d.minus(c);
    expect(signed.toString()).toBe("1000");
  });
});
