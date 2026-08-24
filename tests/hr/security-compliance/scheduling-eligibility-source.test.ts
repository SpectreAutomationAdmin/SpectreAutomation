// HR-2C B4 (2026-08-23) — Scheduling-eligibility source-contract.
//
// Pins the architectural invariants the founder called out:
//   §1   No `Employee.trainingComplete` / `canBeScheduled` /
//        `trainingEligible` (or any equivalent sticky boolean) is
//        introduced. Eligibility remains a DERIVED read only.
//   §4   Every Availability mutation path passes through the guard.
//   §7   The Schedule page consults the guard for its informational
//        state.
//   §8   The Home compliance card is upgraded to the actionable
//        "Action required" copy when ineligible + a positive
//        "Up to date" state when eligible.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}
function code(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("HR-2C B4 · source-contract", () => {
  const guard = src("src/lib/hr/scheduling-eligibility.ts");
  const availabilityService = src("src/lib/hr/availability.ts");
  const actionsRaw = src("src/app/employee/(authed)/availability/_actions.ts");
  const availabilityPage = src("src/app/employee/(authed)/availability/page.tsx");
  const availabilityForm = src("src/app/employee/(authed)/availability/AvailabilityWeekForm.tsx");
  const schedulePage = src("src/app/employee/(authed)/schedule/page.tsx");
  const homePage = src("src/app/employee/(authed)/page.tsx");
  const schemaSqlite = src("prisma/schema.prisma");
  const schemaPg = src("prisma-postgres/schema.prisma");
  const migration = src("prisma-postgres/migrations/20260823_hr2c_b4_availability/migration.sql");

  it("§1 — no sticky training-eligibility boolean on Employee (SQLite schema)", () => {
    for (const bad of ["trainingComplete", "canBeScheduled", "trainingEligible"]) {
      expect(schemaSqlite).not.toMatch(new RegExp(`\\b${bad}\\b`));
      expect(schemaPg).not.toMatch(new RegExp(`\\b${bad}\\b`));
    }
  });

  it("guard wraps the B1 resolver (single source of truth)", () => {
    expect(guard).toMatch(/resolveEmployeeSchedulingEligibility/);
    expect(guard).toMatch(/class SchedulingIneligibleError extends AppError/);
    expect(guard).toMatch(/assertSchedulingEligibility/);
    // Guard never writes anything.
    expect(code("src/lib/hr/scheduling-eligibility.ts")).not.toMatch(
      /prisma\.\w+\.(create|update|upsert|delete|deleteMany|updateMany)/,
    );
  });

  it("SchedulingIneligibleError payload is display-safe (titles only, no internal ids/enums)", () => {
    expect(guard).toMatch(/interface OutstandingTrainingTitle/);
    // Only these three keys appear on the display type — no versionId,
    // no course code, no required-flag.
    expect(guard).toMatch(/courseId:\s*string/);
    expect(guard).toMatch(/title:\s*string/);
    expect(guard).toMatch(/category:\s*string/);
    // The construction path maps ONLY the safe fields.
    expect(guard).toMatch(
      /outstanding\.map\(\([^)]*\)\s*=>\s*\({\s*courseId[^}]*title[^}]*category/,
    );
  });

  it("availability service invokes assertSchedulingEligibility BEFORE any prisma write", () => {
    // Regex: within saveAvailabilityWeek, the guard call must appear
    // BEFORE the first prisma.employeeAvailabilityWeek.upsert.
    const svc = availabilityService;
    const fnStart = svc.indexOf("export async function saveAvailabilityWeek");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = svc.slice(fnStart);
    const guardIdx = fnBody.indexOf("assertSchedulingEligibility");
    const writeIdx = fnBody.indexOf("employeeAvailabilityWeek.upsert");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(writeIdx);
  });

  it("availability read (listAvailabilityWeeks) is NOT guarded — ineligible employees may still view (§2)", () => {
    const svc = availabilityService;
    const fnStart = svc.indexOf("export async function listAvailabilityWeeks");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = svc.indexOf("\n}\n", fnStart);
    const fnBody = svc.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/assertSchedulingEligibility/);
  });

  it("server action delegates to canonical service (no direct prisma writes)", () => {
    expect(actionsRaw).toMatch(/from "@\/lib\/hr\/availability"/);
    expect(actionsRaw).toMatch(/saveAvailabilityWeek/);
    expect(code("src/app/employee/(authed)/availability/_actions.ts")).not.toMatch(
      /prisma\.\w+\.(create|update|upsert|delete)/,
    );
    // Portal principal, not admin.
    expect(actionsRaw).toMatch(/getEmployeePortalPrincipal/);
    expect(actionsRaw).not.toMatch(/getCurrentPrincipal/);
    // The action catches SchedulingIneligibleError specifically so the
    // client can surface the training-required banner.
    expect(actionsRaw).toMatch(/SchedulingIneligibleError/);
  });

  it("Availability page renders training-required panel + preserves read of existing rows", () => {
    expect(availabilityPage).toMatch(/getSchedulingEligibilitySummary/);
    expect(availabilityPage).toMatch(/data-testid="portal-availability-training-required"/);
    expect(availabilityPage).toMatch(/Complete required training/);
    // Existing rows visible even when ineligible (form disabled but
    // the section still renders).
    expect(availabilityPage).toMatch(/data-testid="portal-availability-weeks"/);
    // Never exposes internal ids/enums (§3).
    for (const forbidden of ["courseVersionId", "versionId"]) {
      expect(code("src/app/employee/(authed)/availability/page.tsx")).not.toMatch(
        new RegExp(`\\b${forbidden}\\b`),
      );
    }
  });

  it("Availability form disables ALL inputs when not editable (crafted click can't unlock)", () => {
    expect(availabilityForm).toMatch(/disabled=\{!editable\}/);
    // Save button only rendered when editable.
    expect(availabilityForm).toMatch(/\{editable && \(/);
  });

  it("Schedule page consults the eligibility summary + shows informational state (§7)", () => {
    expect(schedulePage).toMatch(/getSchedulingEligibilitySummary/);
    expect(schedulePage).toMatch(/data-testid="portal-schedule-eligibility"/);
    expect(schedulePage).toMatch(/Scheduling eligibility/);
    // No history to hide — but the page must NEVER hide the empty
    // schedule state just because the employee is ineligible.
    expect(schedulePage).toMatch(/data-testid="portal-schedule-empty"/);
  });

  it("Home compliance reminder derives from the canonical resolver + links to Training (§8, updated for 2026-08-24 Home refinement)", () => {
    // The B4 compliance-card DOM shape was replaced by the Home
    // refinement (thin dismissible notification bars). The founder
    // invariant carried over unchanged: Home consumes the canonical
    // resolver and links to /employee/safety-training when action is
    // required. The bar's message + tone are asserted in
    // home-notifications.test.ts.
    expect(homePage).toMatch(/buildHomeNotifications/);
    // Training destination is one of the widget hrefs.
    expect(homePage).toMatch(/href: "\/employee\/safety-training"/);
    // Notification region rendered conditionally.
    expect(homePage).toMatch(/data-testid="portal-home-notifications"/);
  });

  it("Migration is additive-only + creates one table with (employeeId, weekStart) unique key", () => {
    expect(migration).toMatch(/CREATE TABLE "EmployeeAvailabilityWeek"/);
    expect(migration).toMatch(/CREATE UNIQUE INDEX "EmployeeAvailabilityWeek_employeeId_weekStart_key"/);
    // Additive-only — no DROP TABLE, no ALTER COLUMN, no data
    // back-fill.
    expect(migration).not.toMatch(/DROP\s+TABLE/i);
    expect(migration).not.toMatch(/ALTER\s+TABLE/i);
    expect(migration).not.toMatch(/UPDATE\s+"[^"]+"\s+SET/i);
  });
});
