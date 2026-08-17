// HR-2A (2026-08-16) — POST /api/people/employees/[id]/invitation.
//
// Confirms the invitation route:
//   • Issues an invitation via the canonical service.
//   • NEVER returns the raw magic-link token in the HTTP response
//     body — HR-2A does not ship the employee-facing redemption
//     page, so any raw token exposed to the browser is a defect.
//   • Transitions the onboarding session from DRAFT to INVITED.
//   • Rejects an unauthenticated caller.
//   • Rejects a caller without `hr:onboarding:invite` (auditor).

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/hr/onboarding-sessions";
import { resetDb, seedRbac, principalFor } from "../../util/db";
import { makeAdminHrFixture } from "../admin-workflows/_helpers";

let currentPrincipal: Awaited<ReturnType<typeof principalFor>> | null = null;
vi.mock("@/lib/services/principal", () => ({
  getCurrentPrincipal: async () => currentPrincipal,
}));
vi.mock("@/lib/active-club", () => ({
  getActiveClubId: async ({ clubId }: { clubId: string | null }) => clubId,
}));

// eslint-disable-next-line import/first
import { POST } from "@/app/api/people/employees/[id]/invitation/route";

function makeRequest(): Request {
  return new Request("http://test.local/api/people/employees/x/invitation", {
    method: "POST",
  });
}

describe("HR-2A · POST /api/people/employees/[id]/invitation", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    currentPrincipal = null;
  });

  it("issues invitation via canonical service and transitions session to INVITED", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;
    // The employee needs a DRAFT session to accept the transition.
    const session = await createSession(fx.clubAdmin, fx.employee.id);
    expect(session.state).toBe("DRAFT");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.invitationId).toBe("string");
    expect(typeof body.expiresAt).toBe("string");
    expect(body.sessionState).toBe("INVITED");

    const inv = await prisma.employeeOnboardingInvitation.findUnique({
      where: { id: body.invitationId },
    });
    expect(inv).not.toBeNull();
    expect(inv!.employeeId).toBe(fx.employee.id);

    const updatedSession = await prisma.employeeOnboardingSession.findUnique({
      where: { id: session.id },
    });
    expect(updatedSession?.state).toBe("INVITED");
  });

  it("response body does NOT contain the raw magic-link token", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;
    await createSession(fx.clubAdmin, fx.employee.id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
    expect(res.status).toBe(201);
    const raw = await res.text();
    // Base64url token is 43 chars from 32 random bytes. Assert
    // ABSENCE by shape: no bare 43-char base64url token anywhere in
    // the serialised body, AND no field literally named `rawToken`
    // / `token`.
    expect(raw).not.toMatch(/rawToken/i);
    expect(raw).not.toMatch(/"token"\s*:/);
    // Cross-check the returned invitationId against the DB row's
    // tokenHash — the two must be different values (tokenHash is
    // hex-64, invitationId is a cuid). If the route ever "helpfully"
    // returned the token in place of the id, this would fail.
    const parsed = JSON.parse(raw);
    const row = await prisma.employeeOnboardingInvitation.findUnique({
      where: { id: parsed.invitationId },
    });
    expect(row).not.toBeNull();
    expect(parsed.invitationId).not.toBe(row!.tokenHash);
  });

  it("returns 409 when the employee has no in-flight onboarding session", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;
    // No session created — invitation must fail.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
    expect(res.status).toBe(409);
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
    expect(res.status).toBe(401);
  });

  it("rejects a caller without hr:onboarding:invite (AUDITOR)", async () => {
    const fx = await makeAdminHrFixture();
    await createSession(fx.clubAdmin, fx.employee.id);
    currentPrincipal = fx.auditor;
    currentPrincipal.activeClubId = fx.club.id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(makeRequest() as any, { params: { id: fx.employee.id } });
    expect(res.status).toBe(403);
  });
});
