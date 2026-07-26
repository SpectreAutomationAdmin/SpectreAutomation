// Reporting Period Golden Rule — enforcement guard.
//
// Per `docs/reporting-package-period-golden-rule.md` and the
// `Reporting Period Golden Rule` section in CLAUDE.md, NO reporting-
// package component or section data builder may hardcode a
// presentation-period label. Every period string (statement
// headers, current-month column labels, CFO eyebrow dates, chart
// axes) MUST flow from the canonical `ReportingPeriod` object built
// in `monthly-package.ts` via `buildReportingPeriod(periodEnd)`.
//
// This file scans the reporting-package source for forbidden
// hardcoded strings and FAILS the suite if any leak past the
// reporting-period module. The intent is to catch regressions when
// a future change pastes "Q1 2026" or "Mar Budget" into a section
// instead of reading from the period object.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/** Files allowed to mention the forbidden strings — the canonical
 *  period source itself, this guard test, the unit-test that
 *  asserts March behaviour after a period flip, and the docs. */
const ALLOWLIST = new Set<string>([
  // The canonical period module — defines MONTH_LONG/MONTH_SHORT.
  path.normalize("src/lib/reporting/reporting-period.ts"),
  // This guard file itself.
  path.normalize("tests/reporting-period-golden-rule.test.ts"),
  // The Statement of Activities unit tests — they exercise period
  // regression (flip to March 2026, December 2026) and assert the
  // resulting column labels. Hardcoded "Mar Budget" / "March 2026"
  // strings here are TEST EXPECTATIONS, not presentation code.
  path.normalize("tests/statement-of-activities.test.ts"),
  // Capital Project Tracker — the `estCompleteLabel` field carries
  // PROJECT-SCHEDULE DATA (when each project is expected to finish:
  // "Q2 2026" / "Q3 2026" / "Q4 2026"), exactly the same data
  // exemption the Golden Rule names: "Real accounting / GL row
  // labels that name a department or KPI — that's a stable
  // category name, not a period descriptor". A project's expected
  // completion quarter is intrinsic to the project; it does NOT
  // change when the reporting period changes. Allowlisted.
  path.normalize("src/lib/reporting/capital-project-tracker.ts"),
  // AR Aging / Departmental P&L Summary / Inventory Analysis —
  // the only matches in these files are inside `// ...` line
  // comments and `/** ... */` docstrings that illustrate the
  // shape of the period-derived strings (e.g. "Current-period
  // column — derived as e.g. 'Q2 2026' from
  // `ReportingPeriod.currentYearQuarterLabel`"). The actual
  // rendered values come from `opts.period.*`. Allowlisted so
  // the guard doesn't false-positive on documentation examples.
  path.normalize("src/lib/reporting/accounts-receivable-aging.ts"),
  path.normalize("src/lib/reporting/departmental-pl-summary.ts"),
  path.normalize("src/lib/reporting/inventory-analysis.ts"),
  // Doc files mention the forbidden strings to illustrate the rule.
  path.normalize("docs/reporting-package-period-golden-rule.md"),
  path.normalize("CLAUDE.md"),
]);

/** Scan roots — only reporting-package source. Trying to keep the
 *  guard tight; widening this set is a deliberate decision. */
const SCAN_ROOTS = [
  "src/lib/reporting",
  "src/app/app/admin/reporting",
  "src/components/reporting",
];

/** Forbidden presentation-period strings. Each entry's `match`
 *  regex is the literal forbidden snippet; `reason` is the
 *  human-readable rationale. */
const FORBIDDEN: ReadonlyArray<{ match: RegExp; reason: string }> = [
  { match: /\bQ1 2026\b/,                  reason: "stale quarter label ('Q1 2026')" },
  { match: /\bQ2 2026\b/,                  reason: "stale quarter label ('Q2 2026')" },
  { match: /\bQ3 2026\b/,                  reason: "stale quarter label ('Q3 2026')" },
  { match: /\bQ4 2026\b/,                  reason: "stale quarter label ('Q4 2026')" },
  { match: /\bMar Budget\b/,               reason: "stale current-month column label ('Mar Budget')" },
  { match: /\bMar Actual\b/,               reason: "stale current-month column label ('Mar Actual')" },
  { match: /\bMar Var\b/,                  reason: "stale current-month column label ('Mar Var')" },
  { match: /January 1 [—-] March 31/,      reason: "stale Q1 range string ('January 1 — March 31')" },
  { match: /March 31, 2026/,               reason: "stale period-ended date ('March 31, 2026')" },
  // 2026-06-22: extended after the AR commentary period-label
  // sweep. These are the period-end-date literals that match the
  // shape `<MonthName> 31, 2026` / `<MonthName> 30, 2026` for the
  // two months whose period-end the demo build currently uses.
  // Use `period.periodEndShortLabel` instead.
  { match: /\bMay 31, 2026\b/,             reason: "stale period-ended date ('May 31, 2026') — use reportingPeriod.periodEndShortLabel" },
  { match: /\bMay 31, 2025\b/,             reason: "stale prior-year period-ended date ('May 31, 2025') — use reportingPeriod.priorYearLabel" },
];

/** Walk a directory recursively and yield every .ts / .tsx path. */
function* walk(root: string): Generator<string> {
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        yield full;
      }
    }
  }
}

describe("Reporting Period Golden Rule — forbidden hardcoded period strings", () => {
  it("no reporting-package source file ships a stale presentation-period label", () => {
    const violations: string[] = [];
    for (const root of SCAN_ROOTS) {
      const abs = path.resolve(process.cwd(), root);
      for (const file of walk(abs)) {
        const rel = path.normalize(path.relative(process.cwd(), file));
        if (ALLOWLIST.has(rel)) continue;
        const src = fs.readFileSync(file, "utf8");
        for (const { match, reason } of FORBIDDEN) {
          if (match.test(src)) {
            violations.push(`${rel} — ${reason} (matched ${match.source})`);
          }
        }
      }
    }
    expect(
      violations,
      `Forbidden hardcoded reporting-period strings found:\n  - ${violations.join("\n  - ")}\n\n` +
        `Per docs/reporting-package-period-golden-rule.md, every section MUST derive ` +
        `period labels from the canonical ReportingPeriod object built in ` +
        `monthly-package.ts. Read pre-formatted fields off ` +
        `pkg.statementOfActivitiesV2.periodLabel / columnHeaders instead.`,
    ).toEqual([]);
  });

  it("the canonical period module defines the helper everyone consumes", () => {
    const period = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/reporting/reporting-period.ts"),
      "utf8",
    );
    expect(period).toMatch(/export function buildReportingPeriod\(/);
    expect(period).toMatch(/export type ReportingPeriod\s*=/);
    expect(period).toMatch(/statementHeaderLabel/);
    expect(period).toMatch(/columnLabels/);
  });

  it("the monthly-package builder consumes buildReportingPeriod once and threads it through statementOfActivitiesV2", () => {
    const pkg = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/reporting/monthly-package.ts"),
      "utf8",
    );
    expect(pkg).toMatch(/import\s*\{[^}]*buildReportingPeriod[^}]*\}\s*from\s*["']@\/lib\/reporting\/reporting-period["']/);
    expect(pkg).toMatch(/const reportingPeriod = buildReportingPeriod\(periodEnd/);
    // Post-ledger-refactor: the SoA call is now `getStatementOfActivitiesForClub({ ..., period: reportingPeriod, demoFallback: () => buildSilverSpringsStatementOfActivities({ ..., period: reportingPeriod }) })`. Both surfaces (the dual-read primary call AND the demoFallback) MUST thread the canonical ReportingPeriod so the period-golden-rule still holds on either branch.
    expect(pkg).toMatch(/getStatementOfActivitiesForClub\(\{[\s\S]*?period:\s*reportingPeriod/);
    expect(pkg).toMatch(/buildSilverSpringsStatementOfActivities\(\{[\s\S]*?period:\s*reportingPeriod/);
  });
});
