// HR-2A (2026-08-16) — POST /api/people/employees/[id]/link-member.
//
// The route is a thin wrapper around the canonical service
// `linkEmployeeToMember`. These tests confirm the wrapper
// preserves the service contract from the outside:
//   • Same-club link succeeds (200).
//   • Cross-club link rejected (403) — even for SUPER_ADMIN, the
//     TenantViolationError becomes a friendly HTTP 403 in the body.
//   • Unauthenticated caller rejected (401).

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac, principalFor } from "../../util/db";
import { makeAdminHrFixture, makeMemberFor } from "../admin-workflows/_helpers";

// Auth plumbing — stub principal + activeClub before importing the route.
let currentPrincipal: Awaited<ReturnType<typeof principalFor>> | null = null;
vi.mock("@/lib/services/principal", () => ({
  getCurrentPrincipal: async () => currentPrincipal,
}));
vi.mock("@/lib/active-club", () => ({
  getActiveClubId: async ({ clubId }: { clubId: string | null }) => clubId,
}));

// eslint-disable-next-line import/first
import { POST } from "@/app/api/people/employees/[id]/link-member/route";

function jsonRequest(body: unknown): Request {
  return new Request("http://test.local/api/people/employees/x/link-member", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("HR-2A · POST /api/people/employees/[id]/link-member", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    currentPrincipal = null;
  });

  it("links Employee to Member when both are in the same club", async () => {
    const fx = await makeAdminHrFixture();
    const member = await makeMemberFor(fx.club.id, { firstName: "Riv", lastName: "Sensitive" });
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(jsonRequest({ memberId: member.id }) as any, { params: { id: fx.employee.id } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memberId).toBe(member.id);

    const row = await prisma.employee.findUnique({ where: { id: fx.employee.id } });
    expect(row?.memberId).toBe(member.id);
  });

  it("rejects cross-club link (Member in Club A, Employee in Club B) with 403", async () => {
    const fx = await makeAdminHrFixture();
    const foreignMember = await makeMemberFor(fx.foreignClub.id, {
      firstName: "Away",
      lastName: "Person",
    });
    // Even a SUPER_ADMIN is rejected — the invariant lives in the
    // canonical service and the route surfaces it as 403.
    currentPrincipal = fx.superAdmin;
    currentPrincipal.activeClubId = fx.club.id;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(jsonRequest({ memberId: foreignMember.id }) as any, { params: { id: fx.employee.id } });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/different club/i);
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const fx = await makeAdminHrFixture();
    const member = await makeMemberFor(fx.club.id);
    currentPrincipal = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(jsonRequest({ memberId: member.id }) as any, { params: { id: fx.employee.id } });
    expect(res.status).toBe(401);
  });

  it("rejects a caller without hr:employee:write (AUDITOR)", async () => {
    const fx = await makeAdminHrFixture();
    const member = await makeMemberFor(fx.club.id);
    currentPrincipal = fx.auditor;
    currentPrincipal.activeClubId = fx.club.id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(jsonRequest({ memberId: member.id }) as any, { params: { id: fx.employee.id } });
    expect(res.status).toBe(403);
  });

  it("returns 400 when memberId is missing", async () => {
    const fx = await makeAdminHrFixture();
    currentPrincipal = fx.clubAdmin;
    currentPrincipal.activeClubId = fx.club.id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(jsonRequest({}) as any, { params: { id: fx.employee.id } });
    expect(res.status).toBe(400);
  });
});
