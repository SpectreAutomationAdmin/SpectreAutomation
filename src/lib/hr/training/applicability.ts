// HR-2C §4, §15, §18 (2026-08-20) — Applicability + eligibility resolvers.
//
// Two derived reads. Both are pure — no writes, no side effects.
//
//   resolveApplicableCourses(employeeId)
//     → returns every currently-PUBLISHED-and-active course version
//       that applies to the employee via any of:
//         - appliesToAll on the version
//         - version.appliesToDeptIds includes employee.departmentId
//         - version.appliesToPositionIds includes employee.positionId
//         - an explicit TrainingAssignment row (§16)
//
//   resolveEmployeeSchedulingEligibility(employeeId)
//     → returns { eligible, outstandingTraining } (§15). Eligible when
//       every REQUIRED applicable version has a matching COMPLETION
//       row for the SAME versionId (§14, §17).
//
// Historical completions are NEVER deleted. If an employee changes
// department and a previously-applicable course becomes non-applicable,
// their historical completion for that course/version is preserved.

import { prisma } from "../../prisma";
import { NotFoundError } from "../../errors";

export interface ApplicableCourse {
  courseId: string;
  code: string;
  title: string;
  category: string;
  version: {
    id: string;
    version: number;
    required: boolean;
    requiresKnowledgeTest: boolean;
    passingScore: number;
    retakesAllowed: boolean;
    videoDurationSec: number | null;
  };
  /** Why this course is applicable — for admin/debug surfaces. */
  reason: "all" | "department" | "position" | "assigned";
}

interface EmployeeContext {
  id: string;
  clubId: string;
  departmentId: string | null;
  positionId: string | null;
}

function parseIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [];
  } catch { return []; }
}

async function loadEmployee(employeeId: string): Promise<EmployeeContext> {
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, clubId: true, departmentId: true, positionId: true },
  });
  if (!emp) throw new NotFoundError("Employee", employeeId);
  return emp;
}

/**
 * Collect the union of all (departmentId, positionId) pairs that
 * apply to this employee right now. Sources (HR-2C Employment):
 *   1. Every currently-active EmployeeEmploymentAssignment
 *      (PRIMARY + ADDITIONAL).
 *   2. The legacy Employee.departmentId / Employee.positionId — kept
 *      for backwards compatibility with employees that have not yet
 *      been migrated to the assignment model.
 *
 * §17: A cross-trained employee must receive training applicable to
 * ANY of their active roles, not only their primary department.
 */
async function collectActiveRoleContext(emp: EmployeeContext): Promise<{
  deptIds: Set<string>;
  positionIds: Set<string>;
}> {
  const now = new Date();
  const assignments = await prisma.employeeEmploymentAssignment.findMany({
    where: {
      employeeId: emp.id,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    select: { departmentId: true, positionId: true },
  });
  const deptIds = new Set<string>();
  const positionIds = new Set<string>();
  for (const a of assignments) {
    if (a.departmentId) deptIds.add(a.departmentId);
    if (a.positionId) positionIds.add(a.positionId);
  }
  // Legacy fallback — if the employee has no assignments yet, the
  // legacy fields still apply.
  if (emp.departmentId) deptIds.add(emp.departmentId);
  if (emp.positionId) positionIds.add(emp.positionId);
  return { deptIds, positionIds };
}

/**
 * Resolve every currently-published, non-retired training course
 * that applies to the employee. Deterministic ordering: assigned
 * first, then dept/position/all in insertion order.
 *
 * HR-2C Employment (2026-08-24) — applicability now considers the
 * UNION of departments/positions across ALL active employment
 * assignments (primary + additional), not only the legacy
 * Employee.departmentId / positionId.
 */
export async function resolveApplicableCourses(
  employeeId: string,
): Promise<ApplicableCourse[]> {
  const emp = await loadEmployee(employeeId);
  const [publishedVersions, assignments, roleContext] = await Promise.all([
    prisma.trainingCourseVersion.findMany({
      where: {
        state: "PUBLISHED",
        course: { clubId: emp.clubId, retiredAt: null },
      },
      include: {
        course: { select: { id: true, code: true, title: true, category: true, retiredAt: true } },
      },
      orderBy: [{ course: { title: "asc" } }, { version: "desc" }],
    }),
    prisma.trainingAssignment.findMany({
      where: { clubId: emp.clubId, employeeId },
      select: { courseId: true },
    }),
    collectActiveRoleContext(emp),
  ]);
  const assignedCourseIds = new Set(assignments.map((a) => a.courseId));

  const out: ApplicableCourse[] = [];
  const seenCourseIds = new Set<string>();
  for (const v of publishedVersions) {
    if (seenCourseIds.has(v.course.id)) continue; // one PUBLISHED per course (invariant)
    let reason: ApplicableCourse["reason"] | null = null;
    if (assignedCourseIds.has(v.course.id)) reason = "assigned";
    else if (v.appliesToAll) reason = "all";
    else if (parseIds(v.appliesToDeptIds).some((id) => roleContext.deptIds.has(id))) reason = "department";
    else if (parseIds(v.appliesToPositionIds).some((id) => roleContext.positionIds.has(id))) reason = "position";
    if (reason === null) continue;
    seenCourseIds.add(v.course.id);
    out.push({
      courseId: v.course.id,
      code: v.course.code,
      title: v.course.title,
      category: v.course.category,
      version: {
        id: v.id,
        version: v.version,
        required: v.required,
        requiresKnowledgeTest: v.requiresKnowledgeTest,
        passingScore: v.passingScore,
        retakesAllowed: v.retakesAllowed,
        videoDurationSec: v.videoDurationSec,
      },
      reason,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scheduling eligibility — §15 critical invariant
// ---------------------------------------------------------------------------

export interface OutstandingTrainingItem {
  courseId: string;
  courseVersionId: string;
  code: string;
  title: string;
  category: string;
  required: boolean;
  status: "not_started" | "in_progress" | "attempted_failed";
}

export interface SchedulingEligibility {
  eligible: boolean;
  outstandingTraining: OutstandingTrainingItem[];
  /** All applicable courses (required + optional) with their
   *  completion state — useful for the employee dashboard. */
  applicable: Array<ApplicableCourse & {
    completed: boolean;
    completedAt: Date | null;
    lastAttempt: { attemptNumber: number; passed: boolean; submittedAt: Date | null } | null;
  }>;
}

/**
 * Canonical scheduling-eligibility resolver. §15 critical invariant:
 * do NOT persist a simplistic `employee.trainingComplete = true` —
 * eligibility is derived from applicable required published versions
 * vs. valid completions. Called by the Availability write path and
 * (in future) by any scheduling writer.
 */
export async function resolveEmployeeSchedulingEligibility(
  employeeId: string,
): Promise<SchedulingEligibility> {
  const emp = await loadEmployee(employeeId);
  const applicable = await resolveApplicableCourses(employeeId);
  if (applicable.length === 0) {
    return { eligible: true, outstandingTraining: [], applicable: [] };
  }
  const versionIds = applicable.map((a) => a.version.id);
  const [completions, latestAttempts] = await Promise.all([
    prisma.trainingCompletion.findMany({
      where: { clubId: emp.clubId, employeeId, courseVersionId: { in: versionIds } },
      select: { courseVersionId: true, completedAt: true },
    }),
    prisma.trainingAttempt.findMany({
      where: { clubId: emp.clubId, employeeId, courseVersionId: { in: versionIds } },
      orderBy: { attemptNumber: "desc" },
      select: {
        courseVersionId: true,
        attemptNumber: true,
        passed: true,
        submittedAt: true,
      },
    }),
  ]);
  const completionByVersion = new Map(completions.map((c) => [c.courseVersionId, c]));
  const latestByVersion = new Map<string, typeof latestAttempts[number]>();
  for (const a of latestAttempts) {
    if (!latestByVersion.has(a.courseVersionId)) latestByVersion.set(a.courseVersionId, a);
  }

  const outstandingTraining: OutstandingTrainingItem[] = [];
  const applicableAnnotated: SchedulingEligibility["applicable"] = [];
  for (const a of applicable) {
    const completion = completionByVersion.get(a.version.id) ?? null;
    const latest = latestByVersion.get(a.version.id) ?? null;
    applicableAnnotated.push({
      ...a,
      completed: !!completion,
      completedAt: completion?.completedAt ?? null,
      lastAttempt: latest
        ? { attemptNumber: latest.attemptNumber, passed: latest.passed, submittedAt: latest.submittedAt }
        : null,
    });
    if (!a.version.required) continue;
    if (completion) continue;
    let status: OutstandingTrainingItem["status"] = "not_started";
    if (latest) status = latest.passed ? "not_started" : "attempted_failed";
    else {
      // Any progress row without a submitted attempt = in progress.
      const progress = await prisma.trainingProgress.findFirst({
        where: { employeeId, courseVersionId: a.version.id },
        select: { percentComplete: true },
      });
      if (progress && progress.percentComplete > 0) status = "in_progress";
    }
    outstandingTraining.push({
      courseId: a.courseId,
      courseVersionId: a.version.id,
      code: a.code,
      title: a.title,
      category: a.category,
      required: true,
      status,
    });
  }

  return {
    eligible: outstandingTraining.length === 0,
    outstandingTraining,
    applicable: applicableAnnotated,
  };
}
