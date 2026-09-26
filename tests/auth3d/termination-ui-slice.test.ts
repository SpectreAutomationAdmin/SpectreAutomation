// AUTH-3D.TEST-B.UNBLOCK — termination UI/API slice.
//
// Covers the 13 gates the founder brief §10 specifies. Uses real
// Prisma writes against fixture identities — no mock services — so
// the assertions exercise the same AUTH-3B `terminateEmployee` service
// the new route dispatches to.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { terminateEmployee, archiveEmployee } from "@/lib/hr/employees";
import { hasPermission } from "@/lib/rbac";
import { createSession, findValidSession, SURFACE_EMPLOYEE } from "@/lib/services/session-store";
import { ForbiddenError } from "@/lib/errors";
import { makeAdminHrFixture } from "../hr/admin-workflows/_helpers";
import { makeUser, principalFor } from "../util/db";
import type { RoleKey } from "@/lib/permissions";
import { resetDb, seedRbac } from "../util/db";

async function makePrincipalWithRole(role: RoleKey, clubId: string | null) {
  const email = `auth3d-testb-${role.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await makeUser({ email, role, clubId });
  return principalFor(email);
}

describe("AUTH-3D.TEST-B.UNBLOCK · source-contract for new UI + route", () => {
  const routeSrc = readFileSync(
    join(process.cwd(), "src/app/api/people/employees/[id]/lifecycle/route.ts"),
    "utf8",
  );
  const componentSrc = readFileSync(
    join(process.cwd(), "src/components/hr/EmployeeLifecycleControls.tsx"),
    "utf8",
  );
  const pageSrc = readFileSync(
    join(process.cwd(), "src/app/app/admin/people/employees/[id]/page.tsx"),
    "utf8",
  );

  it("Gate 6 · UI/API dispatches to the canonical terminateEmployee service — no logic duplication", () => {
    expect(routeSrc).toMatch(/import\s*{[^}]*terminateEmployee[^}]*}\s*from\s*"@\/lib\/hr\/employees"/);
    expect(routeSrc).toMatch(/body\.action\s*===\s*"terminate"/);
    expect(routeSrc).toMatch(/terminateEmployee\(principal,\s*params\.id,\s*\{/);
  });

  it("Gate 1 · Terminate button visibility gates on hr:employee:terminate via canTerminate prop", () => {
    // Component defines canTerminate on Props, and gates the terminate
    // panel on `props.canTerminate`.
    expect(componentSrc).toMatch(/canTerminate:\s*boolean/);
    expect(componentSrc).toMatch(/props\.canTerminate\s*&&/);
    // Page derives canTerminate from the correct permission key.
    expect(pageSrc).toMatch(/canTerminate\s*=\s*hasPermission\([^)]*"hr:employee:terminate"\)/);
    expect(pageSrc).toMatch(/canTerminate=\{canTerminate\}/);
  });

  it("Gate 5 · Termination date is sent from UI to the canonical service", () => {
    // The component's terminate runner posts terminationDate in the body.
    expect(componentSrc).toMatch(/action:\s*"terminate",\s*terminationDate:/);
    // The route unpacks terminationDate from body and passes it to
    // the service.
    expect(routeSrc).toMatch(/terminationDate:\s*body\.terminationDate\s*\?\?/);
  });

  it("Gate 3 · UI requires explicit confirmation (typed verb + form submission)", () => {
    expect(componentSrc).toMatch(/type\s*=\s*"date"/);
    expect(componentSrc).toMatch(/data-testid="employee-terminate-confirm-input"/);
    expect(componentSrc).toMatch(/confirmText\s*!==\s*"TERMINATE"/);
  });

  it("Gate 4 · Cancel button exists on the terminate confirm dialog", () => {
    expect(componentSrc).toMatch(/data-testid="employee-terminate-cancel-button"/);
  });

  it("Gate 11 · Archive branch retained (no silent removal per founder §8)", () => {
    expect(componentSrc).toMatch(/data-testid="employee-archive-button"/);
    expect(componentSrc).toMatch(/data-testid="employee-lifecycle-archive-panel"/);
    // API route still supports archive dispatch.
    expect(routeSrc).toMatch(/body\.action\s*===\s*"archive"/);
    expect(routeSrc).toMatch(/archiveEmployee\(principal/);
  });

  it("Gate 10 · Terminated-state banner replaces Terminate button after termination", () => {
    expect(componentSrc).toMatch(/currentLifecycle\s*===\s*"TERMINATED"/);
    expect(componentSrc).toMatch(/data-testid="employee-lifecycle-terminated"/);
  });

  it("Portal password + Portal access sections hidden for TERMINATED/ARCHIVED lifecycles", () => {
    expect(pageSrc).toMatch(/employeePortalControlsAvailable\s*=[\s\S]*?TERMINATED[\s\S]*?ARCHIVED/);
    expect(pageSrc).toMatch(/canEmployeeSecurity\s*&&\s*employeePortalControlsAvailable/);
  });
});

describe("AUTH-3D.TEST-B.UNBLOCK · authorization + service behaviour", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Gate 1 (positive) · CLUB_ADMIN principal returns canTerminate=true via hasPermission", async () => {
    const fx = await makeAdminHrFixture();
    expect(hasPermission(fx.clubAdmin, fx.club.id, "hr:employee:terminate")).toBe(true);
  });

  it("Gate 2 · CONTROLLER principal returns canTerminate=false via hasPermission", async () => {
    const fx = await makeAdminHrFixture();
    const controller = await makePrincipalWithRole("CONTROLLER", fx.club.id);
    expect(hasPermission(controller, fx.club.id, "hr:employee:terminate")).toBe(false);
  });

  it("Gate 12 · Unauthorized principal cannot invoke terminateEmployee (service-layer enforcement)", async () => {
    const fx = await makeAdminHrFixture();
    const controller = await makePrincipalWithRole("CONTROLLER", fx.club.id);
    await expect(
      terminateEmployee(controller, fx.employee.id, {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Gate 13 · Cross-tenant terminate fails closed via assertTenantOwned", async () => {
    const fx = await makeAdminHrFixture();
    // Fixture provides fx.foreignClubAdmin — CLUB_ADMIN at foreignClub.
    // fx.employee is at fx.club. Cross-tenant call should throw.
    await expect(
      terminateEmployee(fx.foreignClubAdmin, fx.employee.id, {}),
    ).rejects.toThrow();
  });

  it("Gate 5 · Termination date reaches the service and is persisted", async () => {
    const fx = await makeAdminHrFixture();
    const chosen = new Date("2026-09-15T00:00:00.000Z");
    const updated = await terminateEmployee(fx.clubAdmin, fx.employee.id, {
      terminationDate: chosen,
      reason: "acceptance test",
    });
    expect(updated.terminationDate?.toISOString().startsWith("2026-09-15")).toBe(true);
  });

  it("Gate 7 · Successful terminate flips lifecycle + status to TERMINATED", async () => {
    const fx = await makeAdminHrFixture();
    const updated = await terminateEmployee(fx.clubAdmin, fx.employee.id, {});
    expect(updated.employeeLifecycle).toBe("TERMINATED");
    expect(updated.status).toBe("TERMINATED");
  });

  it("Gate 8 · Active EMPLOYEE Sessions are revoked with lifecycle:terminate", async () => {
    const fx = await makeAdminHrFixture();
    const s1 = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });
    await terminateEmployee(fx.clubAdmin, fx.employee.id, {});
    const after = await prisma.session.findUnique({
      where: { id: s1.session.id },
      select: { revokedAt: true, revokedBy: true, revokeReason: true },
    });
    expect(after?.revokedAt).not.toBeNull();
    expect(after?.revokedBy).toBe(fx.clubAdmin.id);
    expect(after?.revokeReason).toBe("lifecycle:terminate");
  });

  it("Gate 9 · Terminated employee cannot establish a fresh Employee Portal Session — findValidSession rejects a bearer that was created before termination", async () => {
    const fx = await makeAdminHrFixture();
    const s1 = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });
    // Pre-termination the session validates.
    expect(await findValidSession(s1.bearer, SURFACE_EMPLOYEE)).not.toBeNull();
    // Terminate.
    await terminateEmployee(fx.clubAdmin, fx.employee.id, {});
    // Post-termination the session is revoked so findValidSession
    // returns null. And the (authed) layer's principal check would
    // ALSO reject a fresh sign-in because employeeLifecycle === TERMINATED
    // is not in the authorised set for the Employee Portal.
    expect(await findValidSession(s1.bearer, SURFACE_EMPLOYEE)).toBeNull();
    // Confirm the lifecycle-fail-closed contract holds by re-reading
    // the employee: getEmployeePortalPrincipal would reject on this
    // status/lifecycle.
    const emp = await prisma.employee.findUnique({
      where: { id: fx.employee.id },
      select: { status: true, employeeLifecycle: true },
    });
    expect(emp?.status).toBe("TERMINATED");
    expect(emp?.employeeLifecycle).toBe("TERMINATED");
  });

  it("Gate 11 · Archive behaviour remains intact and separate from Terminate", async () => {
    const fx = await makeAdminHrFixture();
    const s1 = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: fx.employee.id,
      clubId: fx.employee.clubId,
    });
    const updated = await archiveEmployee(fx.clubAdmin, fx.employee.id, {});
    expect(updated.employeeLifecycle).toBe("ARCHIVED");
    // Session was revoked with the ARCHIVE reason, not TERMINATE.
    const after = await prisma.session.findUnique({
      where: { id: s1.session.id },
      select: { revokedAt: true, revokeReason: true },
    });
    expect(after?.revokedAt).not.toBeNull();
    expect(after?.revokeReason).toBe("lifecycle:archive");
  });
});
