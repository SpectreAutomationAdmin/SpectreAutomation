// COA-MAP-2A (2026-10-06) — repair-slice contract regressions.
// COA-MAP-3 (2026-10-07) — Mapping Studio retired; the CoaModeSwitch
// and its Finance-sidebar entry are REMOVED.  This file now pins
// the SHARED and PRESERVED behaviours (hook contract, fixture
// endpoint, UI redirect semantics) and asserts the removal of the
// surfaces that no longer exist.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO       = path.resolve(__dirname, "..");
const SIDEBAR    = path.join(REPO, "src/components/sidebar-nav-data.ts");
const FIXTURE    = path.join(REPO, "src/app/api/admin/testing/coa-map-2a-fixture/route.ts");
const COA_PAGE   = path.join(REPO, "src/app/app/admin/coa/page.tsx");
const MAP_PAGE   = path.join(REPO, "src/app/app/admin/coa-mapping/page.tsx");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

describe("COA-MAP-2A §C (POST COA-MAP-3) — module integration retired", () => {
  const coaPage = readFileSync(COA_PAGE, "utf8");

  it("COA page no longer imports / renders CoaModeSwitch", () => {
    expect(coaPage).not.toMatch(/CoaModeSwitch/);
  });
});

describe("COA-MAP-2A §D (POST COA-MAP-3) — Mapping Studio nav removed", () => {
  const src = readFileSync(SIDEBAR, "utf8");

  it("Finance section no longer surfaces /app/admin/coa-mapping", () => {
    expect(src).not.toMatch(/href:\s*"\/app\/admin\/coa-mapping"/);
    expect(src).not.toMatch(/label:\s*"Financial Statement Mapping"/);
  });
});

describe("COA-MAP-2A §D' (POST COA-MAP-3) — Mapping Studio route redirects", () => {
  const src = stripComments(readFileSync(MAP_PAGE, "utf8"));

  it("page now redirects to /app/admin/coa (no editing surface)", () => {
    expect(src).toMatch(/redirect\(["']\/app\/admin\/coa["']\)/);
  });

  it("page no longer imports the deleted MappingWorkspaceClient", () => {
    expect(src).not.toMatch(/mapping-workspace-client/);
    expect(src).not.toMatch(/<MappingWorkspaceClient/);
  });
});

describe("COA-MAP-2A §E — disposable test fixture endpoint", () => {
  it("fixture route exists", () => {
    expect(existsSync(FIXTURE)).toBe(true);
  });

  const src = stripComments(readFileSync(FIXTURE, "utf8"));

  it("exposes POST + DELETE handlers", () => {
    expect(src).toMatch(/export async function POST\(/);
    expect(src).toMatch(/export async function DELETE\(/);
  });

  it("is staging-only (404 in production)", () => {
    expect(src).toMatch(/isStaging\(\)/);
    expect(src).toMatch(/"Not available in production\."/);
  });

  it("requires clubId + enforces tenant isolation", () => {
    expect(src).toMatch(/clubId required/);
    expect(src).toMatch(/hasClubAccess\(/);
  });

  it("creates exactly two BALANCE_SHEET groups + two ASSET accounts (COA-MAP-2B: anchor on Group B)", () => {
    const grpCount = (src.match(/prisma\.financialStatementGroup\.create\(/g) ?? []).length;
    expect(grpCount).toBe(2);
    const accCount = (src.match(/prisma\.account\.create\(/g) ?? []).length;
    expect(accCount).toBe(2);
    expect(src).toMatch(/statement:\s*"BALANCE_SHEET"/);
    expect(src).toMatch(/type:\s*"ASSET"/);
  });

  it("seeds effective-dated assignments for both accounts so the AS-OF resolver finds them today", () => {
    expect(src).toMatch(/prisma\.accountFinancialStatementAssignment\.createMany/);
    expect(src).toMatch(/effectiveFrom:\s*start/);
  });

  it("DELETE strictly prefix-matches on fixture key + name (never a blanket wipe)", () => {
    expect(src).toMatch(/startsWith:\s*`TENANT_\$\{fixtureKey\}_`/);
    expect(src).toMatch(/startsWith:\s*`\$\{fixtureKey\} —`/);
    expect(src).toMatch(/startsWith:\s*`\$\{fixtureKey\} `/);
  });

  it("DELETE runs inside a prisma.$transaction", () => {
    expect(src).toMatch(/prisma\.\$transaction\(async \(tx\)/);
  });
});
