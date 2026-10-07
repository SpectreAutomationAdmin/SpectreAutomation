// COA-MAP-2 (2026-10-06) — Mapping Studio UX contract.
// COA-MAP-3 (2026-10-07) — Mapping Studio retired.  This file now
// pins only the SHARED behaviours that survived the consolidation:
//   §E  labelForStatement + section groupings in reporting-role.ts
//   §C  the mapping-history read endpoint
//   §B  humanize helpers available via reporting-role.ts
//   §H  the shared MappingPreviewPanel copy (now the only Preview UI)
// Mapping-Studio-only shape pins (§A statement switcher, §D Mapping
// Studio inspector, §F / §G Mapping Studio local state) are
// obsolete and have been removed — the surface they described no
// longer exists.
//
// COA-MAP-3 §A also added pins for the Chart of Accounts
// consolidation; see tests/coa-map-3-contract.test.ts.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO    = path.resolve(__dirname, "..");
const ROLE    = path.join(REPO, "src/lib/coa-mapping/reporting-role.ts");
const HISTORY = path.join(REPO, "src/app/api/admin/coa-mapping/accounts/[accountId]/history/route.ts");
const SHARED_PREVIEW = path.join(REPO, "src/components/coa-mapping/MappingPreviewPanel.tsx");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

describe("COA-MAP-2 §B — humanization helpers available", () => {
  const src = readFileSync(ROLE, "utf8");

  it("labelForReportingRole + labelForStatement + groupBySectionsForStatement all exported", () => {
    expect(src).toMatch(/export function labelForReportingRole/);
    expect(src).toMatch(/export function labelForStatement/);
    expect(src).toMatch(/export function groupBySectionsForStatement/);
  });
});

describe("COA-MAP-2 §C — mapping-history endpoint", () => {
  it("history route exists", () => {
    expect(existsSync(HISTORY)).toBe(true);
  });

  const src = stripComments(readFileSync(HISTORY, "utf8"));

  it("is a GET handler", () => {
    expect(src).toMatch(/export async function GET\(/);
  });

  it("requires clubId query parameter and enforces tenant isolation", () => {
    expect(src).toMatch(/clubId required/);
    expect(src).toMatch(/hasClubAccess\(/);
  });

  it("reads AccountFinancialStatementAssignment ordered by effectiveFrom ASC", () => {
    expect(src).toMatch(/prisma\.accountFinancialStatementAssignment\.findMany/);
    expect(src).toMatch(/orderBy:\s*\{\s*effectiveFrom:\s*"asc"\s*\}/);
  });

  it("returns { account, history } with pre-formatted dates", () => {
    expect(src).toMatch(/fsGroupName:\s*r\.fsGroup\.name/);
    expect(src).toMatch(/effectiveFrom:\s*r\.effectiveFrom\.toISOString/);
    expect(src).toMatch(/effectiveTo:\s*r\.effectiveTo \? r\.effectiveTo\.toISOString/);
  });

  it("is read-only (no mutations, no posting guard needed)", () => {
    expect(src).not.toMatch(/assertPostingAllowed/);
    expect(src).not.toMatch(/prisma\.[a-z]+\.(create|update|delete|upsert)/);
  });
});

describe("COA-MAP-2 §E — labelForStatement + section groupings", () => {
  const src = readFileSync(ROLE, "utf8");

  it("labelForStatement handles INCOME_STATEMENT / BALANCE_SHEET / CASH_FLOW", () => {
    expect(src).toMatch(/INCOME_STATEMENT.*Income Statement/);
    expect(src).toMatch(/BALANCE_SHEET.*Balance Sheet/);
    expect(src).toMatch(/CASH_FLOW.*Cash Flow/);
  });

  it("groupBySectionsForStatement defines IS + BS section orders", () => {
    expect(src).toMatch(/IS_SECTION_ORDER/);
    expect(src).toMatch(/BS_SECTION_ORDER/);
  });

  it("IS sections include canonical Spectre buckets", () => {
    expect(src).toMatch(/"Operating Revenue"/);
    expect(src).toMatch(/"Payroll & Related"/);
    expect(src).toMatch(/"Operating Expenses"/);
    expect(src).toMatch(/"Interest & Financing"/);
    expect(src).toMatch(/"Capital Fund"/);
  });

  it("BS sections include canonical Spectre buckets", () => {
    expect(src).toMatch(/"Current Assets"/);
    expect(src).toMatch(/"Capital Assets"/);
    expect(src).toMatch(/"Equity"/);
  });
});

describe("COA-MAP-2 §H — shared MappingPreviewPanel copy", () => {
  const src = readFileSync(SHARED_PREVIEW, "utf8");

  it("Preview panel heading reads 'Reporting impact' (not 'Reporting Impact Preview')", () => {
    expect(src).toMatch(/>\s*Reporting impact\s*</);
    expect(src).not.toMatch(/>\s*Reporting Impact Preview\s*</);
  });

  it("Preview panel shows Current / Proposed row with the group names", () => {
    expect(src).toMatch(/>\s*Current\s*</);
    expect(src).toMatch(/>\s*Proposed\s*</);
    expect(src).toMatch(/preview\.targetFsGroup\.name/);
  });

  it("Preview warning button copy is 'Review & Apply'", () => {
    expect(src).toMatch(/Review & Apply/);
  });

  it("humanizePreviewError strips the BLOCKED / WARNING prefix for the Controller", () => {
    expect(src).toMatch(/humanizePreviewError/);
    expect(src).toMatch(/\^BLOCKED:/);
    expect(src).toMatch(/\^WARNING:/);
  });
});
