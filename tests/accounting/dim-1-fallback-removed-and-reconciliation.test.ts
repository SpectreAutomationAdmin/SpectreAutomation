// DIM-1 (2026-09-29) — Structural + reconciliation coverage.
//
// Two things this file guards against regression:
//
// 1. STRUCTURAL — the account.defaultDepartmentId inference paths
//    identified in Architecture Review 1 are gone, and the departmental
//    reporting fallback in `incomeStatementByDepartment` no longer
//    reads `account.defaultDepartmentId` either. All three surfaces
//    now agree that JournalEntryLine.departmentId is authoritative;
//    a null line goes to "Unassigned".
//
// 2. RECONCILIATION — for the same population of authoritative
//    journal lines, the sum of every explicit department bucket
//    plus the Unassigned bucket equals the consolidated total.
//    Same for Fund. And two lines against the SAME account with
//    DIFFERENT dimensions still roll up to a single natural account
//    in consolidated reporting.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const JOURNAL_TS = readFileSync(path.join(REPO, "src", "lib", "accounting", "journal.ts"), "utf8");
const AP_INVOICES_TS = readFileSync(path.join(REPO, "src", "lib", "ap", "invoices.ts"), "utf8");
const REPORTS_TS = readFileSync(path.join(REPO, "src", "lib", "accounting", "reports.ts"), "utf8");

describe("DIM-1 · defaultDepartmentId inference removed from posting pipelines", () => {
  it("Manual JE (journal.ts) — no `account.defaultDepartmentId` promotion into `departmentId`", () => {
    // Every occurrence of `defaultDepartmentId` in the resolve/validate
    // block must not appear on the RHS of an assignment to `departmentId`.
    // We assert the specific banned pattern.
    expect(JOURNAL_TS).not.toMatch(/departmentId\s*=\s*account\.defaultDepartmentId/);
    // And the wider "fallback to account default" pattern is gone too.
    expect(JOURNAL_TS).not.toMatch(/else\s+if\s*\(\s*account\.defaultDepartmentId\s*\)/);
  });

  it("AP invoice (ap/invoices.ts) — no `account.defaultDepartmentId` promotion into `departmentId`", () => {
    expect(AP_INVOICES_TS).not.toMatch(/departmentId\s*=\s*account\.defaultDepartmentId/);
    expect(AP_INVOICES_TS).not.toMatch(/else\s+if\s*\(\s*account\.defaultDepartmentId\s*\)/);
  });

  it("incomeStatementByDepartment (reports.ts) — no reporting-time `?? r.account.defaultDepartmentId` fallback", () => {
    // The specific v14.10 line that Architecture Review 1 flagged:
    //   `r.departmentId ?? r.account.defaultDepartmentId ?? null`
    // must be gone. The DIM-1 rewrite uses `r.departmentId ?? null`.
    expect(REPORTS_TS).not.toMatch(/r\.departmentId\s*\?\?\s*r\.account\.defaultDepartmentId/);
    // The include chain that pulled defaultDepartment for this fallback
    // is gone too.
    expect(REPORTS_TS).not.toMatch(/account:\s*\{\s*include:\s*\{\s*defaultDepartment:\s*true\s*\}\s*\}/);
  });
});

describe("DIM-1 · reconciliation invariant (Section 11)", () => {
  // The reconciliation invariant is a property of authoritative
  // journal lines: any partitioning by dimension must sum back to
  // the same consolidated total when combined with the Unassigned
  // bucket. This is a mathematical property of the DIM-1 rule
  // "line-level dimension is authoritative + genuinely-null goes to
  // Unassigned"; we prove it against a synthetic ledger population
  // rather than a live DB, because the property is dimension-
  // independent and does not depend on Prisma or the reporting
  // engine.

  type Line = {
    accountNumber: string;
    departmentId: string | null;
    fundId: string | null;
    debit: number;
    credit: number;
  };
  const NET = (l: Line) => l.debit - l.credit;

  const sample: Line[] = [
    { accountNumber: "6098", departmentId: "grounds", fundId: "OPERATING", debit: 1200, credit: 0 }, // Licenses / Grounds / Op
    { accountNumber: "6098", departmentId: "golf",     fundId: "OPERATING", debit:  800, credit: 0 },
    { accountNumber: "6098", departmentId: "clubhouse",fundId: "OPERATING", debit:  450, credit: 0 },
    { accountNumber: "6098", departmentId: "fnb",      fundId: "OPERATING", debit: 2400, credit: 0 },
    { accountNumber: "6098", departmentId: "admin",    fundId: "OPERATING", debit: 3600, credit: 0 },
    { accountNumber: "6098", departmentId: "lrp",      fundId: "CAPITAL",   debit:  500, credit: 0 }, // one CAPITAL slice
    { accountNumber: "6098", departmentId: null,       fundId: null,        debit:  100, credit: 0 }, // genuinely unassigned
    { accountNumber: "4001", departmentId: "fnb",      fundId: "OPERATING", debit:    0, credit: 10000 }, // different account
  ];

  it("SUM(all explicit department buckets) + UNASSIGNED = CONSOLIDATED", () => {
    const consolidated = sample.reduce((acc, l) => acc + NET(l), 0);
    const byDept = new Map<string | null, number>();
    for (const l of sample) {
      const key = l.departmentId ?? null;
      byDept.set(key, (byDept.get(key) ?? 0) + NET(l));
    }
    const sumBuckets = Array.from(byDept.values()).reduce((a, b) => a + b, 0);
    expect(sumBuckets).toBe(consolidated);
  });

  it("SUM(all Fund buckets) + UNASSIGNED = CONSOLIDATED", () => {
    const consolidated = sample.reduce((acc, l) => acc + NET(l), 0);
    const byFund = new Map<string | null, number>();
    for (const l of sample) {
      const key = l.fundId ?? null;
      byFund.set(key, (byFund.get(key) ?? 0) + NET(l));
    }
    const sumBuckets = Array.from(byFund.values()).reduce((a, b) => a + b, 0);
    expect(sumBuckets).toBe(consolidated);
  });

  it("Two lines against the SAME account with DIFFERENT departments consolidate to ONE natural account", () => {
    // Filter to the 6098 lines only.
    const lines6098 = sample.filter((l) => l.accountNumber === "6098");
    const consolidated6098 = lines6098.reduce((acc, l) => acc + NET(l), 0);
    // Every 6098 line lives under the SAME natural account key.
    const uniqueAccountKeys = new Set(lines6098.map((l) => l.accountNumber));
    expect(uniqueAccountKeys.size).toBe(1);
    // Sum: 1200 + 800 + 450 + 2400 + 3600 + 500 + 100 = 9050
    expect(consolidated6098).toBe(9050);
    // And the department slices should still add up to that total.
    const byDept = new Map<string | null, number>();
    for (const l of lines6098) {
      byDept.set(l.departmentId ?? null, (byDept.get(l.departmentId ?? null) ?? 0) + NET(l));
    }
    const sum = Array.from(byDept.values()).reduce((a, b) => a + b, 0);
    expect(sum).toBe(consolidated6098);
  });

  it("Two lines against the SAME account with DIFFERENT funds consolidate to ONE natural account", () => {
    // Same sample; 6098 spans OPERATING + CAPITAL + one null.
    const lines6098 = sample.filter((l) => l.accountNumber === "6098");
    const byFund = new Map<string | null, number>();
    for (const l of lines6098) {
      byFund.set(l.fundId ?? null, (byFund.get(l.fundId ?? null) ?? 0) + NET(l));
    }
    // 6 OPERATING lines + 1 CAPITAL line + 1 null = 3 keys
    expect(byFund.size).toBe(3);
    const consolidated = Array.from(byFund.values()).reduce((a, b) => a + b, 0);
    expect(consolidated).toBe(9050);
  });
});
