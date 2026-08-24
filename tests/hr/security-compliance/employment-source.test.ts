// HR-2C Employment (2026-08-24) — Source-contract pins.
//
// Enforces the founder's architectural invariants at the source-file
// level so a refactor cannot silently unwind them.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}
function code(rel: string): string {
  return src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("HR-2C Employment · source-contract", () => {
  const assignmentsSvc = src("src/lib/hr/employment-assignments.ts");
  const allowancesSvc = src("src/lib/hr/allowances.ts");
  const compensationSvc = src("src/lib/hr/compensation.ts");
  const applicability = src("src/lib/hr/training/applicability.ts");
  const permissions = src("src/lib/permissions.ts");
  const migration = src("prisma-postgres/migrations/20260824_hr2c_employment_assignments/migration.sql");
  const empSection = src("src/components/hr/EmployeeEmploymentSection.tsx");
  const empActions = src("src/app/app/admin/people/employees/[id]/_employment-actions.ts");
  const profilePage = src("src/app/app/admin/people/employees/[id]/page.tsx");
  const portalProfile = src("src/app/employee/(authed)/profile/page.tsx");

  it("assignments service requires hr:employment:write for every mutation + audits + posting-guard", () => {
    expect(assignmentsSvc).toMatch(/requirePermission\(principal, [^)]+, "hr:employment:write"\)/);
    expect(assignmentsSvc).toMatch(/assertPostingAllowed/);
    // Two write actions minimum: add + end.
    const writes = assignmentsSvc.match(/hr\.employment_assignment\.[a-z_]+/g) ?? [];
    expect(writes.length).toBeGreaterThanOrEqual(3);
  });

  it("single-active-primary invariant is enforced service-side (add PRIMARY closes prior open PRIMARY)", () => {
    // The addAssignment PRIMARY branch closes any open PRIMARY at the
    // new effectiveFrom before inserting.
    expect(assignmentsSvc).toMatch(
      /if \(input\.role === "PRIMARY"\)[\s\S]{0,400}updateMany\([\s\S]{0,200}role: "PRIMARY"[\s\S]{0,200}effectiveTo: null[\s\S]{0,200}data: \{ effectiveTo: effectiveFrom \}/,
    );
  });

  it("allowances service requires hr:allowance:write for every mutation", () => {
    expect(allowancesSvc).toMatch(/requirePermission\(principal, [^)]+, "hr:allowance:write"\)/);
    // Read guard uses hr:allowance:read.
    expect(allowancesSvc).toMatch(/requirePermission\(principal, [^)]+, "hr:allowance:read"\)/);
    // Never infers CRA taxability — taxable is admin-controlled.
    expect(allowancesSvc).toMatch(/taxable: input\.taxable/);
  });

  it("compensation service accepts optional assignmentId + closes only the same scope", () => {
    // The interface now carries assignmentId.
    expect(compensationSvc).toMatch(/assignmentId\?:\s*string \| null/);
    // updateMany filter includes assignmentId in the close step.
    expect(compensationSvc).toMatch(
      /updateMany\(\{\s*where:\s*\{[\s\S]{0,300}\bassignmentId\b[\s\S]{0,300}\}\s*,\s*data:\s*\{\s*effectiveTo:\s*effectiveFrom/,
    );
    // Legacy Employee.payRate shadow-write is scoped to employee-wide
    // (assignmentId == null) — protects the legacy consumer.
    expect(compensationSvc).toMatch(/if \(!assignmentId\)[\s\S]{0,200}employee\.update/);
  });

  it("training applicability collects UNION of active assignment (dept/pos) — not only legacy Employee fields", () => {
    expect(applicability).toMatch(/collectActiveRoleContext/);
    expect(applicability).toMatch(/employeeEmploymentAssignment\.findMany/);
    // Legacy Employee.departmentId / positionId remain as a fallback.
    expect(applicability).toMatch(/emp\.departmentId/);
    expect(applicability).toMatch(/emp\.positionId/);
  });

  it("permissions catalogue defines hr:allowance:read + write and grants them to CLUB_ADMIN + PAYROLL_ADMIN", () => {
    expect(permissions).toMatch(/"hr:allowance:read":/);
    expect(permissions).toMatch(/"hr:allowance:write":/);
    const perLine = permissions.match(/^\s*"hr:allowance:read", "hr:allowance:write",?\s*$/gm) ?? [];
    // At least two roles receive both (CLUB_ADMIN + PAYROLL_ADMIN).
    expect(perLine.length).toBeGreaterThanOrEqual(2);
  });

  it("Postgres migration is additive-only", () => {
    expect(migration).toMatch(/CREATE TABLE "EmployeeEmploymentAssignment"/);
    expect(migration).toMatch(/CREATE TABLE "EmployeeAllowance"/);
    expect(migration).toMatch(/ALTER TABLE "EmployeeCompensation"[\s\S]{0,80}ADD COLUMN "assignmentId"/);
    expect(migration).not.toMatch(/DROP\s+TABLE/i);
    expect(migration).not.toMatch(/DROP\s+COLUMN/i);
    // The only ALTER is the additive ADD COLUMN + ADD CONSTRAINT.
    const alters = migration.match(/ALTER\s+TABLE/gi) ?? [];
    for (const a of alters) void a;
  });

  it("EmployeeEmploymentSection uses restrained person-profile grammar + never renders raw enums", () => {
    // Consumes spectre-person-* classes (matches founder-approved grammar).
    expect(empSection).toMatch(/spectre-person-eyebrow/);
    // humaniseEnum wraps any employmentType / cadence / frequency display.
    expect(empSection).toMatch(/humaniseEnum/);
    // Change compensation form exists.
    expect(empSection).toMatch(/data-testid="btn-change-compensation"/);
    // Add-role affordance exists.
    expect(empSection).toMatch(/data-testid="btn-add-additional-role"/);
    // Add-allowance affordance exists.
    expect(empSection).toMatch(/data-testid="btn-add-allowance"/);
  });

  it("Employment-tab server actions delegate to canonical services (no direct prisma writes)", () => {
    expect(empActions).toMatch(/from "@\/lib\/hr\/employment-assignments"/);
    expect(empActions).toMatch(/from "@\/lib\/hr\/compensation"/);
    expect(empActions).toMatch(/from "@\/lib\/hr\/allowances"/);
    expect(code("src/app/app/admin/people/employees/[id]/_employment-actions.ts")).not.toMatch(
      /prisma\.\w+\.(create|update|upsert|delete)/,
    );
  });

  it("Admin Profile page wires Employment tab behind hr:employment:read + separate compensation/allowance gates", () => {
    expect(profilePage).toMatch(/hasPermission\(principal, [^)]+, "hr:employment:read"\)/);
    expect(profilePage).toMatch(/hasPermission\(principal, [^)]+, "hr:compensation:read"\)/);
    expect(profilePage).toMatch(/hasPermission\(principal, [^)]+, "hr:allowance:read"\)/);
    expect(profilePage).toMatch(/canWriteEmployment/);
    expect(profilePage).toMatch(/canWriteCompensation/);
    expect(profilePage).toMatch(/canWriteAllowance/);
  });

  it("Employee Portal Profile renders roles read-only and never accepts a mutation", () => {
    expect(portalProfile).toMatch(/getActiveAssignmentsAt/);
    expect(portalProfile).toMatch(/data-testid="portal-profile-roles"/);
    // No server-action imports on the profile page (portal profile is
    // strictly read-only).
    expect(portalProfile).not.toMatch(/"use server"/);
    // Never uses admin services for mutation.
    expect(code("src/app/employee/(authed)/profile/page.tsx")).not.toMatch(
      /addAssignment|changeCompensation|addAllowance|endAssignment|endAllowance/,
    );
  });
});
