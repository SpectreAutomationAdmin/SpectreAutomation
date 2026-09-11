// Payroll 3A hotfix — unit tests for pay-group auto-assignment on
// employee activation. Uses SQLite dev schema via Prisma (unit-tests
// speak to the same DB as the local dev server; each test creates
// scoped fixtures with unique clubIds so runs never collide).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  autoAssignSinglePayGroupOnActivation,
  resolveMembershipEffectiveFrom,
} from "@/lib/payroll/pay-group-auto-assign";
import type { Principal } from "@/lib/rbac";

const prisma = new PrismaClient();

// ---------- helpers ----------
function testPrincipal(): Principal {
  // Payroll 3A hotfix — Principal shape mirrors what rbac.loadPrincipal
  // returns, but the auto-assign helper only reads .id (for
  // createdByUserId) and passes the object to assertPostingAllowed.
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
      id,
      slug: id,
      name: `Test Club ${id}`,
      wordmark: id,
      timezone: "America/Edmonton",
      payrollProvince: "AB",
    },
  });
  return id;
}
async function seedEmployee(clubId: string, opts: { hireDate?: Date | null; lifecycle?: string } = {}): Promise<string> {
  const id = `test-emp-${Math.random().toString(36).slice(2, 10)}`;
  await prisma.employee.create({
    data: {
      id, clubId,
      employeeNumber: id.slice(-8),
      firstName: "Test",
      lastName: id.slice(-6),
      employeeLifecycle: opts.lifecycle ?? "ACTIVE",
      hireDate: opts.hireDate ?? null,
    },
  });
  return id;
}
async function seedPayGroup(clubId: string, opts: { active?: boolean; suffix?: string } = {}): Promise<string> {
  const id = `test-pg-${Math.random().toString(36).slice(2, 10)}`;
  await prisma.payrollPayGroup.create({
    data: {
      id, clubId,
      code: `PG_${opts.suffix ?? id.slice(-4)}`,
      name: `Pay Group ${id}`,
      payFrequency: "BIWEEKLY",
      payDateOffsetDays: 0,
      calendarAnchorDate: new Date("2026-01-04"),
      active: opts.active ?? true,
    },
  });
  return id;
}
async function seedAssignment(employeeId: string, clubId: string, effectiveFrom: Date): Promise<void> {
  await prisma.employeeEmploymentAssignment.create({
    data: {
      id: `test-asn-${Math.random().toString(36).slice(2, 10)}`,
      clubId, employeeId, role: "PRIMARY", employmentType: "FULL_TIME",
      effectiveFrom,
    },
  });
}
async function cleanupClub(clubId: string): Promise<void> {
  await prisma.payrollPayGroupMember.deleteMany({ where: { clubId } });
  await prisma.employeeEmploymentAssignment.deleteMany({ where: { clubId } });
  await prisma.payrollPayGroup.deleteMany({ where: { clubId } });
  await prisma.employee.deleteMany({ where: { clubId } });
  await prisma.club.delete({ where: { id: clubId } }).catch(() => {});
}

describe("resolveMembershipEffectiveFrom (§2 authoritative hierarchy)", () => {
  let clubId: string;
  beforeEach(async () => { clubId = await seedClub(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it("prefers Employee.hireDate when present", async () => {
    const hireDate = new Date("2026-03-01");
    const empId = await seedEmployee(clubId, { hireDate });
    await seedAssignment(empId, clubId, new Date("2026-05-01"));
    const res = await resolveMembershipEffectiveFrom(empId, new Date());
    expect(res?.source).toBe("EMPLOYEE_HIRE_DATE");
    expect(res?.effectiveFrom.toISOString().slice(0, 10)).toBe("2026-03-01");
    await cleanupClub(clubId);
  });

  it("falls back to earliest active employment assignment when hireDate is null", async () => {
    const empId = await seedEmployee(clubId, { hireDate: null });
    await seedAssignment(empId, clubId, new Date("2026-07-15"));
    const res = await resolveMembershipEffectiveFrom(empId, new Date());
    expect(res?.source).toBe("EARLIEST_ACTIVE_EMPLOYMENT_ASSIGNMENT");
    expect(res?.effectiveFrom.toISOString().slice(0, 10)).toBe("2026-07-15");
    await cleanupClub(clubId);
  });

  it("falls back to activation `now` when no other candidate exists", async () => {
    const empId = await seedEmployee(clubId, { hireDate: null });
    const now = new Date("2026-09-11T12:00:00Z");
    const res = await resolveMembershipEffectiveFrom(empId, now);
    expect(res?.source).toBe("ACTIVATION_NOW");
    expect(res?.effectiveFrom.toISOString()).toBe(now.toISOString());
    await cleanupClub(clubId);
  });
});

describe("autoAssignSinglePayGroupOnActivation (§1 + §3)", () => {
  let clubId: string;
  beforeEach(async () => { clubId = await seedClub(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it("single active pay group → ASSIGNED with membership row", async () => {
    const pgId = await seedPayGroup(clubId);
    const empId = await seedEmployee(clubId, { hireDate: new Date("2026-04-01") });
    const now = new Date();
    const result = await autoAssignSinglePayGroupOnActivation({
      principal: testPrincipal(), clubId, employeeId: empId, now,
    });
    expect(result.status).toBe("ASSIGNED");
    if (result.status === "ASSIGNED") {
      expect(result.payGroupId).toBe(pgId);
      expect(result.effectiveFromSource).toBe("EMPLOYEE_HIRE_DATE");
    }
    const members = await prisma.payrollPayGroupMember.findMany({
      where: { clubId, employeeId: empId, payGroupId: pgId },
    });
    expect(members.length).toBe(1);
    await cleanupClub(clubId);
  });

  it("second call for same employee → ALREADY_MEMBER, no duplicate row", async () => {
    await seedPayGroup(clubId);
    const empId = await seedEmployee(clubId);
    const now = new Date();
    await autoAssignSinglePayGroupOnActivation({ principal: testPrincipal(), clubId, employeeId: empId, now });
    const second = await autoAssignSinglePayGroupOnActivation({ principal: testPrincipal(), clubId, employeeId: empId, now });
    expect(second.status).toBe("ALREADY_MEMBER");
    const count = await prisma.payrollPayGroupMember.count({ where: { clubId, employeeId: empId } });
    expect(count).toBe(1);
    await cleanupClub(clubId);
  });

  it("zero active pay groups → SKIPPED_NO_PAY_GROUP", async () => {
    const empId = await seedEmployee(clubId);
    const result = await autoAssignSinglePayGroupOnActivation({
      principal: testPrincipal(), clubId, employeeId: empId, now: new Date(),
    });
    expect(result.status).toBe("SKIPPED_NO_PAY_GROUP");
    const count = await prisma.payrollPayGroupMember.count({ where: { clubId, employeeId: empId } });
    expect(count).toBe(0);
    await cleanupClub(clubId);
  });

  it("multiple active pay groups → SKIPPED_MULTI_PAY_GROUP", async () => {
    await seedPayGroup(clubId, { suffix: "AAA" });
    await seedPayGroup(clubId, { suffix: "BBB" });
    const empId = await seedEmployee(clubId);
    const result = await autoAssignSinglePayGroupOnActivation({
      principal: testPrincipal(), clubId, employeeId: empId, now: new Date(),
    });
    expect(result.status).toBe("SKIPPED_MULTI_PAY_GROUP");
    if (result.status === "SKIPPED_MULTI_PAY_GROUP") {
      expect(result.candidatePayGroupCount).toBe(2);
    }
    const count = await prisma.payrollPayGroupMember.count({ where: { clubId, employeeId: empId } });
    expect(count).toBe(0);
    await cleanupClub(clubId);
  });

  it("inactive pay groups don't count", async () => {
    await seedPayGroup(clubId, { active: false });
    const empId = await seedEmployee(clubId);
    const result = await autoAssignSinglePayGroupOnActivation({
      principal: testPrincipal(), clubId, employeeId: empId, now: new Date(),
    });
    expect(result.status).toBe("SKIPPED_NO_PAY_GROUP");
    await cleanupClub(clubId);
  });
});
