// HR-2C §16 (2026-08-20) — Explicit per-employee course assignments.
//
// Layered ON TOP of the version's dept/position applicability (§4).
// Presence of an assignment row makes the course applicable regardless
// of dept/position match. Historical completions are never deleted
// when an assignment is added or removed.

import { prisma } from "../../prisma";
import { audit } from "../../audit";
import { requirePermission, type Principal } from "../../rbac";
import { assertTenantOwned } from "../../services/tenant";
import { withPostingGuard } from "../../posting-guard";
import { NotFoundError } from "../../errors";

const ENTITY = "TrainingAssignment";

export async function assignCourseToEmployee(
  principal: Principal,
  input: { employeeId: string; courseId: string; note?: string | null },
): Promise<{ assignmentId: string; alreadyAssigned: boolean }> {
  const [employee, course] = await Promise.all([
    prisma.employee.findUnique({
      where: { id: input.employeeId },
      select: { id: true, clubId: true },
    }),
    prisma.trainingCourse.findUnique({
      where: { id: input.courseId },
      select: { id: true, clubId: true, retiredAt: true },
    }),
  ]);
  if (!employee) throw new NotFoundError("Employee", input.employeeId);
  if (!course) throw new NotFoundError("TrainingCourse", input.courseId);
  assertTenantOwned(employee, principal);
  assertTenantOwned(course, principal);
  if (employee.clubId !== course.clubId) {
    throw new NotFoundError("TrainingCourse", input.courseId); // cross-tenant enumeration guard
  }
  requirePermission(principal, employee.clubId, "hr:training:assign");

  // M1d (2026-10-27) -- withPostingGuard holds FOR UPDATE on ClubSubscription for the write.
  // Existence check lives inside the tx so idempotency decisions see
  // the serialised subscription state alongside the write path.
  const outcome = await withPostingGuard(
    principal,
    employee.clubId,
    "hr.training.assignment.create",
    async (tx) => {
      const existing = await tx.trainingAssignment.findFirst({
        where: { clubId: employee.clubId, employeeId: employee.id, courseId: course.id },
        select: { id: true },
      });
      if (existing) {
        return { assignmentId: existing.id, alreadyAssigned: true as const, createdRowId: null as string | null };
      }
      const row = await tx.trainingAssignment.create({
        data: {
          clubId: employee.clubId,
          employeeId: employee.id,
          courseId: course.id,
          assignedByUserId: principal.id,
          note: input.note?.trim() || null,
        },
      });
      return { assignmentId: row.id, alreadyAssigned: false as const, createdRowId: row.id as string | null };
    },
    { entityType: ENTITY, entityId: input.employeeId },
  );
  if (outcome.createdRowId) {
    await audit(principal, {
      action: "hr.training.assignment.create",
      entityType: ENTITY,
      entityId: outcome.createdRowId,
      clubId: employee.clubId,
      after: { employeeId: employee.id, courseId: course.id },
    });
  }
  return { assignmentId: outcome.assignmentId, alreadyAssigned: outcome.alreadyAssigned };
}

export async function unassignCourseFromEmployee(
  principal: Principal,
  assignmentId: string,
): Promise<{ removed: boolean }> {
  const row = await prisma.trainingAssignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, clubId: true, employeeId: true, courseId: true },
  });
  if (!row) return { removed: false };
  requirePermission(principal, row.clubId, "hr:training:assign");
  // M1d (2026-10-27) -- withPostingGuard holds FOR UPDATE on ClubSubscription for the write.
  await withPostingGuard(
    principal,
    row.clubId,
    "hr.training.assignment.delete",
    async (tx) => tx.trainingAssignment.delete({ where: { id: assignmentId } }),
    { entityType: ENTITY, entityId: assignmentId },
  );
  await audit(principal, {
    action: "hr.training.assignment.delete",
    entityType: ENTITY,
    entityId: assignmentId,
    clubId: row.clubId,
    before: { employeeId: row.employeeId, courseId: row.courseId },
  });
  return { removed: true };
}
