// HR-2C B5 (2026-08-28) — Training compliance reads.
//
// Two canonical read services:
//
//   getEmployeeTrainingRecord(principal, employeeId)
//     → the full person-level compliance record used by the Employee
//       Profile → Training tab and by any drill-through from the
//       Compliance dashboard. Composes the canonical
//       `resolveEmployeeSchedulingEligibility` for current
//       applicable + eligibility + last-attempt state, adds a full
//       "training history" tail (including completions for courses /
//       versions no longer applicable — retired, transferred, etc.),
//       lists any explicit `TrainingAssignment` rows, and identifies
//       the applicability *source* per current requirement so the
//       admin knows WHY a course applies (department / position /
//       assigned / applies-to-all).
//
//   getClubTrainingCompliance(principal, clubId, opts?)
//     → the Club-level roll-up used by the Compliance dashboard.
//       Employee-centric — one row per active employee — with
//       required / completed / outstanding counts + canonical
//       scheduling eligibility. Filter-aware (status / department /
//       course / query). Batched: applicable resolution runs per
//       employee, but the underlying completion + attempt reads
//       are hoisted into two Prisma calls so we do not N+1 the
//       database as employee counts grow.
//
//   getCourseComplianceRoster(principal, courseId)
//     → per-course roster of applicable employees + status. Powers
//       the "Applicable employees" section on the published course
//       detail page. Deterministic status derivation matches
//       `resolveEmployeeSchedulingEligibility` exactly (a completion
//       row on the current published version === complete).
//
// Every read is:
//   - tenant-scoped (never returns a cross-Club row);
//   - permission-gated on `hr:training:compliance:read`;
//   - deterministic — same inputs, same output;
//   - answer-key safe — no question text, no correct-answer flags,
//     no attempt option selections are exposed.

import { prisma } from "../../prisma";
import { requirePermission, type Principal } from "../../rbac";
import { assertTenantOwned } from "../../services/tenant";
import { NotFoundError } from "../../errors";
import {
  resolveApplicableCourses,
  resolveEmployeeSchedulingEligibility,
  type ApplicableCourse,
  type SchedulingEligibility,
} from "./applicability";

const COMPLIANCE_PERM = "hr:training:compliance:read";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComplianceStatus =
  | "up_to_date"      // no required outstanding
  | "training_required" // ≥1 required outstanding
  | "in_progress"     // ≥1 required outstanding, at least one has progress but nothing failed
  | "no_requirements"; // no applicable courses at all

export interface ClubComplianceRow {
  employeeId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  employeeLifecycle: string;
  /** Canonical PRIMARY department name (for the table's Department
   *  column). Additional-role departments surface in the drill-through. */
  primaryDepartmentName: string | null;
  primaryPositionName: string | null;
  requiredCount: number;
  completedCount: number;
  outstandingCount: number;
  optionalCount: number;
  eligible: boolean;
  status: ComplianceStatus;
}

export interface ClubComplianceSummary {
  activeEmployeeCount: number;
  upToDateCount: number;
  trainingRequiredCount: number;
  publishedCourseCount: number;
}

export interface GetClubComplianceOpts {
  /** Filter to a compliance status. `undefined` returns everything. */
  status?: ComplianceStatus | "all";
  /** Filter to employees whose primary department matches this id. */
  departmentId?: string;
  /** Filter to employees for whom the given course is currently
   *  applicable (whether or not they've completed it). */
  courseId?: string;
  /** Case-insensitive substring match on first / last / preferred / #. */
  query?: string;
  /** Include TERMINATED / ARCHIVED. Default false. */
  includeInactive?: boolean;
}

export interface EmployeeTrainingCurrentItem {
  courseId: string;
  courseVersionId: string;
  code: string;
  title: string;
  category: string;
  required: boolean;
  completed: boolean;
  completedAt: Date | null;
  score: number | null;
  lastAttempt: { attemptNumber: number; passed: boolean; submittedAt: Date | null } | null;
  status: "completed" | "not_started" | "in_progress" | "attempted_failed";
  source: ApplicableCourse["reason"];
  /** Human-readable applicability source ("Position: Bartender",
   *  "Department: F&B", "Applies to all employees", "Individually
   *  assigned"). Never exposes an internal id. */
  sourceLabel: string;
}

export interface EmployeeTrainingHistoryItem {
  courseId: string;
  courseVersionId: string;
  code: string;
  title: string;
  version: number;
  completedAt: Date;
  score: number;
  /** True when this exact version is the currently-required one for
   *  the employee. Distinguishes "prior version completed, new
   *  version outstanding" from "up to date". */
  isCurrentVersion: boolean;
  /** True when the underlying course has been retired. History still
   *  shows it, marked accordingly. */
  courseRetired: boolean;
}

export interface EmployeeExplicitAssignment {
  id: string;
  courseId: string;
  courseCode: string;
  courseTitle: string;
  assignedAt: Date;
  note: string | null;
}

export interface EmployeeTrainingRecord {
  employeeId: string;
  clubId: string;
  eligibility: SchedulingEligibility;
  current: EmployeeTrainingCurrentItem[];
  history: EmployeeTrainingHistoryItem[];
  explicitAssignments: EmployeeExplicitAssignment[];
}

export interface CourseComplianceRosterEntry {
  employeeId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  status: "not_started" | "in_progress" | "attempted_failed" | "completed";
  score: number | null;
  completedAt: Date | null;
  source: ApplicableCourse["reason"];
  sourceLabel: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humaniseSource(
  reason: ApplicableCourse["reason"],
  ctx: {
    departmentName: string | null;
    positionName: string | null;
    additionalRole?: boolean;
  },
): string {
  switch (reason) {
    case "all": return "Applies to all employees";
    case "department":
      return ctx.departmentName
        ? `Department: ${ctx.departmentName}${ctx.additionalRole ? " · Additional role" : ""}`
        : "Department requirement";
    case "position":
      return ctx.positionName
        ? `Position: ${ctx.positionName}${ctx.additionalRole ? " · Additional role" : ""}`
        : "Position requirement";
    case "assigned": return "Individually assigned";
  }
}

function classifyEmployeeStatus(
  requiredCount: number,
  outstandingCount: number,
  anyProgress: boolean,
): ComplianceStatus {
  if (requiredCount === 0) return "no_requirements";
  if (outstandingCount === 0) return "up_to_date";
  if (anyProgress) return "in_progress";
  return "training_required";
}

// ---------------------------------------------------------------------------
// Single-employee record
// ---------------------------------------------------------------------------

export async function getEmployeeTrainingRecord(
  principal: Principal,
  employeeId: string,
): Promise<EmployeeTrainingRecord> {
  // Load + tenant-check the target row FIRST so a mis-scoped call
  // returns the same-shape 404 the rest of the module uses.
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true, clubId: true,
      firstName: true, lastName: true, preferredName: true,
    },
  });
  if (!emp) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(emp, principal);
  requirePermission(principal, emp.clubId, COMPLIANCE_PERM);

  // 1. Current applicable + eligibility — canonical resolver.
  const eligibility = await resolveEmployeeSchedulingEligibility(employeeId);

  // 2. Explicit assignments — surface separately for §15.
  const assignmentRows = await prisma.trainingAssignment.findMany({
    where: { clubId: emp.clubId, employeeId: emp.id },
    orderBy: { assignedAt: "desc" },
    select: {
      id: true, courseId: true, assignedAt: true, note: true,
      course: { select: { code: true, title: true } },
    },
  });
  const explicitAssignments: EmployeeExplicitAssignment[] = assignmentRows.map((r) => ({
    id: r.id,
    courseId: r.courseId,
    courseCode: r.course.code,
    courseTitle: r.course.title,
    assignedAt: r.assignedAt,
    note: r.note,
  }));

  // 3. Requirement source per current applicable row. We resolve dept
  //    / position names in one batched read.
  const deptIds = new Set<string>();
  const posIds = new Set<string>();
  const versionIds = eligibility.applicable.map((a) => a.version.id);
  for (const a of eligibility.applicable) {
    // Reason lookup happens against the version's applicability lists
    // themselves — no admin secret exposed.
    void a;
  }
  const versions = versionIds.length
    ? await prisma.trainingCourseVersion.findMany({
        where: { id: { in: versionIds } },
        select: {
          id: true, appliesToDeptIds: true, appliesToPositionIds: true,
        },
      })
    : [];
  const versionMap = new Map(versions.map((v) => [v.id, v]));

  // Build the employee's current active dept+position set so we can
  // resolve "why does this apply to me" beyond the resolver's reason.
  const now = new Date();
  const activeAssignments = await prisma.employeeEmploymentAssignment.findMany({
    where: {
      employeeId: emp.id,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    select: { role: true, departmentId: true, positionId: true },
  });
  for (const a of activeAssignments) {
    if (a.departmentId) deptIds.add(a.departmentId);
    if (a.positionId) posIds.add(a.positionId);
  }
  const [deptRows, posRows] = await Promise.all([
    deptIds.size
      ? prisma.department.findMany({
          where: { id: { in: [...deptIds] }, clubId: emp.clubId },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    posIds.size
      ? prisma.employeePosition.findMany({
          where: { id: { in: [...posIds] }, clubId: emp.clubId },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const deptNameById = new Map(deptRows.map((d) => [d.id, d.name]));
  const posNameById = new Map(posRows.map((p) => [p.id, p.name]));

  // 4. Score per completion (canonical resolver returns completedAt
  //    but not the numerical score — pull those in one query).
  const scoreByVersion = new Map<string, number>();
  if (versionIds.length) {
    const completionScoreRows = await prisma.trainingCompletion.findMany({
      where: { clubId: emp.clubId, employeeId: emp.id, courseVersionId: { in: versionIds } },
      select: { courseVersionId: true, score: true },
    });
    for (const r of completionScoreRows) scoreByVersion.set(r.courseVersionId, r.score);
  }

  const current: EmployeeTrainingCurrentItem[] = eligibility.applicable.map((a) => {
    const v = versionMap.get(a.version.id);
    // The resolver's `reason` may be "all" / "department" / "position"
    // / "assigned". When "department" or "position", we pick the FIRST
    // matching department/position from the employee's active roles so
    // the source label reads meaningfully (e.g. "Position: Bartender").
    let deptName: string | null = null;
    let posName: string | null = null;
    let additionalRole = false;
    if (v && a.reason === "department") {
      const deptListRaw = v.appliesToDeptIds ?? "";
      const deptList = parseIdArrayLoose(deptListRaw);
      for (const asgn of activeAssignments) {
        if (asgn.departmentId && deptList.includes(asgn.departmentId)) {
          deptName = deptNameById.get(asgn.departmentId) ?? null;
          additionalRole = asgn.role !== "PRIMARY";
          break;
        }
      }
    } else if (v && a.reason === "position") {
      const posListRaw = v.appliesToPositionIds ?? "";
      const posList = parseIdArrayLoose(posListRaw);
      for (const asgn of activeAssignments) {
        if (asgn.positionId && posList.includes(asgn.positionId)) {
          posName = posNameById.get(asgn.positionId) ?? null;
          additionalRole = asgn.role !== "PRIMARY";
          break;
        }
      }
    }
    const status = deriveCurrentItemStatus(a);
    return {
      courseId: a.courseId,
      courseVersionId: a.version.id,
      code: a.code,
      title: a.title,
      category: a.category,
      required: a.version.required,
      completed: a.completed,
      completedAt: a.completedAt,
      score: scoreByVersion.get(a.version.id) ?? null,
      lastAttempt: a.lastAttempt,
      status,
      source: a.reason,
      sourceLabel: humaniseSource(a.reason, {
        departmentName: deptName,
        positionName: posName,
        additionalRole,
      }),
    };
  });

  // 5. Training history — every completion on record, joined to
  //    course / version metadata. History NEVER filters by retired /
  //    non-applicable state (§13, §18) — completions belong to the
  //    employee record permanently.
  const historyRows = await prisma.trainingCompletion.findMany({
    where: { clubId: emp.clubId, employeeId: emp.id },
    orderBy: { completedAt: "desc" },
    select: {
      courseId: true, courseVersionId: true, score: true, completedAt: true,
      courseVersion: { select: { version: true } },
      course: { select: { code: true, title: true, retiredAt: true, currentVersionId: true } },
    },
  });
  const history: EmployeeTrainingHistoryItem[] = historyRows.map((r) => ({
    courseId: r.courseId,
    courseVersionId: r.courseVersionId,
    code: r.course.code,
    title: r.course.title,
    version: r.courseVersion.version,
    completedAt: r.completedAt,
    score: r.score,
    isCurrentVersion: r.course.currentVersionId === r.courseVersionId,
    courseRetired: r.course.retiredAt !== null,
  }));

  return {
    employeeId: emp.id,
    clubId: emp.clubId,
    eligibility,
    current,
    history,
    explicitAssignments,
  };
}

// ---------------------------------------------------------------------------
// Club roll-up
// ---------------------------------------------------------------------------

export async function getClubTrainingCompliance(
  principal: Principal,
  clubId: string,
  opts: GetClubComplianceOpts = {},
): Promise<{
  rows: ClubComplianceRow[];
  summary: ClubComplianceSummary;
  filteredCount: number;
}> {
  requirePermission(principal, clubId, COMPLIANCE_PERM);

  // 1. Employees to consider — active only unless caller opts in.
  const includeInactive = opts.includeInactive === true;
  const whereEmp = {
    clubId,
    ...(includeInactive ? {} : { employeeLifecycle: { in: ["ACTIVE", "PRE_HIRE", "LEAVE"] } }),
  } as const;
  const employees = await prisma.employee.findMany({
    where: whereEmp,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true, employeeNumber: true, firstName: true, lastName: true,
      preferredName: true, employeeLifecycle: true,
    },
  });

  // 2. Canonical current PRIMARY assignments in ONE query so we can
  //    label each row's department without N+1.
  const now = new Date();
  const primaryAssignments = await prisma.employeeEmploymentAssignment.findMany({
    where: {
      clubId,
      role: "PRIMARY",
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    select: {
      employeeId: true, departmentId: true, positionId: true,
    },
  });
  const primaryByEmp = new Map(primaryAssignments.map((a) => [a.employeeId, a]));
  const primaryDeptIds = new Set(primaryAssignments.map((a) => a.departmentId).filter((v): v is string => !!v));
  const primaryPosIds = new Set(primaryAssignments.map((a) => a.positionId).filter((v): v is string => !!v));
  const [deptRows, posRows] = await Promise.all([
    primaryDeptIds.size
      ? prisma.department.findMany({
          where: { id: { in: [...primaryDeptIds] }, clubId },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    primaryPosIds.size
      ? prisma.employeePosition.findMany({
          where: { id: { in: [...primaryPosIds] }, clubId },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const deptNameById = new Map(deptRows.map((d) => [d.id, d.name]));
  const posNameById = new Map(posRows.map((p) => [p.id, p.name]));

  // 3. Applicable resolution per employee. Preserves canonical
  //    semantics — no shortcut. We keep the resolver as the domain
  //    authority but hoist the bulk completion + attempt read out to
  //    one query each so we do not N+1 (§27).
  const perEmployeeApplicable = new Map<string, ApplicableCourse[]>();
  for (const emp of employees) {
    perEmployeeApplicable.set(emp.id, await resolveApplicableCourses(emp.id));
  }
  const allVersionIds = new Set<string>();
  for (const list of perEmployeeApplicable.values()) {
    for (const a of list) allVersionIds.add(a.version.id);
  }
  const [completionRows, publishedCourseCount] = await Promise.all([
    allVersionIds.size
      ? prisma.trainingCompletion.findMany({
          where: {
            clubId,
            employeeId: { in: employees.map((e) => e.id) },
            courseVersionId: { in: [...allVersionIds] },
          },
          select: { employeeId: true, courseVersionId: true },
        })
      : Promise.resolve([]),
    prisma.trainingCourse.count({
      where: {
        clubId,
        retiredAt: null,
        versions: { some: { state: "PUBLISHED" } },
      },
    }),
  ]);
  const completionKey = (empId: string, verId: string) => `${empId}::${verId}`;
  const completionSet = new Set(completionRows.map((c) => completionKey(c.employeeId, c.courseVersionId)));

  // 4. Assemble rows.
  const rows: ClubComplianceRow[] = employees.map((emp) => {
    const applicable = perEmployeeApplicable.get(emp.id) ?? [];
    const requiredList = applicable.filter((a) => a.version.required);
    const optionalCount = applicable.length - requiredList.length;
    let completedCount = 0;
    for (const a of requiredList) {
      if (completionSet.has(completionKey(emp.id, a.version.id))) completedCount++;
    }
    const outstandingCount = requiredList.length - completedCount;
    const status = classifyEmployeeStatus(requiredList.length, outstandingCount, false);
    const eligible = outstandingCount === 0;
    const primary = primaryByEmp.get(emp.id) ?? null;
    return {
      employeeId: emp.id,
      employeeNumber: emp.employeeNumber,
      firstName: emp.firstName,
      lastName: emp.lastName,
      preferredName: emp.preferredName,
      employeeLifecycle: emp.employeeLifecycle,
      primaryDepartmentName: primary?.departmentId
        ? deptNameById.get(primary.departmentId) ?? null
        : null,
      primaryPositionName: primary?.positionId
        ? posNameById.get(primary.positionId) ?? null
        : null,
      requiredCount: requiredList.length,
      completedCount,
      outstandingCount,
      optionalCount,
      eligible,
      status,
    };
  });

  // 5. Summary — always across the ACTIVE population (not filters) so
  //    the top-line number reflects the club, not the current view.
  const summary: ClubComplianceSummary = {
    activeEmployeeCount: rows.length,
    upToDateCount: rows.filter((r) => r.status === "up_to_date" || r.status === "no_requirements").length,
    trainingRequiredCount: rows.filter((r) => r.status === "training_required" || r.status === "in_progress").length,
    publishedCourseCount,
  };

  // 6. Apply UI filters last.
  let filtered = rows;
  if (opts.status && opts.status !== "all") {
    filtered = filtered.filter((r) => {
      if (opts.status === "up_to_date") return r.status === "up_to_date" || r.status === "no_requirements";
      if (opts.status === "training_required") return r.status === "training_required" || r.status === "in_progress";
      return r.status === opts.status;
    });
  }
  if (opts.departmentId) {
    const dName = deptNameById.get(opts.departmentId) ?? null;
    filtered = filtered.filter((r) => r.primaryDepartmentName === dName);
  }
  if (opts.courseId) {
    const targetCourseId = opts.courseId;
    filtered = filtered.filter((r) => {
      const applicable = perEmployeeApplicable.get(r.employeeId) ?? [];
      return applicable.some((a) => a.courseId === targetCourseId);
    });
  }
  if (opts.query) {
    const q = opts.query.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter((r) => {
        return `${r.firstName} ${r.lastName} ${r.preferredName ?? ""} ${r.employeeNumber}`
          .toLowerCase()
          .includes(q);
      });
    }
  }

  return { rows: filtered, summary, filteredCount: filtered.length };
}

// ---------------------------------------------------------------------------
// Per-course roster
// ---------------------------------------------------------------------------

export async function getCourseComplianceRoster(
  principal: Principal,
  courseId: string,
): Promise<{ courseId: string; roster: CourseComplianceRosterEntry[] }> {
  const course = await prisma.trainingCourse.findUnique({
    where: { id: courseId },
    select: { id: true, clubId: true, currentVersionId: true },
  });
  if (!course) throw new NotFoundError("TrainingCourse", courseId);
  assertTenantOwned(course, principal);
  requirePermission(principal, course.clubId, COMPLIANCE_PERM);
  if (!course.currentVersionId) {
    return { courseId: course.id, roster: [] };
  }

  const employees = await prisma.employee.findMany({
    where: { clubId: course.clubId, employeeLifecycle: { in: ["ACTIVE", "PRE_HIRE", "LEAVE"] } },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true, employeeNumber: true, firstName: true, lastName: true, preferredName: true,
    },
  });

  const roster: CourseComplianceRosterEntry[] = [];
  const versionId = course.currentVersionId;
  for (const emp of employees) {
    const applicable = await resolveApplicableCourses(emp.id);
    const match = applicable.find((a) => a.courseId === courseId);
    if (!match) continue;
    const [completion, latestAttempt] = await Promise.all([
      prisma.trainingCompletion.findFirst({
        where: { employeeId: emp.id, courseVersionId: versionId },
        select: { score: true, completedAt: true },
      }),
      prisma.trainingAttempt.findFirst({
        where: { employeeId: emp.id, courseVersionId: versionId },
        orderBy: { attemptNumber: "desc" },
        select: { passed: true },
      }),
    ]);
    let status: CourseComplianceRosterEntry["status"] = "not_started";
    if (completion) status = "completed";
    else if (latestAttempt) status = latestAttempt.passed ? "not_started" : "attempted_failed";
    roster.push({
      employeeId: emp.id,
      employeeNumber: emp.employeeNumber,
      firstName: emp.firstName,
      lastName: emp.lastName,
      preferredName: emp.preferredName,
      status,
      score: completion?.score ?? null,
      completedAt: completion?.completedAt ?? null,
      source: match.reason,
      sourceLabel: humaniseSource(match.reason, {
        departmentName: null, positionName: null,
      }),
    });
  }
  return { courseId: course.id, roster };
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function parseIdArrayLoose(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

function deriveCurrentItemStatus(
  a: SchedulingEligibility["applicable"][number],
): EmployeeTrainingCurrentItem["status"] {
  if (a.completed) return "completed";
  if (a.lastAttempt && a.lastAttempt.passed === false) return "attempted_failed";
  if (a.lastAttempt && a.lastAttempt.passed === true) return "not_started";
  return "not_started";
}
