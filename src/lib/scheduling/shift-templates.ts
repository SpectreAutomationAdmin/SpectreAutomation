// Scheduling Foundation (2026-09-07) — shift template resolution.
//
// Templates are tenant/department-owned. This phase ships read-side
// helpers only (list + resolve for a given department). Write paths
// for template management live behind a future manager-scoped admin
// surface (Phase H+); until then, templates are seeded per-tenant
// via scripts/scheduling-seed-shift-templates.ts.

import { prisma } from "../prisma";

export interface ShiftTemplateRow {
  id: string;
  clubId: string;
  departmentId: string;
  code: string;
  name: string;
  startTimeMinutes: number;
  endTimeMinutes: number;
  active: boolean;
  sortOrder: number;
}

/** List all active templates for a department, ordered by start time. */
export async function listActiveShiftTemplates(
  clubId: string, departmentId: string,
): Promise<ShiftTemplateRow[]> {
  return prisma.shiftTemplate.findMany({
    where: { clubId, departmentId, active: true },
    orderBy: [{ sortOrder: "asc" }, { startTimeMinutes: "asc" }],
    select: {
      id: true, clubId: true, departmentId: true, code: true, name: true,
      startTimeMinutes: true, endTimeMinutes: true, active: true, sortOrder: true,
    },
  });
}

/**
 * List the active templates for every department the employee has
 * an ACTIVE assignment in (PRIMARY or ADDITIONAL). The Employee
 * Portal availability form renders these grouped by department.
 */
export async function listShiftTemplatesForEmployee(
  clubId: string, employeeId: string, atDate = new Date(),
): Promise<ShiftTemplateRow[]> {
  const assignments = await prisma.employeeEmploymentAssignment.findMany({
    where: {
      clubId, employeeId,
      effectiveFrom: { lte: atDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: atDate } }],
      departmentId: { not: null },
    },
    select: { departmentId: true },
  });
  const departmentIds = Array.from(new Set(
    assignments.map((a) => a.departmentId).filter((d): d is string => !!d),
  ));
  if (!departmentIds.length) return [];
  return prisma.shiftTemplate.findMany({
    where: { clubId, departmentId: { in: departmentIds }, active: true },
    orderBy: [{ departmentId: "asc" }, { sortOrder: "asc" }, { startTimeMinutes: "asc" }],
    select: {
      id: true, clubId: true, departmentId: true, code: true, name: true,
      startTimeMinutes: true, endTimeMinutes: true, active: true, sortOrder: true,
    },
  });
}
