// HR-2C Employment (2026-08-24) — Employment assignment + compensation
// + allowance + cross-training behavioural regression.
//
// Founder §28-§31 mandatory list:
//   §28 effective-dated raise + hourly↔salary flip preserves history
//   §29 multi-role: one primary, multiple additional, cross-Club/dept refused
//   §30 cross-training affects training applicability
//   §31 permissions enforced (unauthorized refused, cross-club write refused,
//        employee portal cannot mutate authoritative fields)

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  addAssignment,
  endAssignment,
  listAssignments,
  getActiveAssignmentsAt,
} from "@/lib/hr/employment-assignments";
import { changeCompensation, listCompensationHistory, getCompensationAt } from "@/lib/hr/compensation";
import { addAllowance, endAllowance, listAllowances } from "@/lib/hr/allowances";
import { resolveApplicableCourses } from "@/lib/hr/training/applicability";
import { createCourse, publishDraft, updateDraft } from "@/lib/hr/training/courses";
import { createQuestion } from "@/lib/hr/training/questions";
import { uploadTrainingVideo } from "@/lib/hr/training/video";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";

const FAKE_VIDEO = Buffer.from(new Array(512).fill(0));

async function makeEmployee(fx: AdminHrFixture, opts?: { clubId?: string; departmentId?: string | null; positionId?: string | null }) {
  const clubId = opts?.clubId ?? fx.club.id;
  return prisma.employee.create({
    data: {
      clubId,
      employeeNumber: `E-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "T", lastName: "E",
      personalEmail: `t-${Date.now()}-${Math.floor(Math.random() * 9999)}@x.test`,
      departmentId: opts?.departmentId ?? null,
      positionId: opts?.positionId ?? null,
    },
  });
}

async function publishRequiredCourse(fx: AdminHrFixture, opts: {
  code: string;
  appliesToAll?: boolean;
  appliesToDeptIds?: string[];
  appliesToPositionIds?: string[];
  clubId?: string;
}): Promise<{ courseId: string; versionId: string }> {
  const clubId = opts.clubId ?? fx.club.id;
  const admin = clubId === fx.club.id ? fx.clubAdmin : fx.foreignClubAdmin;
  const { courseId, versionId } = await createCourse(admin, clubId, {
    code: opts.code, title: "Course", category: "Safety",
    version1Defaults: { required: true, appliesToAll: opts.appliesToAll ?? false },
  });
  await updateDraft(admin, versionId, {
    appliesToAll: opts.appliesToAll ?? false,
    appliesToDeptIds: opts.appliesToDeptIds ?? null,
    appliesToPositionIds: opts.appliesToPositionIds ?? null,
    requiresKnowledgeTest: true,
  });
  await uploadTrainingVideo(admin, versionId, { bytes: FAKE_VIDEO, mimeType: "video/mp4", durationSec: 60 });
  await createQuestion(admin, versionId, {
    prompt: "Sample question prompt for behavioural test?", options: [
      { text: "A", isCorrect: false },
      { text: "B", isCorrect: true },
    ],
  });
  await publishDraft(admin, versionId);
  return { courseId, versionId };
}

describe("HR-2C Employment · assignments + compensation + allowances", () => {
  let fx: AdminHrFixture;

  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("HR2CEmp");
  });

  // §29 multi-role architecture ---------------------------------------

  it("adds a primary + multiple additional assignments; ADDITIONAL rows overlap freely", async () => {
    const emp = await makeEmployee(fx);
    await addAssignment(fx.clubAdmin, emp.id, {
      role: "PRIMARY", employmentType: "FULL_TIME", effectiveFrom: "2026-01-01",
    });
    await addAssignment(fx.clubAdmin, emp.id, {
      role: "ADDITIONAL", employmentType: "PART_TIME", effectiveFrom: "2026-02-01",
    });
    await addAssignment(fx.clubAdmin, emp.id, {
      role: "ADDITIONAL", employmentType: "PART_TIME", effectiveFrom: "2026-03-01",
    });
    const active = await getActiveAssignmentsAt(emp.id, new Date("2026-04-01"));
    expect(active).toHaveLength(3);
    expect(active.filter((a) => a.role === "PRIMARY")).toHaveLength(1);
    expect(active.filter((a) => a.role === "ADDITIONAL")).toHaveLength(2);
  });

  it("adding a NEW PRIMARY closes the prior PRIMARY (never rewrites the old row)", async () => {
    const emp = await makeEmployee(fx);
    const first = await addAssignment(fx.clubAdmin, emp.id, {
      role: "PRIMARY", employmentType: "FULL_TIME", effectiveFrom: "2026-01-01",
    });
    await addAssignment(fx.clubAdmin, emp.id, {
      role: "PRIMARY", employmentType: "FULL_TIME", effectiveFrom: "2026-07-01",
    });
    const rows = await listAssignments(fx.clubAdmin, emp.id);
    const primaries = rows.filter((r) => r.role === "PRIMARY");
    expect(primaries).toHaveLength(2);
    // Prior primary closed at the new one's start; still historically present.
    const priorRow = primaries.find((p) => p.id === first.id)!;
    expect(priorRow.effectiveTo).not.toBeNull();
    expect(priorRow.effectiveTo!.toISOString().slice(0, 10)).toBe("2026-07-01");
    // Currently active primary: the newer one.
    const active = await getActiveAssignmentsAt(emp.id, new Date("2026-08-01"));
    expect(active.filter((a) => a.role === "PRIMARY")).toHaveLength(1);
  });

  it("cross-Club department refused when adding an assignment", async () => {
    const emp = await makeEmployee(fx);
    const foreignDept = await prisma.department.create({
      data: { clubId: fx.foreignClub.id, code: "FGN", name: "Foreign", sortOrder: 1 },
    });
    await expect(
      addAssignment(fx.clubAdmin, emp.id, {
        role: "ADDITIONAL", departmentId: foreignDept.id,
        employmentType: "PART_TIME", effectiveFrom: "2026-01-01",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("position must belong to the selected department", async () => {
    const emp = await makeEmployee(fx);
    const kitchen = await prisma.department.create({
      data: { clubId: fx.club.id, code: "KITCHEN", name: "Kitchen", sortOrder: 1 },
    });
    const grounds = await prisma.department.create({
      data: { clubId: fx.club.id, code: "GROUNDS", name: "Grounds", sortOrder: 2 },
    });
    const groundsPosition = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "GC", name: "Grounds Crew", departmentId: grounds.id },
    });
    await expect(
      addAssignment(fx.clubAdmin, emp.id, {
        role: "ADDITIONAL", departmentId: kitchen.id, positionId: groundsPosition.id,
        employmentType: "PART_TIME", effectiveFrom: "2026-01-01",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("end additional role does NOT terminate the employee; primary remains open", async () => {
    const emp = await makeEmployee(fx);
    await addAssignment(fx.clubAdmin, emp.id, {
      role: "PRIMARY", employmentType: "FULL_TIME", effectiveFrom: "2026-01-01",
    });
    const secondary = await addAssignment(fx.clubAdmin, emp.id, {
      role: "ADDITIONAL", employmentType: "PART_TIME", effectiveFrom: "2026-02-01",
    });
    await endAssignment(fx.clubAdmin, secondary.id, { effectiveTo: "2026-09-30" });
    const active = await getActiveAssignmentsAt(emp.id, new Date("2026-10-01"));
    // Primary remains active.
    expect(active).toHaveLength(1);
    expect(active[0]!.role).toBe("PRIMARY");
    // Employee record itself is unchanged.
    const reload = await prisma.employee.findUnique({ where: { id: emp.id }, select: { status: true } });
    expect(reload!.status).toBe("ACTIVE");
  });

  // §28 effective-dated compensation ---------------------------------------

  it("raise creates two historical records and resolves point-in-time correctly", async () => {
    const emp = await makeEmployee(fx);
    await changeCompensation(fx.clubAdmin, emp.id, {
      cadence: "HOURLY", amount: "22.00", effectiveFrom: "2026-01-01",
    });
    await changeCompensation(fx.clubAdmin, emp.id, {
      cadence: "HOURLY", amount: "24.00", effectiveFrom: "2026-07-01",
    });
    const history = await listCompensationHistory(fx.clubAdmin, emp.id);
    expect(history).toHaveLength(2);
    const jun30 = await getCompensationAt(fx.clubAdmin, emp.id, new Date("2026-06-30T23:59:59Z"));
    const jul1 = await getCompensationAt(fx.clubAdmin, emp.id, new Date("2026-07-01T00:00:00Z"));
    expect(jun30!.rate.toString()).toBe("22");
    expect(jul1!.rate.toString()).toBe("24");
  });

  it("hourly → salary → hourly flip preserves all three historical records", async () => {
    const emp = await makeEmployee(fx);
    await changeCompensation(fx.clubAdmin, emp.id, { cadence: "HOURLY", amount: "22.00", effectiveFrom: "2026-01-01" });
    await changeCompensation(fx.clubAdmin, emp.id, { cadence: "SALARY", amount: "72000.00", effectiveFrom: "2026-04-01" });
    await changeCompensation(fx.clubAdmin, emp.id, { cadence: "HOURLY", amount: "28.00", effectiveFrom: "2026-10-01" });
    const history = await listCompensationHistory(fx.clubAdmin, emp.id);
    expect(history).toHaveLength(3);
    const feb = await getCompensationAt(fx.clubAdmin, emp.id, new Date("2026-02-15"));
    const may = await getCompensationAt(fx.clubAdmin, emp.id, new Date("2026-05-15"));
    const nov = await getCompensationAt(fx.clubAdmin, emp.id, new Date("2026-11-15"));
    expect(feb!.cadence).toBe("HOURLY");
    expect(may!.cadence).toBe("SALARY");
    expect(nov!.cadence).toBe("HOURLY");
  });

  it("role-specific compensation (assignmentId) closes only the same scope; employee-wide row unaffected", async () => {
    const emp = await makeEmployee(fx);
    // Employee-wide salary primary.
    await changeCompensation(fx.clubAdmin, emp.id, {
      cadence: "SALARY", amount: "72000.00", effectiveFrom: "2026-01-01",
    });
    // Add an additional role.
    const additional = await addAssignment(fx.clubAdmin, emp.id, {
      role: "ADDITIONAL", employmentType: "PART_TIME", effectiveFrom: "2026-02-01",
    });
    // Role-specific hourly rate for the additional role.
    await changeCompensation(fx.clubAdmin, emp.id, {
      cadence: "HOURLY", amount: "28.00", effectiveFrom: "2026-02-01",
      assignmentId: additional.id,
    });
    const rows = await listCompensationHistory(fx.clubAdmin, emp.id);
    expect(rows).toHaveLength(2);
    // Both rows currently open.
    expect(rows.every((r) => r.effectiveTo === null)).toBe(true);
    // Different assignment scopes.
    const empWide = rows.find((r) => r.assignmentId === null)!;
    const roleSpecific = rows.find((r) => r.assignmentId === additional.id)!;
    expect(empWide.rate.toString()).toBe("72000");
    expect(empWide.cadence).toBe("SALARY");
    expect(roleSpecific.rate.toString()).toBe("28");
    expect(roleSpecific.cadence).toBe("HOURLY");
    // Employee.payRate legacy field reflects the EMPLOYEE-WIDE rate,
    // never the role-specific one.
    const reload = await prisma.employee.findUnique({ where: { id: emp.id }, select: { payRate: true } });
    expect(new Prisma.Decimal(reload!.payRate).toString()).toBe("72000");
  });

  // §30 cross-training affects training applicability ----------------------

  it("cross-training: secondary Bartender role brings Food & Beverage training into applicability", async () => {
    const emp = await makeEmployee(fx);
    // Primary: Administration (no dept for simplicity).
    await addAssignment(fx.clubAdmin, emp.id, {
      role: "PRIMARY", employmentType: "FULL_TIME", effectiveFrom: "2026-01-01",
    });
    // Publish a required course scoped to Food & Beverage.
    const fb = await prisma.department.create({
      data: { clubId: fx.club.id, code: "FB", name: "Food & Beverage", sortOrder: 1 },
    });
    await publishRequiredCourse(fx, {
      code: "BAR_101", appliesToDeptIds: [fb.id],
    });
    // Before adding the secondary role, the F&B course does NOT apply.
    expect((await resolveApplicableCourses(emp.id)).some((c) => c.code === "BAR_101")).toBe(false);
    // Add secondary Bartender role in Food & Beverage.
    const bartender = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "BAR", name: "Bartender", departmentId: fb.id },
    });
    await addAssignment(fx.clubAdmin, emp.id, {
      role: "ADDITIONAL", departmentId: fb.id, positionId: bartender.id,
      employmentType: "PART_TIME", effectiveFrom: "2026-02-01",
    });
    // Now the F&B course IS applicable.
    const applicable = await resolveApplicableCourses(emp.id);
    expect(applicable.some((c) => c.code === "BAR_101")).toBe(true);
  });

  it("ending the secondary role removes prospective applicability", async () => {
    const emp = await makeEmployee(fx);
    const fb = await prisma.department.create({
      data: { clubId: fx.club.id, code: "FB", name: "Food & Beverage", sortOrder: 1 },
    });
    const bartender = await prisma.employeePosition.create({
      data: { clubId: fx.club.id, code: "BAR", name: "Bartender", departmentId: fb.id },
    });
    const secondary = await addAssignment(fx.clubAdmin, emp.id, {
      role: "ADDITIONAL", departmentId: fb.id, positionId: bartender.id,
      employmentType: "PART_TIME", effectiveFrom: "2026-01-01",
    });
    await publishRequiredCourse(fx, {
      code: "BAR_102", appliesToDeptIds: [fb.id],
    });
    // With the additional role active, F&B course is applicable.
    let applicable = await resolveApplicableCourses(emp.id);
    expect(applicable.some((c) => c.code === "BAR_102")).toBe(true);
    // End the secondary role in the past (yesterday) — applicability
    // resolver uses `now`, so `effectiveTo <= now` closes the row.
    await endAssignment(fx.clubAdmin, secondary.id, {
      effectiveTo: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    });
    applicable = await resolveApplicableCourses(emp.id);
    expect(applicable.some((c) => c.code === "BAR_102")).toBe(false);
    // Historical assignment row still present (never deleted).
    const rows = await listAssignments(fx.clubAdmin, emp.id);
    expect(rows.some((r) => r.id === secondary.id)).toBe(true);
  });

  // §31 permissions ---------------------------------------------------------

  it("cross-Club admin cannot add an assignment on a foreign employee", async () => {
    const foreignEmp = await prisma.employee.create({
      data: {
        clubId: fx.foreignClub.id, employeeNumber: "F-1",
        firstName: "F", lastName: "E",
        personalEmail: `f-${Date.now()}@x.test`,
      },
    });
    await expect(
      addAssignment(fx.clubAdmin, foreignEmp.id, {
        role: "ADDITIONAL", employmentType: "PART_TIME", effectiveFrom: "2026-01-01",
      }),
    ).rejects.toBeDefined();
  });

  it("AUDITOR_READ_ONLY cannot add an assignment (no hr:employment:write)", async () => {
    const emp = await makeEmployee(fx);
    await expect(
      addAssignment(fx.auditor, emp.id, {
        role: "ADDITIONAL", employmentType: "PART_TIME", effectiveFrom: "2026-01-01",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  // Allowances --------------------------------------------------------------

  it("addAllowance + listAllowances round-trip; end closes the row", async () => {
    const emp = await makeEmployee(fx);
    const { id } = await addAllowance(fx.clubAdmin, emp.id, {
      allowanceType: "CELL_PHONE", amount: "75.00",
      frequency: "MONTHLY", taxable: true,
      effectiveFrom: "2026-01-01",
    });
    const rows = await listAllowances(fx.clubAdmin, emp.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.allowanceType).toBe("CELL_PHONE");
    expect(rows[0]!.isCurrent).toBe(true);
    await endAllowance(fx.clubAdmin, id, { effectiveTo: "2026-06-30" });
    const rowsAfter = await listAllowances(fx.clubAdmin, emp.id);
    expect(rowsAfter[0]!.isCurrent).toBe(false);
    expect(rowsAfter[0]!.effectiveTo).not.toBeNull();
  });

  it("AUDITOR_READ_ONLY cannot add an allowance (no hr:allowance:write)", async () => {
    const emp = await makeEmployee(fx);
    await expect(
      addAllowance(fx.auditor, emp.id, {
        allowanceType: "CELL_PHONE", amount: "75.00",
        frequency: "MONTHLY", taxable: true,
        effectiveFrom: "2026-01-01",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("allowance amount must be zero or positive; negative refused", async () => {
    const emp = await makeEmployee(fx);
    await expect(
      addAllowance(fx.clubAdmin, emp.id, {
        allowanceType: "CELL_PHONE", amount: "-5.00",
        frequency: "MONTHLY", taxable: true,
        effectiveFrom: "2026-01-01",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
