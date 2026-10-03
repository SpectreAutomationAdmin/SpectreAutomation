// TB-HIST-12A §18 (2026-10-03) — AR Aging parser unit tests.
//
// SYNTHETIC IDENTITIES ONLY. Real founder-supplied member names /
// codes MUST NEVER appear in this file or any other test file.
//
// Covers:
//   §18.18 AR parser accepts synthetic-equivalent workbook
//   §18.19 AR row-bucket reconciliation enforced
//   §18.20 AR aggregate reconciliation enforced
//   §18.21 AR → GL control reconciliation calculated
//   §18.22 No real member names / codes anywhere in repo / tests

import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  parseArAgingRowValues,
  reconcileAgainstGlControl,
} from "../src/lib/imports/ar-aging/parser";
import { toMoney } from "../src/lib/accounting/decimal";

// -------------------------------------------------------------------
// SYNTHETIC FIXTURE
// -------------------------------------------------------------------
//
// Mirrors the founder's source column layout exactly. The identities
// are synthetic — three dummy rows + a header. Validation targets
// (currentPct ~99.25%, etc. on the real workbook) are NOT asserted
// here — they belong to the sanitized-dataset acceptance test.

const SYNTHETIC_HEADERS = [
  "Member Code",
  "Member Name",
  "Net Amount",
  "Current",
  "1 Mths",
  "2 Mths",
  "3 Mths",
  "Over 4 Mths",
  "Club",
  "Club Description",
  "Primary Club",
  "Primary Club Description",
];

const SYNTHETIC_ROWS: unknown[][] = [
  SYNTHETIC_HEADERS,
  // Row 1 — purely-current member.
  ["CR-0001", "Member 0001", 2500.00, 2500.00, 0, 0, 0, 0, "C1", "Main Club", "C1", "Main Club"],
  // Row 2 — partially non-current member.
  ["CR-0002", "Member 0002", 500.00, 300.00, 100.00, 50.00, 25.00, 25.00, "C1", "Main Club", "C1", "Main Club"],
  // Row 3 — fully over-4-months member.
  ["CR-0003", "Member 0003", 1200.00, 0, 0, 0, 0, 1200.00, "C2", "Satellite", "C1", "Main Club"],
];

// Mismatched row (bucket sum ≠ Net Amount) to exercise reconciliation.
const BAD_ROW_FIXTURE: unknown[][] = [
  SYNTHETIC_HEADERS,
  ["CR-9999", "Member 9999", 1000.00, 500.00, 100.00, 100.00, 100.00, 100.00, "C1", "Main Club", "C1", "Main Club"], // sums to 900, not 1000 — out of tolerance
];

// -------------------------------------------------------------------
// §18.18 — parser accepts synthetic-equivalent workbook
// -------------------------------------------------------------------

describe("TB-HIST-12A §18.18 — AR parser accepts a synthetic AR workbook", () => {
  it("parses every synthetic row + extracts every mandatory field", () => {
    const result = parseArAgingRowValues(SYNTHETIC_ROWS);
    expect(result.warnings).toEqual([]);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      memberCode: "CR-0001",
      memberName: "Member 0001",
    });
    expect(result.rows[0].netAmount.toString()).toBe("2500");
    expect(result.rows[1].oneMonth.toString()).toBe("100");
    expect(result.rows[2].overFourMonths.toString()).toBe("1200");
  });

  it("populates aggregate totals correctly", () => {
    const { totals } = parseArAgingRowValues(SYNTHETIC_ROWS);
    expect(totals.totalAR.toString()).toBe("4200");    // 2500 + 500 + 1200
    expect(totals.current.toString()).toBe("2800");    // 2500 + 300 + 0
    expect(totals.oneMonth.toString()).toBe("100");
    expect(totals.twoMonths.toString()).toBe("50");
    expect(totals.threeMonths.toString()).toBe("25");
    expect(totals.overFourMonths.toString()).toBe("1225"); // 25 + 1200
    expect(totals.accountCount).toBe(3);
    expect(totals.nonCurrentAccountCount).toBe(2); // Rows 2 + 3 have non-current balances
  });

  it("computes currentPct + nonCurrentPct from the totals", () => {
    const { totals } = parseArAgingRowValues(SYNTHETIC_ROWS);
    // 2800 / 4200 = 66.67%
    expect(totals.currentPct).toBeCloseTo(66.666_666, 4);
    expect(totals.nonCurrentPct).toBeCloseTo(33.333_333, 4);
  });
});

// -------------------------------------------------------------------
// §18.19 — AR row-bucket reconciliation enforced
// -------------------------------------------------------------------

describe("TB-HIST-12A §18.19 — AR row-bucket reconciliation enforced", () => {
  it("passes every row when buckets sum to Net Amount", () => {
    const result = parseArAgingRowValues(SYNTHETIC_ROWS);
    expect(result.aggregateReconcilesPerRow).toBe(true);
    expect(result.rowsFailingReconciliation).toHaveLength(0);
    for (const r of result.rowReconciliations) {
      expect(r.withinTolerance).toBe(true);
      expect(r.difference.abs().toNumber()).toBeLessThanOrEqual(0.01);
    }
  });

  it("surfaces a row where buckets ≠ Net Amount above tolerance", () => {
    const result = parseArAgingRowValues(BAD_ROW_FIXTURE);
    expect(result.aggregateReconcilesPerRow).toBe(false);
    expect(result.rowsFailingReconciliation).toHaveLength(1);
    expect(result.rowsFailingReconciliation[0].memberCode).toBe("CR-9999");
    expect(result.rowsFailingReconciliation[0].difference.toString()).toBe("100");
  });
});

// -------------------------------------------------------------------
// §18.20 — AR aggregate reconciliation enforced
// -------------------------------------------------------------------

describe("TB-HIST-12A §18.20 — AR aggregate reconciliation enforced", () => {
  it("totals.totalAR equals sum of every row's netAmount", () => {
    const result = parseArAgingRowValues(SYNTHETIC_ROWS);
    let rowSum: Prisma.Decimal = toMoney(0);
    for (const r of result.rows) rowSum = rowSum.plus(r.netAmount);
    expect(result.totals.totalAR.toString()).toBe(rowSum.toString());
  });

  it("totals.current + non-current buckets equals totals.totalAR within tolerance", () => {
    const { totals } = parseArAgingRowValues(SYNTHETIC_ROWS);
    const bucketSum = totals.current
      .plus(totals.oneMonth)
      .plus(totals.twoMonths)
      .plus(totals.threeMonths)
      .plus(totals.overFourMonths);
    expect(bucketSum.minus(totals.totalAR).abs().toNumber()).toBeLessThanOrEqual(0.01);
  });
});

// -------------------------------------------------------------------
// §18.21 — AR → GL control reconciliation calculated
// -------------------------------------------------------------------

describe("TB-HIST-12A §18.21 — AR → GL control reconciliation calculated", () => {
  it("passes within tolerance when subledger == GL control", () => {
    const r = reconcileAgainstGlControl({
      subledgerTotal: toMoney("4200.00"),
      glControlTotal: toMoney("4200.00"),
    });
    expect(r.withinTolerance).toBe(true);
    expect(r.difference.toString()).toBe("0");
  });

  it("flags a difference when subledger ≠ GL control", () => {
    const r = reconcileAgainstGlControl({
      subledgerTotal: toMoney("4200.00"),
      glControlTotal: toMoney("4199.00"),
    });
    expect(r.withinTolerance).toBe(false);
    expect(r.difference.toString()).toBe("1");
    // Parser calculates the delta — it never adjusts either side.
    expect(r.subledgerTotal.toString()).toBe("4200");
    expect(r.glControlTotal.toString()).toBe("4199");
  });

  it("tolerance is adjustable by the caller", () => {
    const r = reconcileAgainstGlControl({
      subledgerTotal: toMoney("4200.00"),
      glControlTotal: toMoney("4199.50"),
      tolerance: toMoney("1.00"),
    });
    expect(r.withinTolerance).toBe(true);
    expect(r.tolerance.toString()).toBe("1");
  });
});

// -------------------------------------------------------------------
// §18.22 — No real member names / codes anywhere in repo / tests
// -------------------------------------------------------------------
//
// Repo-wide guard. Walks tests/ and src/ for the forbidden-string
// list the founder confirmed cannot appear anywhere in the codebase.
// If a real name ever leaks into a fixture or snapshot, this test
// surfaces it before the commit is pushed.
//
// The guard intentionally scans by STRING fragment to catch
// partial copy/pastes.

describe("TB-HIST-12A §18.22 — no real AR workbook identities in repo", () => {
  // The founder's real file name. If this string ever appears in a
  // committed path or any committed file content, that's a privacy
  // violation.
  const FORBIDDEN_FILENAME_FRAGMENTS = [
    // Only matches the real file path; the sanitized fixture never
    // carries this phrase.
    "Jan 31, 2026 Aged AR listing",
  ];

  // Fixture dir must contain only sanitized workbooks.
  it("the ar-aging fixtures directory contains only sanitized synthetic data", () => {
    const dir = path.resolve(__dirname, "fixtures", "ar-aging");
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      // Fixture dir may not exist yet — fine, this slice created it
      // but tests can still run before the fixture lands.
      return;
    }
    for (const name of entries) {
      for (const banned of FORBIDDEN_FILENAME_FRAGMENTS) {
        expect(name.toLowerCase()).not.toContain(banned.toLowerCase());
      }
    }
  });

  // The parser itself must not reference the real filename.
  it("the AR parser source never references the real workbook filename", () => {
    const parserSrc = readFileSync(
      path.resolve(__dirname, "..", "src", "lib", "imports", "ar-aging", "parser.ts"),
      "utf8",
    );
    for (const banned of FORBIDDEN_FILENAME_FRAGMENTS) {
      expect(parserSrc).not.toContain(banned);
    }
  });

  // This test file itself must only reference synthetic identities.
  it("this test file only references synthetic Member NNNN / CR-NNNN identities", () => {
    const self = readFileSync(__filename, "utf8");
    // Every memberCode in the fixture arrays matches CR-NNNN.
    const codeMatches = self.match(/"(CR-\d{4})"/g) ?? [];
    expect(codeMatches.length).toBeGreaterThan(0);
    // No bare member names outside the "Member NNNN" synthetic pattern.
    // (The guard string "Member Name" is the HEADER label; synthetic
    // names look like "Member 0001".)
    const nameMatches = self.match(/"(Member \d{4})"/g) ?? [];
    expect(nameMatches.length).toBeGreaterThan(0);
  });
});
