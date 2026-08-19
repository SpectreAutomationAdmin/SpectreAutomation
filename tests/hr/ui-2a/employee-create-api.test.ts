// HR-2A (2026-08-16) — POST /api/people/employees route tests.
//
// Exercises the route as the browser sees it:
//   • Multipart form-data body via `req.formData()`.
//   • Required fields validated (returns 422 when missing).
//   • Same-club manager enforced (cross-club → error).
//   • New employees land in PRE_HIRE lifecycle with a DRAFT
//     onboarding session and payrollReadiness=NOT_READY (no
//     auto-activation).
//
// The auth surface is mocked so the test owns the principal + club;
// everything else runs against the real test DB and the real
// canonical HR services.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createEmployee } from "@/lib/hr/employees";
import { resetDb, seedRbac, principalFor } from "../../util/db";
import { makeAdminHrFixture } from "../admin-workflows/_helpers";

// ---------------------------------------------------------------------------
// Auth plumbing — stub principal + activeClub before importing the route.
// ---------------------------------------------------------------------------
let currentPrincipal: Awaited<ReturnType<typeof principalFor>> | null = null;
vi.mock("@/lib/services/principal", () => ({
  getCurrentPrincipal: async () => currentPrincipal,
}));
vi.mock("@/lib/active-club", () => ({
  getActiveClubId: async ({ clubId }: { clubId: string | null }) => clubId,
}));

// Import AFTER mocks are registered.
// eslint-disable-next-line import/first
import { POST } from "@/app/api/people/employees/route";

function makeFormData(overrides: Record<string, string | File | Blob | undefined> = {}) {
  const base: Record<string, string> = {
    firstName: "Alexandra",
    lastName: "Reyes",
    personalEmail: "alexandra.r@example.com",
    mobilePhone: "555-1234",
    expectedStartDate: "2026-09-01",
    employmentType: "FULL_TIME",
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    if (v === undefined) continue;
    fd.set(k, v as string);
  }
  return fd;
}

function toRequest(fd: FormData): Request {
  // NextRequest wraps the standard Request; the POST handler only
  // calls `.formData()`, so a plain Request is enough here.
  return new Request("http://test.local/api/people/employees", {
    method: "POST",
    body: fd,
  });
}

describe("HR-2A · POST /api/people/employees", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    currentPrincipal = null;
  });

  it("creates an Employee in PRE_HIRE + DRAFT onboarding session + payroll NOT_READY", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = fx.clubAdmin;
    // Ensure resolver picks the club we're testing against.
    currentPrincipal.activeClubId = fx.club.id;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(toRequest(makeFormData()) as any);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.employeeId).toBe("string");
    const created = await prisma.employee.findUnique({
      where: { id: body.employeeId },
      select: {
        firstName: true,
        lastName: true,
        clubId: true,
        employeeLifecycle: true,
        payrollReadiness: true,
        onboardingState: true,
      },
    });
    expect(created).not.toBeNull();
    expect(created!.firstName).toBe("Alexandra");
    expect(created!.clubId).toBe(fx.club.id);
    expect(created!.employeeLifecycle).toBe("PRE_HIRE");
    expect(created!.payrollReadiness).toBe("NOT_READY");
    // Session sync happens inside createSession — Employee mirror
    // should read DRAFT.
    expect(created!.onboardingState).toBe("DRAFT");
    const sessions = await prisma.employeeOnboardingSession.findMany({
      where: { employeeId: body.employeeId },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].state).toBe("DRAFT");
  });

  it("returns 422 when a required field is missing", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;
    const fd = makeFormData({ firstName: "" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(toRequest(fd) as any);
    expect(res.status).toBe(422);
  });

  it("rejects cross-club manager assignment", async () => {
    const fx = await makeAdminHrFixture();
    // Create a manager in the foreign club.
    const foreignManager = await createEmployee(fx.superAdmin, fx.foreignClub.id, {
      firstName: "Away", lastName: "Manager",
    });
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;
    const fd = makeFormData({ managerEmployeeId: foreignManager.id });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(toRequest(fd) as any);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects an unauthenticated caller", async () => {
    currentPrincipal = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(toRequest(makeFormData()) as any);
    expect(res.status).toBe(401);
  });

  it("rejects a caller without hr:employee:write (AUDITOR_READ_ONLY)", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = fx.auditor;
    currentPrincipal.activeClubId = fx.club.id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(toRequest(makeFormData()) as any);
    expect(res.status).toBe(403);
  });

  it("opens an initial EmploymentPeriod matching expected start date", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(
      toRequest(makeFormData({ expectedStartDate: "2027-01-15" })) as any,
    );
    expect(res.status).toBe(201);
    const { employeeId } = await res.json();
    const periods = await prisma.employmentPeriod.findMany({
      where: { employeeId },
      orderBy: { effectiveFrom: "asc" },
    });
    expect(periods).toHaveLength(1);
    expect(periods[0].reason).toBe("HIRE");
    expect(periods[0].employmentType).toBe("FULL_TIME");
    expect(periods[0].effectiveTo).toBeNull();
    expect(periods[0].effectiveFrom.toISOString().startsWith("2027-01-15")).toBe(true);
  });
});
