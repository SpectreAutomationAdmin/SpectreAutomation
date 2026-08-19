// Phase 20 (Member Database, 2026-08-15) — integration tests for
// the new member-groups + member-custom-fields services. Verifies
// tenant scoping, idempotency, group add/remove, custom-field
// upsert/clear, permission gating.

import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  assignGroupByName,
  removeGroupAssignment,
  listAssignmentsForMember,
  listMemberGroups,
} from "@/lib/services/member-groups";
import {
  upsertDefinition,
  setMemberFieldValue,
  getMemberFieldPayload,
} from "@/lib/services/member-custom-fields";

// Minimal principal shape used by the services (see rbac.ts).
// `roleKey` drives permissions via `ROLE_PERMISSIONS` — CLUB_ADMIN
// grants `members:write`, MEMBER does not.
function makePrincipal(clubId: string, opts: { canWrite?: boolean } = {}) {
  const canWrite = opts.canWrite ?? true;
  return {
    id: "u_" + Math.random().toString(36).slice(2, 10),
    name: "Test User",
    email: `test-${Math.random().toString(36).slice(2, 8)}@example.com`,
    status: "ACTIVE",
    memberId: null,
    activeClubId: clubId,
    memberships: canWrite
      ? [{ clubId, roleKey: "CLUB_ADMIN" as const }]
      : [{ clubId, roleKey: "MEMBER" as const }],
  } as unknown as import("@/lib/rbac").Principal;
}

const suiteToken = "p20-" + Math.random().toString(36).slice(2, 10);
let CLUB_A: string;
let CLUB_B: string;
let MEMBER_A: string;
let MEMBER_B_OTHER_CLUB: string;

beforeAll(async () => {
  const clubA = await prisma.club.create({ data: { slug: `${suiteToken}-a`, name: "P20 Club A" }, select: { id: true } });
  const clubB = await prisma.club.create({ data: { slug: `${suiteToken}-b`, name: "P20 Club B" }, select: { id: true } });
  CLUB_A = clubA.id;
  CLUB_B = clubB.id;

  const memberA = await prisma.member.create({
    data: { clubId: CLUB_A, memberNumber: "P20-0001", firstName: "Test", lastName: "A",
            email: `${suiteToken}-a@example.com`, status: "ACTIVE" },
    select: { id: true },
  });
  MEMBER_A = memberA.id;

  const memberB = await prisma.member.create({
    data: { clubId: CLUB_B, memberNumber: "P20-0001", firstName: "Test", lastName: "B",
            email: `${suiteToken}-b@example.com`, status: "ACTIVE" },
    select: { id: true },
  });
  MEMBER_B_OTHER_CLUB = memberB.id;
});

// ---------------------------------------------------------------------------
// Member groups
// ---------------------------------------------------------------------------

describe("member-groups — tenant scoping + idempotency", () => {
  it("assigns a group by name (creates the group lazily)", async () => {
    const principal = makePrincipal(CLUB_A);
    await assignGroupByName(principal, MEMBER_A, "Tennis");
    const groups = await listMemberGroups(CLUB_A);
    expect(groups.some((g) => g.name === "Tennis")).toBe(true);
    const assignments = await listAssignmentsForMember(MEMBER_A);
    expect(assignments.map((a) => a.group.name)).toContain("Tennis");
  });

  it("re-assigning the same group is a no-op (idempotent)", async () => {
    const principal = makePrincipal(CLUB_A);
    await assignGroupByName(principal, MEMBER_A, "Tennis");
    await assignGroupByName(principal, MEMBER_A, "Tennis");
    const assignments = await listAssignmentsForMember(MEMBER_A);
    expect(assignments.filter((a) => a.group.name === "Tennis")).toHaveLength(1);
  });

  it("assigning a group in CLUB_A does NOT leak to CLUB_B", async () => {
    const groupsB = await listMemberGroups(CLUB_B);
    expect(groupsB.some((g) => g.name === "Tennis")).toBe(false);
  });

  it("removeGroupAssignment removes the row", async () => {
    const principal = makePrincipal(CLUB_A);
    const groups = await listMemberGroups(CLUB_A);
    const tennis = groups.find((g) => g.name === "Tennis")!;
    await removeGroupAssignment(principal, MEMBER_A, tennis.id);
    const assignments = await listAssignmentsForMember(MEMBER_A);
    expect(assignments.map((a) => a.group.name)).not.toContain("Tennis");
  });

  it("permission gate — no members:write throws Forbidden", async () => {
    const noWrite = makePrincipal(CLUB_A, { canWrite: false });
    await expect(assignGroupByName(noWrite, MEMBER_A, "Golf")).rejects.toThrow(/permitted/i);
  });

  it("cross-tenant call throws (tenant assertion)", async () => {
    const principalA = makePrincipal(CLUB_A);
    // Attempt to assign to a member that belongs to CLUB_B — the
    // service resolves the member's clubId and rejects on the
    // permission check (principal has no permission on CLUB_B).
    await expect(assignGroupByName(principalA, MEMBER_B_OTHER_CLUB, "Golf")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Member custom fields
// ---------------------------------------------------------------------------

describe("member-custom-fields — definition + value lifecycle", () => {
  it("upsertDefinition creates a per-club field catalog entry", async () => {
    const principal = makePrincipal(CLUB_A);
    const def = await upsertDefinition(principal, CLUB_A, {
      key: "resignation", label: "Resignation", kind: "TEXT", sortOrder: 10,
    });
    expect(def.clubId).toBe(CLUB_A);
    expect(def.key).toBe("resignation");
    expect(def.label).toBe("Resignation");
  });

  it("upsertDefinition on the same (clubId, key) updates in place", async () => {
    const principal = makePrincipal(CLUB_A);
    await upsertDefinition(principal, CLUB_A, {
      key: "resignation", label: "Resignation reason", kind: "LONG_TEXT", sortOrder: 15,
    });
    const list = await prisma.memberCustomFieldDefinition.findMany({
      where: { clubId: CLUB_A, key: "resignation" },
    });
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("Resignation reason");
    expect(list[0].kind).toBe("LONG_TEXT");
  });

  it("setMemberFieldValue upserts, then getMemberFieldPayload returns it", async () => {
    const principal = makePrincipal(CLUB_A);
    const def = await prisma.memberCustomFieldDefinition.findFirst({
      where: { clubId: CLUB_A, key: "resignation" }, select: { id: true },
    });
    await setMemberFieldValue(principal, MEMBER_A, def!.id, "Not planning to resign.");
    const payload = await getMemberFieldPayload(CLUB_A, MEMBER_A);
    const row = payload.find((p) => p.key === "resignation");
    expect(row?.valueText).toBe("Not planning to resign.");
  });

  it("setMemberFieldValue(null) clears the value (row deleted)", async () => {
    const principal = makePrincipal(CLUB_A);
    const def = await prisma.memberCustomFieldDefinition.findFirst({
      where: { clubId: CLUB_A, key: "resignation" }, select: { id: true },
    });
    await setMemberFieldValue(principal, MEMBER_A, def!.id, null);
    const payload = await getMemberFieldPayload(CLUB_A, MEMBER_A);
    const row = payload.find((p) => p.key === "resignation");
    expect(row?.valueText).toBeNull();
    const dbRow = await prisma.memberCustomFieldValue.findFirst({
      where: { memberId: MEMBER_A, definitionId: def!.id },
    });
    expect(dbRow).toBeNull();
  });

  it("custom field values are tenant-scoped (CLUB_A definition not visible to CLUB_B)", async () => {
    const listB = await prisma.memberCustomFieldDefinition.findMany({ where: { clubId: CLUB_B } });
    expect(listB).toHaveLength(0);
  });

  it("permission gate — no members:write blocks upsertDefinition", async () => {
    const noWrite = makePrincipal(CLUB_A, { canWrite: false });
    await expect(upsertDefinition(noWrite, CLUB_A, { key: "should_not_land", label: "x" }))
      .rejects.toThrow(/permitted/i);
  });
});
