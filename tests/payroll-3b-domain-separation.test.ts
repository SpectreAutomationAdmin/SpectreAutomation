// Payroll Admin Slice 3B (2026-09-12) — domain-separation regression.
//
// The founder's 3B directive §4 + §35 mandate that a payroll pay-
// group assignment (PayrollPayGroupMember row) must NEVER be
// confused with Club Membership. Concretely:
//   • assigning an Employee to a Pay Group must NOT create a Member
//     row, a MemberAccount row, or a Member↔Employee link;
//   • the two domains stay independent unless an EXISTING explicit
//     employee↔member link already exists for a separate business
//     reason.
//
// Lise Montsion is the canonical test subject — she is an Employee,
// not a Club Member. This regression proves the auto-assign helper
// touches Employee/Payroll only, never the Member domain.

import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";
import { autoAssignSinglePayGroupOnActivation } from "@/lib/payroll/pay-group-auto-assign";
import type { Principal } from "@/lib/rbac";

const prisma = new PrismaClient();
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

function testPrincipal(): Principal {
  return {
    id: "system-test-user",
    kind: "user",
    memberships: [],
    activeClubId: null,
  } as unknown as Principal;
}

async function seedClub(): Promise<string> {
  const id = `test-club-${Math.random().toString(36).slice(2, 10)}`;
  await prisma.club.create({
    data: {
      id, slug: id, name: `Test Club ${id}`, wordmark: id,
      timezone: "America/Edmonton", payrollProvince: "AB",
    },
  });
  return id;
}

describe("Payroll 3B domain-separation regression", () => {
  it("Pay-group assignment does NOT create a Club Member row", async () => {
    const clubId = await seedClub();
    const p = testPrincipal();

    // Baseline: zero Member rows.
    const memberBefore = await prisma.member.count({ where: { clubId } });
    expect(memberBefore).toBe(0);

    await prisma.payrollPayGroup.create({
      data: {
        id: `test-pg-${Math.random().toString(36).slice(2, 10)}`,
        clubId, code: "BW", name: "Bi-Weekly",
        payFrequency: "BIWEEKLY", payDateOffsetDays: 5,
        calendarAnchorDate: utc(2026, 1, 4), active: true,
      },
    });
    const liseId = `test-emp-lise-${Math.random().toString(36).slice(2, 8)}`;
    await prisma.employee.create({
      data: {
        id: liseId, clubId,
        employeeNumber: liseId.slice(-8),
        firstName: "Lise", lastName: "Montsion-Fixture",
        hireDate: utc(2026, 9, 1),
        employeeLifecycle: "ACTIVE",
      },
    });

    const outcome = await autoAssignSinglePayGroupOnActivation({
      principal: p, clubId, employeeId: liseId, now: utc(2026, 9, 1),
    });
    expect(outcome.status === "ASSIGNED" || outcome.status === "ALREADY_MEMBER").toBe(true);

    const payMembers = await prisma.payrollPayGroupMember.count({
      where: { clubId, employeeId: liseId },
    });
    expect(payMembers).toBe(1);

    // Member domain untouched.
    const memberAfter = await prisma.member.count({ where: { clubId } });
    expect(memberAfter).toBe(0);
    const memberAccountAfter = await prisma.memberAccount.count({ where: { clubId } });
    expect(memberAccountAfter).toBe(0);

    // Employee record has no member back-reference.
    const lisePersisted = await prisma.employee.findUniqueOrThrow({ where: { id: liseId } });
    expect((lisePersisted as unknown as { memberId?: string | null }).memberId ?? null).toBeNull();
  });

  it("Ending a pay-group assignment leaves the Member domain untouched", async () => {
    const clubId = await seedClub();
    const p = testPrincipal();
    const payGroupId = `test-pg-${Math.random().toString(36).slice(2, 10)}`;
    await prisma.payrollPayGroup.create({
      data: {
        id: payGroupId, clubId, code: "BW", name: "Bi-Weekly",
        payFrequency: "BIWEEKLY", payDateOffsetDays: 5,
        calendarAnchorDate: utc(2026, 1, 4), active: true,
      },
    });
    const chrisId = `test-emp-chr-${Math.random().toString(36).slice(2, 8)}`;
    await prisma.employee.create({
      data: {
        id: chrisId, clubId,
        employeeNumber: chrisId.slice(-8),
        firstName: "Chris", lastName: "Employee-Fixture",
        hireDate: utc(2026, 8, 1),
        employeeLifecycle: "ACTIVE",
      },
    });
    await autoAssignSinglePayGroupOnActivation({
      principal: p, clubId, employeeId: chrisId, now: utc(2026, 8, 1),
    });

    await prisma.payrollPayGroupMember.updateMany({
      where: { clubId, employeeId: chrisId, payGroupId },
      data: { effectiveTo: utc(2026, 12, 31) },
    });

    expect(await prisma.member.count({ where: { clubId } })).toBe(0);
    expect(await prisma.memberAccount.count({ where: { clubId } })).toBe(0);
  });
});
