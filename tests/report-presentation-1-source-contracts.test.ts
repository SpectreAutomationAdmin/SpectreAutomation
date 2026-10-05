// REPORT-PRESENTATION-1 (2026-10-05) — source-contract pins.
//
// Three architectural invariants:
//   1. FS Group projection exists + consumes canonical sources
//      (reportingAccountBalances + resolveBudget). No parallel
//      calculation, no name-regex, no account-number-range matching.
//   2. Statement of Activities v2 schema carries fs-group /
//      fs-group-child row kinds + the metadata (groupKey, accountNumber,
//      isExpandable) that drives expand/collapse.
//   3. monthly-package wires live tenants through the new builder;
//      demo tenants continue to use the natural-account default.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const PROJECTION = path.join(REPO, "src/lib/reporting/fs-group-projection.ts");
const STATEMENT = path.join(REPO, "src/lib/reporting/statement-of-activities.ts");
const MONTHLY = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const CLIENT_TABLE = path.join(REPO, "src/app/app/admin/reporting/monthly/StatementOfActivitiesTable.tsx");

describe("REPORT-PRESENTATION-1 §3-6 — canonical FS Group projection", () => {
  it("resolveFsGroupProjection exported + period-aware signature", () => {
    const src = readFileSync(PROJECTION, "utf8");
    expect(src).toMatch(/export async function resolveFsGroupProjection\(args:\s*\{/);
    expect(src).toMatch(/period:\s*ReportingPeriod/);
    // Period-aware internally: uses periodStart + periodEnd + fiscal-year-start.
    expect(src).toMatch(/period\.periodStart/);
    expect(src).toMatch(/period\.periodEnd/);
    expect(src).toMatch(/fiscalYearStart/);
  });

  it("reads canonical sources — reportingAccountBalances + resolveBudget — never parallel calculation", () => {
    const src = readFileSync(PROJECTION, "utf8");
    expect(src).toMatch(/import \{ reportingAccountBalances \}/);
    expect(src).toMatch(/import \{ resolveBudget \}/);
    // No name-regex classifiers in the projection source. Match the
    // actual stewardship-dashboard-adapter / statement-of-activities
    // regex patterns we're explicitly removing in this slice.
    expect(src).not.toMatch(/\/membership\|dues\|service assessment\/i/);
    expect(src).not.toMatch(/\/payroll\|benefit\|wages\/i/);
    expect(src).not.toMatch(/\.test\(.*accountName\)/);
  });

  it("fund classification uses Account.fundApplicability — never account-name inference", () => {
    const src = readFileSync(PROJECTION, "utf8");
    expect(src).toMatch(/isOperatingFund\(.*fundApplicability\)/);
    expect(src).toMatch(/isCapitalOnly\(.*fundApplicability\)/);
    // helper functions themselves read fundApplicability.
    expect(src).toMatch(/function isOperatingFund\(fund: string \| null\)/);
    expect(src).toMatch(/function isCapitalOnly\(fund: string \| null\)/);
  });

  it("FsGroupProjection surfaces parent + child shape + section totals", () => {
    const src = readFileSync(PROJECTION, "utf8");
    expect(src).toMatch(/export type FsGroupProjectionRow = \{[\s\S]*?accounts: FsGroupAccountRow\[\]/);
    expect(src).toMatch(/operatingRevenue: FsGroupProjectionRow\[\]/);
    expect(src).toMatch(/operatingExpense: FsGroupProjectionRow\[\]/);
    expect(src).toMatch(/depreciation: FsGroupProjectionRow\[\]/);
    expect(src).toMatch(/capitalRevenue: FsGroupProjectionRow\[\]/);
    expect(src).toMatch(/capitalExpense: FsGroupProjectionRow\[\]/);
    expect(src).toMatch(/totals: \{[\s\S]*?noiBeforeDep/);
  });

  it("depreciation carved out of operatingExpense — matches REPORT-WIRING-1B canonical NOI-before-dep", () => {
    const src = readFileSync(PROJECTION, "utf8");
    expect(src).toMatch(/if \(a\.fsGroupKey === "IS_DEPRECIATION"\) depreciationAccts\.push\(a\)/);
    expect(src).toMatch(/else operatingExpenseAccts\.push\(a\)/);
  });

  it("findFsGroupRow helper for Section III ratio builders", () => {
    const src = readFileSync(PROJECTION, "utf8");
    expect(src).toMatch(/export function findFsGroupRow/);
  });
});

describe("REPORT-PRESENTATION-1 §7-10 — Statement of Activities v2 FS-Group row kinds", () => {
  it("fs-group + fs-group-child added to StatementOfActivitiesV2RowKind", () => {
    const src = readFileSync(STATEMENT, "utf8");
    // Terminate on `;` at end-of-line (the union terminator), not the
    // first `;` which can appear inline inside a comment.
    const kindUnion = src.match(/export type StatementOfActivitiesV2RowKind =[\s\S]*?;$/m)?.[0] ?? "";
    expect(kindUnion).toMatch(/"fs-group"/);
    expect(kindUnion).toMatch(/"fs-group-child"/);
  });

  it("row type carries groupKey + isExpandable + accountNumber for expand/collapse", () => {
    const src = readFileSync(STATEMENT, "utf8");
    const rowType = src.match(/export type StatementOfActivitiesV2Row = \{[\s\S]*?\};/)?.[0] ?? "";
    expect(rowType).toMatch(/groupKey\?:\s*string/);
    expect(rowType).toMatch(/isExpandable\?:\s*boolean/);
    expect(rowType).toMatch(/accountNumber\?:\s*string/);
  });

  it("buildStatementOfActivitiesFromFsGroupProjection exported + consumes the projection", () => {
    const src = readFileSync(STATEMENT, "utf8");
    expect(src).toMatch(/export function buildStatementOfActivitiesFromFsGroupProjection/);
    expect(src).toMatch(/projection: FsGroupProjection/);
  });

  it("FS-Group builder emits parent + child rows for every group", () => {
    const src = readFileSync(STATEMENT, "utf8");
    // Delimit the builder body up to the next helper function.
    const body = src.match(/export function buildStatementOfActivitiesFromFsGroupProjection[\s\S]*?function buildFsGroupRow/)?.[0] ?? "";
    expect(body).toMatch(/for \(const g of projection\.operatingRevenue\)/);
    expect(body).toMatch(/buildFsGroupRow\(\{ g,/);
    expect(body).toMatch(/for \(const a of g\.accounts\)/);
    expect(body).toMatch(/buildFsGroupChildRow\(\{ parent: g, acct: a/);
  });

  it("builder uses canonical projection totals — no re-aggregation in the builder", () => {
    const src = readFileSync(STATEMENT, "utf8");
    const body = src.match(/export function buildStatementOfActivitiesFromFsGroupProjection[\s\S]*?function buildFsGroupRow/)?.[0] ?? "";
    expect(body).toMatch(/projection\.totals\.operatingRevenue\.ytdActual/);
    expect(body).toMatch(/projection\.totals\.operatingRevenue\.ytdBudget/);
    expect(body).toMatch(/projection\.totals\.noiBeforeDep/);
  });

  it("builder does NOT use name-regex for Payroll — uses fsGroupKey", () => {
    const src = readFileSync(STATEMENT, "utf8");
    const body = src.match(/export function buildStatementOfActivitiesFromFsGroupProjection[\s\S]*?function buildFsGroupRow/)?.[0] ?? "";
    expect(body).toMatch(/g\.fsGroupKey === "IS_PAYROLL"/);
    // The builder's helper lookup pattern for the Payroll row:
    expect(body).not.toMatch(/\/payroll\|benefit\|wages\//i);
  });
});

describe("REPORT-PRESENTATION-1 §3 — monthly-package wires live tenants through FS-Group builder", () => {
  it("imports both the projection resolver and the new builder", () => {
    const src = readFileSync(MONTHLY, "utf8");
    expect(src).toMatch(/import \{ resolveFsGroupProjection \} from "@\/lib\/reporting\/fs-group-projection"/);
    expect(src).toMatch(/buildStatementOfActivitiesFromFsGroupProjection/);
  });

  it("live tenants call the new builder; demo tenants retain the existing path", () => {
    const src = readFileSync(MONTHLY, "utf8");
    // Scope the match to the Section IV wiring block so we don't match
    // other hasRealData branches elsewhere in the file.
    const block = src.match(/let statementOfActivitiesV2: StatementOfActivitiesV2;[\s\S]*?getStatementOfActivitiesForClub\(\{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(block).toMatch(/if \(hasRealData\)\s*\{/);
    expect(block).toMatch(/resolveFsGroupProjection/);
    expect(block).toMatch(/buildStatementOfActivitiesFromFsGroupProjection/);
    expect(block).toMatch(/getStatementOfActivitiesForClub/);
  });
});

describe("REPORT-PRESENTATION-1 §7-10 — Section IV client component for expand/collapse", () => {
  it("StatementOfActivitiesTable is a client component", () => {
    const src = readFileSync(CLIENT_TABLE, "utf8");
    expect(src).toMatch(/^"use client";/);
  });

  it("owns expanded state as a per-session Set, default collapsed (empty set)", () => {
    const src = readFileSync(CLIENT_TABLE, "utf8");
    expect(src).toMatch(/useState<Set<string>>\(new Set\(\)\)/);
  });

  it("fs-group rows render a chevron disclosure control with aria-expanded", () => {
    const src = readFileSync(CLIENT_TABLE, "utf8");
    expect(src).toMatch(/aria-expanded=\{expanded\}/);
    expect(src).toMatch(/\{expanded \? "⌄" : "›"\}/);
  });

  it("fs-group-child rows only render when parent is expanded", () => {
    const src = readFileSync(CLIENT_TABLE, "utf8");
    expect(src).toMatch(/case "fs-group-child":[\s\S]*?if \(!row\.groupKey \|\| !expandedGroups\.has\(row\.groupKey\)\) return null/);
  });

  it("directive §10 — expansion never affects totals / Budget / variance (toggle only updates expandedGroups)", () => {
    const src = readFileSync(CLIENT_TABLE, "utf8");
    const toggleBody = src.match(/const onToggleGroup = \(groupKey: string\) => \{[\s\S]*?\};/)?.[0] ?? "";
    // Only mutates the expandedGroups Set. No access to row.values / totals.
    expect(toggleBody).toMatch(/setExpandedGroups/);
    expect(toggleBody).not.toMatch(/row\.values/);
    expect(toggleBody).not.toMatch(/currentActual|ytdActual/);
  });
});

describe("REPORT-PRESENTATION-1 §25 — no accounting mutation", () => {
  it("fs-group-projection never writes to prisma", () => {
    const src = readFileSync(PROJECTION, "utf8");
    expect(src).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)/);
  });

  it("new Statement builder never writes to prisma", () => {
    const src = readFileSync(STATEMENT, "utf8");
    const body = src.match(/export function buildStatementOfActivitiesFromFsGroupProjection[\s\S]*?function buildFsGroupRow/)?.[0] ?? "";
    expect(body).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)/);
  });
});
