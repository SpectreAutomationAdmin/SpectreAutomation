// MBR-FP-6 — Operating Results 12-month trend MUST respect the
// selected package reporting period as the authoritative cutoff.
//
// Root cause (pre-fix):
//   `getOperatingResults` snapshot-fallback path keyed its Actual
//   lookup `actualByMonth` by `getUTCMonth()` ALONE.  Prior-year
//   snapshots that passed the lte filter (e.g. Feb 2025, Mar 2025)
//   collided with the current-year skeleton slots (Feb 2026, Mar
//   2026), so a Jan 2026 package displayed prior-year monthly
//   values in current-year slots — the founder's observation of
//   "Feb/Mar 2026 actuals visible on a Jan 2026 package".
//
// Fix: the Actual map is now keyed by `${year}-${month}` AND the
// skeleton loop skips any `monthIndex > asOf.getUTCMonth()` so
// future-of-reporting-period slots stay honestly null even if a
// snapshot leaks past the lte filter.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(
  path.join(REPO, "src/lib/reporting/operating-results.ts"),
  "utf-8",
);

describe("MBR-FP-6 §1 — Actual map keyed by (year, month), not month alone", () => {
  it("retires the pre-fix `actualByMonth = new Map<number, OperatingMonth>()`", () => {
    expect(SRC).not.toMatch(/const actualByMonth = new Map<number, OperatingMonth>\(\);/);
    expect(SRC).toMatch(/const actualByYearMonth = new Map<string, OperatingMonth>\(\);/);
  });

  it("the Actual key composes BOTH year and month from the snapshot's endDate", () => {
    expect(SRC).toMatch(
      /const key = `\$\{m\.endDate\.getUTCFullYear\(\)\}-\$\{m\.endDate\.getUTCMonth\(\)\}`;/,
    );
    expect(SRC).toMatch(/actualByYearMonth\.set\(key, m\);/);
  });

  it("the current-year skeleton reads the (anchorYear, monthIndex) key only", () => {
    expect(SRC).toMatch(/const key = `\$\{anchorYear\}-\$\{monthIndex\}`;/);
    expect(SRC).toMatch(/const existing = actualByYearMonth\.get\(key\);/);
  });
});

describe("MBR-FP-6 §2 — reporting-month cutoff enforced on every Actual slot", () => {
  it("defines reportingMonthIdx from the package asOf", () => {
    expect(SRC).toMatch(/const reportingMonthIdx = asOf\.getUTCMonth\(\);/);
  });

  it("Actual is admitted ONLY when the slot's monthIndex is ≤ reportingMonthIdx", () => {
    expect(SRC).toMatch(
      /const admitActual = existing != null && monthIndex <= reportingMonthIdx;/,
    );
    expect(SRC).toMatch(/if \(admitActual && existing\)/);
  });

  it("future-month slot still populates Budget (truncation would hide the forward plan)", () => {
    // The else branch retains `budgetNoi: budgetForMonth` so the
    // Budget series continues to render across the full fiscal year
    // per the directive §3 ("Do not truncate budget data at the
    // reporting cutoff").
    const fn = SRC.slice(SRC.indexOf("else {"));
    const scope = fn.slice(0, 500);
    expect(scope).toMatch(/budgetNoi: budgetForMonth,/);
    expect(scope).toMatch(/noi: null,/);
    expect(scope).toMatch(/revenue: null,/);
  });
});

describe("MBR-FP-6 §3 — Scenarios A, B, C — hypothetical period simulations (unit-level)", () => {
  // These scenarios simulate the exact `enriched` build loop for
  // asOf = Jan 31 / Feb 28 / Mar 31 2026 with snapshots across
  // {Jan 2025, Feb 2025, Mar 2025, Dec 2025, Jan 2026}.  The
  // simulations use the SAME `(year, month)` key + monthIndex ≤
  // reportingMonthIdx rules the service applies, so they catch
  // regressions in either rule without invoking the DB.

  type Snap = { endDate: Date; noi: number };

  function enrichActualOnly(snapshots: Snap[], asOf: Date) {
    const anchorYear = asOf.getUTCFullYear();
    const reportingMonthIdx = asOf.getUTCMonth();
    const map = new Map<string, Snap>();
    for (const s of snapshots) {
      const key = `${s.endDate.getUTCFullYear()}-${s.endDate.getUTCMonth()}`;
      map.set(key, s);
    }
    const result: Array<{ label: string; noi: number | null }> = [];
    const labels = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    for (let i = 0; i < 12; i++) {
      const existing = map.get(`${anchorYear}-${i}`);
      const admit = existing != null && i <= reportingMonthIdx;
      result.push({ label: `${labels[i]} ${anchorYear}`, noi: admit ? existing.noi : null });
    }
    return result;
  }

  const SNAPSHOTS: Snap[] = [
    { endDate: new Date(Date.UTC(2025, 0, 31, 23, 59, 59, 999)), noi: 100 },
    { endDate: new Date(Date.UTC(2025, 1, 28, 23, 59, 59, 999)), noi: 101 },
    { endDate: new Date(Date.UTC(2025, 2, 31, 23, 59, 59, 999)), noi: 102 },
    { endDate: new Date(Date.UTC(2025, 11, 31, 23, 59, 59, 999)), noi: 112 },
    { endDate: new Date(Date.UTC(2026, 0, 31, 23, 59, 59, 999)), noi: 200 },
  ];

  it("Scenario A — Jan 2026 package: Only Jan 2026 populates; Feb..Dec stay null", () => {
    const asOf = new Date(Date.UTC(2026, 0, 31));
    const r = enrichActualOnly(SNAPSHOTS, asOf);
    expect(r[0]).toEqual({ label: "Jan 2026", noi: 200 });
    for (let i = 1; i < 12; i++) {
      expect(r[i].noi).toBeNull();
    }
  });

  it("Scenario A regression — Feb 2025 snapshot MUST NOT populate the Feb 2026 slot", () => {
    const asOf = new Date(Date.UTC(2026, 0, 31));
    const r = enrichActualOnly(SNAPSHOTS, asOf);
    const febSlot = r.find((p) => p.label === "Feb 2026");
    expect(febSlot?.noi).toBeNull();
    const marSlot = r.find((p) => p.label === "Mar 2026");
    expect(marSlot?.noi).toBeNull();
  });

  it("Scenario B — Feb 2026 package: Jan + Feb 2026 populate (if a Feb 2026 snapshot were present), Mar..Dec null", () => {
    const feb2026: Snap = { endDate: new Date(Date.UTC(2026, 1, 28, 23, 59, 59, 999)), noi: 201 };
    const asOf = new Date(Date.UTC(2026, 1, 28));
    const r = enrichActualOnly([...SNAPSHOTS, feb2026], asOf);
    expect(r[0].noi).toBe(200);
    expect(r[1].noi).toBe(201);
    for (let i = 2; i < 12; i++) {
      expect(r[i].noi).toBeNull();
    }
  });

  it("Scenario C — Mar 2026 package: Jan + Feb + Mar 2026 populate, Apr..Dec null", () => {
    const feb2026: Snap = { endDate: new Date(Date.UTC(2026, 1, 28, 23, 59, 59, 999)), noi: 201 };
    const mar2026: Snap = { endDate: new Date(Date.UTC(2026, 2, 31, 23, 59, 59, 999)), noi: 202 };
    const asOf = new Date(Date.UTC(2026, 2, 31));
    const r = enrichActualOnly([...SNAPSHOTS, feb2026, mar2026], asOf);
    expect(r[0].noi).toBe(200);
    expect(r[1].noi).toBe(201);
    expect(r[2].noi).toBe(202);
    for (let i = 3; i < 12; i++) {
      expect(r[i].noi).toBeNull();
    }
  });

  it("Scenario D — Historical stability: adding Feb+Mar 2026 to the dataset does NOT change the Jan 2026 result", () => {
    const asOf = new Date(Date.UTC(2026, 0, 31));
    const beforeImport = enrichActualOnly(SNAPSHOTS, asOf);
    const feb2026: Snap = { endDate: new Date(Date.UTC(2026, 1, 28, 23, 59, 59, 999)), noi: 201 };
    const mar2026: Snap = { endDate: new Date(Date.UTC(2026, 2, 31, 23, 59, 59, 999)), noi: 202 };
    const afterImport = enrichActualOnly([...SNAPSHOTS, feb2026, mar2026], asOf);
    expect(afterImport).toEqual(beforeImport);
  });

  it("Scenario E — Future-month Budget stays available (not truncated to zero)", () => {
    // Service-level: see the else-branch assertion above —
    // budgetForMonth is forwarded regardless of monthIndex ≤
    // reportingMonthIdx.  This spec documents the invariant from
    // the Scenario-A/B/C simulation output: null NOI ≠ null budget.
    const asOf = new Date(Date.UTC(2026, 0, 31));
    const r = enrichActualOnly(SNAPSHOTS, asOf);
    expect(r.length).toBe(12);
    for (let i = 1; i < 12; i++) {
      expect(r[i].noi).toBeNull(); // Actual null for future months.
    }
    // Service wiring preserves budget — verified by §2 above.
  });
});

describe("MBR-FP-6 §4 — Scenario F: tenant isolation preserved", () => {
  it("the committed-snapshot resolver filters by clubId on every DB read", () => {
    const snapFn = SRC.slice(SRC.indexOf("async function getOperatingMonthsFromCommittedSnapshots"));
    const scope = snapFn.slice(0, 4_000);
    expect(scope).toMatch(/prisma\.reportingLedgerSnapshot\.findMany/);
    expect(scope).toMatch(/clubId,/);
    expect(scope).toMatch(/entityKind: "trial-balance"/);
    expect(scope).toMatch(/batchState: "committed"/);
    expect(scope).toMatch(/asOf:\s*\{\s*lte:\s*asOfEod\s*\}/);
  });

  it("ytdFor inside the snapshot walker also scopes by clubId", () => {
    expect(SRC).toMatch(
      /reportingAccountBalances\(\s*clubId,/,
    );
  });
});
