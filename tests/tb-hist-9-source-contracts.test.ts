// TB-HIST-9 (2026-10-02) — source-contract regression guards for
// the admin-page immutability fix + BS data-freshness UX. The
// end-to-end numeric validation + May 2026 recovery evidence
// runs against staging in tests/e2e/tb-hist-9-*.staging.spec.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const ADMIN_PAGE = readFileSync(path.join(REPO, "src/app/app/admin/reporting/monthly/page.tsx"), "utf8");
const BS_PAGE = readFileSync(path.join(REPO, "src/app/app/admin/reports/balance-sheet/page.tsx"), "utf8");
const DIAGNOSTIC_ROUTE = readFileSync(path.join(REPO, "src/app/api/admin/monthly-package-diagnostic/route.ts"), "utf8");

// -------------------------------------------------------------------
// §4-7 — Admin page serves frozen packagePayloadJson for PUBLISHED/
//        SENT/ARCHIVED rows (immutable historical artifact).
// -------------------------------------------------------------------
describe("TB-HIST-9 §4-7 — admin page respects frozen Published-package payload", () => {
  it("the monthlyPackage row SELECT now pulls packagePayloadJson", () => {
    expect(ADMIN_PAGE).toMatch(/packagePayloadJson:\s*true,/);
  });

  it("defines an `isFrozen` guard keyed on status + payload presence", () => {
    expect(ADMIN_PAGE).toMatch(/const\s+isFrozen\s*=[\s\S]{0,500}\["PUBLISHED",\s*"SENT",\s*"ARCHIVED"\]\.includes\(monthlyPackageRow\.status\)/);
    expect(ADMIN_PAGE).toMatch(/typeof\s+monthlyPackageRow\.packagePayloadJson\s*===\s*"string"/);
  });

  it("parses the frozen payload and prefers it over the live rebuild via `??`", () => {
    expect(ADMIN_PAGE).toMatch(/frozenPayload\s*=\s*JSON\.parse\(monthlyPackageRow\.packagePayloadJson!\)/);
    expect(ADMIN_PAGE).toMatch(/const\s+pkg\s*=\s*\n?\s*frozenPayload\s*\?\?/);
  });

  it("DRAFT rows (and no-row case) still fall through to the live rebuild", () => {
    // The live-rebuild call pattern must survive — DRAFT packages
    // need to refresh/recalculate from current source data (§4).
    expect(ADMIN_PAGE).toMatch(/getMonthlyReportingPackage\(clubId,\s*\{\s*period,\s*viewerCanDrillDown\s*\}\)/);
    expect(ADMIN_PAGE).toMatch(/getMonthlyReportingPackage\(clubId,\s*\{\s*viewerCanDrillDown\s*\}\)/);
  });

  it("the admin fix is documented inline (TB-HIST-9 anchor comment)", () => {
    expect(ADMIN_PAGE).toMatch(/TB-HIST-9[\s\S]{0,100}PUBLISHED-package immutability/);
  });
});

// -------------------------------------------------------------------
// §21 — Balance Sheet data-freshness UX surfaces the carry-forward
//       close date when it differs from the requested asOf.
// -------------------------------------------------------------------
describe("TB-HIST-9 §21 — Balance Sheet shows 'Financial data through <date>' on carry-forward", () => {
  it("the BS page branches on provenance.capturedAt vs the requested asOf", () => {
    expect(BS_PAGE).toMatch(/bs\.source\s*===\s*"AUTHORITATIVE_SNAPSHOT"\s*&&\s*bs\.provenance/);
    expect(BS_PAGE).toMatch(/bs\.provenance\.capturedAt\.toISOString\(\)\.slice\(0,\s*10\)/);
  });

  it("renders a restrained 'Financial data through' pill when they differ", () => {
    expect(BS_PAGE).toMatch(/data-testid="bs-report-data-through"/);
    expect(BS_PAGE).toMatch(/Financial data through/);
    expect(BS_PAGE).toMatch(/Latest committed close for this club/);
  });

  it("falls back to the operational-source pill when the resolver served live data", () => {
    expect(BS_PAGE).toMatch(/data-testid="bs-report-source-operational"/);
  });
});

// -------------------------------------------------------------------
// Diagnostic endpoint — staging-only MonthlyPackage read
// -------------------------------------------------------------------
describe("TB-HIST-9 — staging-only MonthlyPackage diagnostic endpoint", () => {
  it("rejects production access via isStaging() guard", () => {
    expect(DIAGNOSTIC_ROUTE).toMatch(/if\s*\(!isStaging\(\)\)\s*\{\s*return\s+NextResponse\.json\(\{\s*error:\s*"Not available in production\./);
  });

  it("enforces principal + tenant membership before any DB read", () => {
    expect(DIAGNOSTIC_ROUTE).toMatch(/const\s+principal\s*=\s*await\s+requirePrincipal\(\)/);
    expect(DIAGNOSTIC_ROUTE).toMatch(/if\s*\(!hasClubAccess\(principal,\s*clubId\)\)/);
  });

  it("returns the one targeted row when year+month supplied, else lists all for the club", () => {
    expect(DIAGNOSTIC_ROUTE).toMatch(/prisma\.monthlyPackage\.findUnique\(\{[\s\S]{0,500}clubId_reportingYear_reportingMonth/);
    expect(DIAGNOSTIC_ROUTE).toMatch(/prisma\.monthlyPackage\.findMany\(\{[\s\S]{0,200}where:\s*\{\s*clubId\s*\}/);
  });

  it("exposes packagePayloadJson_bytes (length only — not the full payload)", () => {
    expect(DIAGNOSTIC_ROUTE).toMatch(/packagePayloadJson_bytes:\s*row\.packagePayloadJson\s*\?\s*row\.packagePayloadJson\.length\s*:\s*0/);
    // Must NOT return the full JSON in the diagnostic response (keeps
    // the endpoint lightweight and avoids payload leakage via logs).
    expect(DIAGNOSTIC_ROUTE).not.toMatch(/packagePayloadJson:\s*row\.packagePayloadJson,\s*\n/);
  });

  it("GET-only — no POST / PATCH / DELETE handler leaks a mutation path", () => {
    expect(DIAGNOSTIC_ROUTE).toMatch(/export\s+async\s+function\s+GET\(/);
    expect(DIAGNOSTIC_ROUTE).not.toMatch(/export\s+async\s+function\s+(POST|PATCH|DELETE|PUT)\(/);
  });
});
