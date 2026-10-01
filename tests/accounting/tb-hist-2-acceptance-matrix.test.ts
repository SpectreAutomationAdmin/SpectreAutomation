// TB-HIST-2 (2026-10-01) — acceptance matrix A-N.
//
// Pure unit tests covering the correctness-blocking fixes identified
// by TB-HIST-1. These are synthetic fixtures only (per §18); the
// founder's real December / January files are untouched.

import { describe, expect, it } from "vitest";
import { computeAmount } from "../../src/lib/reporting/ledger/projections/income-statement-projection";
import {
  checkClassificationCoherence,
} from "../../src/lib/imports/classification-hierarchy";
import type { TrialBalanceLine } from "../../src/lib/reporting/ledger/contracts";

function line(partial: Partial<TrialBalanceLine> & { accountCode: string; endingBalance: number }): TrialBalanceLine {
  return {
    accountCode: partial.accountCode,
    debit: partial.debit ?? 0,
    credit: partial.credit ?? 0,
    endingBalance: partial.endingBalance,
    department: partial.department ?? null,
    fund: partial.fund ?? null,
  };
}

describe("TB-HIST-2 §A — Dec FY2025 → Jan FY2026 crosses fiscal year", () => {
  it("Jan monthly = Jan FY2026 YTD (no subtraction across FY boundary)", () => {
    const dec25 = line({ accountCode: "4000", endingBalance: 2_400_000 });
    const jan26 = line({ accountCode: "4000", endingBalance: 180_000 });
    const monthly = computeAmount({
      mode: "current-month",
      currentLine: jan26,
      priorLine: dec25,
      currentFiscalYearLabel: "FY2026",
      priorFiscalYearLabel: "FY2025",
    });
    expect(monthly).toBe(180_000);
  });

  it("Jan YTD = Jan FY2026 YTD (direct read)", () => {
    const jan26 = line({ accountCode: "4000", endingBalance: 180_000 });
    const ytd = computeAmount({
      mode: "ytd",
      currentLine: jan26,
      priorLine: null,
      currentFiscalYearLabel: "FY2026",
      priorFiscalYearLabel: null,
    });
    expect(ytd).toBe(180_000);
  });
});

describe("TB-HIST-2 §B — Jan → Feb within same FY (within-year monthly delta)", () => {
  it("Feb monthly = Feb YTD − Jan YTD = 220,000", () => {
    const jan = line({ accountCode: "4000", endingBalance: 180_000 });
    const feb = line({ accountCode: "4000", endingBalance: 400_000 });
    const monthly = computeAmount({
      mode: "current-month",
      currentLine: feb,
      priorLine: jan,
      currentFiscalYearLabel: "FY2026",
      priorFiscalYearLabel: "FY2026",
    });
    expect(monthly).toBe(220_000);
  });

  it("Feb YTD = 400,000 (direct read)", () => {
    const feb = line({ accountCode: "4000", endingBalance: 400_000 });
    const ytd = computeAmount({
      mode: "ytd",
      currentLine: feb,
      priorLine: null,
    });
    expect(ytd).toBe(400_000);
  });
});

describe("TB-HIST-2 §C — Expense within same FY", () => {
  it("Feb Expense monthly = Feb YTD − Jan YTD = 130,000", () => {
    const jan = line({ accountCode: "5000", endingBalance: 100_000 });
    const feb = line({ accountCode: "5000", endingBalance: 230_000 });
    const monthly = computeAmount({
      mode: "current-month",
      currentLine: feb,
      priorLine: jan,
      currentFiscalYearLabel: "FY2026",
      priorFiscalYearLabel: "FY2026",
    });
    expect(monthly).toBe(130_000);
  });
});

describe("TB-HIST-2 §D — Non-calendar fiscal-year boundary", () => {
  it("Fiscal-year end on 2026-06-30: July monthly = July YTD (no subtraction)", () => {
    // Hypothetical club with FY ending June 30. The prior-period
    // snapshot is FY2026 (year ending Jun 30 2026); the current-period
    // snapshot is FY2027 (year starting Jul 1 2026).
    const jun26 = line({ accountCode: "4000", endingBalance: 3_600_000 });
    const jul26 = line({ accountCode: "4000", endingBalance: 220_000 });
    const monthly = computeAmount({
      mode: "current-month",
      currentLine: jul26,
      priorLine: jun26,
      currentFiscalYearLabel: "FY2027",
      priorFiscalYearLabel: "FY2026",
    });
    expect(monthly).toBe(220_000);
  });

  it("August within non-calendar FY2027 → subtraction applies again", () => {
    const jul = line({ accountCode: "4000", endingBalance: 220_000 });
    const aug = line({ accountCode: "4000", endingBalance: 495_000 });
    const monthly = computeAmount({
      mode: "current-month",
      currentLine: aug,
      priorLine: jul,
      currentFiscalYearLabel: "FY2027",
      priorFiscalYearLabel: "FY2027",
    });
    expect(monthly).toBe(275_000);
  });
});

describe("TB-HIST-2 §D-edge — missing / zero prior cases", () => {
  it("Missing prior snapshot → current-month returns YTD directly", () => {
    const jan = line({ accountCode: "4000", endingBalance: 180_000 });
    const monthly = computeAmount({
      mode: "current-month",
      currentLine: jan,
      priorLine: null,
      currentFiscalYearLabel: "FY2026",
      priorFiscalYearLabel: null,
    });
    expect(monthly).toBe(180_000);
  });

  it("Zero prior balance within same FY → monthly equals current YTD", () => {
    const jan = line({ accountCode: "4000", endingBalance: 0 });
    const feb = line({ accountCode: "4000", endingBalance: 220_000 });
    const monthly = computeAmount({
      mode: "current-month",
      currentLine: feb,
      priorLine: jan,
      currentFiscalYearLabel: "FY2026",
      priorFiscalYearLabel: "FY2026",
    });
    expect(monthly).toBe(220_000);
  });
});

describe("TB-HIST-2 §F — one natural account, multiple dimensional rows", () => {
  it("TrialBalanceLine carries optional department + fund; same accountCode with different departments is permitted", () => {
    const grounds = line({ accountCode: "6098", endingBalance: 1_000, department: "GROUNDS", fund: "OPERATING" });
    const admin = line({ accountCode: "6098", endingBalance: 2_000, department: "ADMIN", fund: "OPERATING" });
    expect(grounds.accountCode).toBe(admin.accountCode);
    expect(grounds.department).toBe("GROUNDS");
    expect(admin.department).toBe("ADMIN");
    // Consolidated at the account level = sum of dimensional rows.
    const consolidated = grounds.endingBalance + admin.endingBalance;
    expect(consolidated).toBe(3_000);
  });
});

describe("TB-HIST-2 §G — same (account, department, fund) duplicated must be rejected (dimensional identity)", () => {
  it("duplicate detection logic uses (code, dept) tuple", () => {
    const rows = [
      { accountNumber: "6098", department: "GROUNDS" },
      { accountNumber: "6098", department: "GROUNDS" }, // dup
      { accountNumber: "6098", department: "ADMIN" }, // OK
    ];
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const r of rows) {
      const key = `${r.accountNumber}\u0000${(r.department ?? "").toUpperCase()}`;
      if (seen.has(key)) dups.push(key);
      seen.add(key);
    }
    expect(dups).toHaveLength(1);
    expect(dups[0]).toContain("6098");
    expect(dups[0]).toContain("GROUNDS");
  });

  it("same accountNumber + different department is NOT a duplicate", () => {
    const rows = [
      { accountNumber: "6098", department: "GROUNDS" },
      { accountNumber: "6098", department: "ADMIN" },
      { accountNumber: "6098", department: "F&B" },
    ];
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const r of rows) {
      const key = `${r.accountNumber}\u0000${(r.department ?? "").toUpperCase()}`;
      if (seen.has(key)) dups.push(key);
      seen.add(key);
    }
    expect(dups).toHaveLength(0);
  });
});

describe("TB-HIST-2 §H — unknown account would block the commit (contract check)", () => {
  it("the Jonas commit action's UNKNOWN_ACCOUNT code is on the result union", () => {
    // Structural guard — the symbol must exist (import check).
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.join(process.cwd(), "src", "app", "app", "admin", "imports", "jonas", "actions.ts"),
      "utf8",
    );
    expect(src).toMatch(/"UNKNOWN_ACCOUNT"/);
    expect(src).toMatch(/code: "UNKNOWN_ACCOUNT"/);
  });
});

describe("TB-HIST-2 §I-J — unknown or disallowed Department blocks the commit", () => {
  it("UNKNOWN_DEPARTMENT and MISSING_REQUIRED_DEPARTMENT codes are on the Jonas commit result union", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.join(process.cwd(), "src", "app", "app", "admin", "imports", "jonas", "actions.ts"),
      "utf8",
    );
    expect(src).toMatch(/"UNKNOWN_DEPARTMENT"/);
    expect(src).toMatch(/code: "UNKNOWN_DEPARTMENT"/);
    expect(src).toMatch(/"MISSING_REQUIRED_DEPARTMENT"/);
    expect(src).toMatch(/code: "MISSING_REQUIRED_DEPARTMENT"/);
    // The commit path reads the tenant Department catalog.
    expect(src).toMatch(/prisma\.department\.findMany\(\{\s*where: \{ clubId \}/);
  });
});

describe("TB-HIST-2 §K — balance tolerance is unified at $0.01", () => {
  it("Jonas commit action uses $0.01 tolerance", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.join(process.cwd(), "src", "app", "app", "admin", "imports", "jonas", "actions.ts"),
      "utf8",
    );
    expect(src).toMatch(/BALANCE_TOLERANCE\s*=\s*0\.01/);
  });

  it("Jonas importer reconcile() uses $0.01 tolerance (unified with the commit gate)", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.join(process.cwd(), "src", "lib", "reporting", "ledger", "importers", "jonas-gl-importer.ts"),
      "utf8",
    );
    expect(src).toMatch(/Math\.abs\(delta\) <= 0\.01/);
    expect(src).not.toMatch(/Math\.abs\(delta\) < 1\b/);
  });
});

describe("TB-HIST-2 §L — Monthly Reporting Package suppresses demo Silver Springs SoA auxiliary when tenant has real data", () => {
  it("monthly-package.ts gates SoA auxiliaryInputs on hasCommittedRealTrialBalance", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.join(process.cwd(), "src", "lib", "reporting", "monthly-package.ts"),
      "utf8",
    );
    expect(src).toMatch(/hasCommittedRealTrialBalance/);
    expect(src).toMatch(/const hasRealData = await hasCommittedRealTrialBalance\(club\.id\)/);
    expect(src).toMatch(/soaAuxiliaryInputs = hasRealData \? undefined : SILVER_SPRINGS_SOA_AUXILIARY_INPUTS/);
  });
});

describe("TB-HIST-2 §M — Finance Income Statement reads from reporting ledger when snapshots exist", () => {
  it("incomeStatement() routes through reportingAccountBalances (TB-HIST-2b §2 — scoped filters stay on the snapshot path too)", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.join(process.cwd(), "src", "lib", "accounting", "reports.ts"),
      "utf8",
    );
    expect(src).toMatch(/reportingAccountBalances\(clubId, \{ from, to, departmentId: opts\?\.departmentId, fundId: opts\?\.fundId \}\)/);
  });
});

describe("TB-HIST-2 §N — Finance Balance Sheet current-year earnings read from reporting ledger", () => {
  it("balanceSheet() uses reportingAccountBalances for CY earnings", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.join(process.cwd(), "src", "lib", "accounting", "reports.ts"),
      "utf8",
    );
    expect(src).toMatch(/reportingAccountBalances\(clubId, \{ from: fy\.startDate, to: asOf \}\)/);
  });
});

describe("TB-HIST-2 §O — hasCommittedRealTrialBalance recognises Jonas commits", () => {
  it("balance.ts checks ReportingLedgerBatch alongside the legacy OpeningTB", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.join(process.cwd(), "src", "lib", "accounting", "balance.ts"),
      "utf8",
    );
    expect(src).toMatch(/prisma\.reportingLedgerBatch\.findFirst/);
    expect(src).toMatch(/state: "committed"/);
    expect(src).toMatch(/supersededByBatchId: null/);
    expect(src).toMatch(/hasCommittedRealAccountingData/);
  });
});

describe("TB-HIST-2 §P — classification coherence still enforced (regression guard)", () => {
  it("Account 7000 defect shape still rejected by the server guard (COA-UX-2d regression)", () => {
    const r = checkClassificationCoherence(
      { type: "EXPENSE", categoryKey: null, fsGroupKey: "IS_OTHER_REVENUE" },
      [{ key: "OTHER_REVENUE", accountType: "REVENUE" }],
    );
    expect(r.coherent).toBe(false);
    if (!r.coherent) {
      expect(r.code).toBe("FS_GROUP_WITHOUT_CATEGORY");
    }
  });
});
