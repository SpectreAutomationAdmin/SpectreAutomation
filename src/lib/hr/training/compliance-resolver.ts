// EP-TRAIN-5C-1 (2026-11-02) — Obligation-aware compliance resolver (DORMANT).
//
// Pure read-side helper that classifies each employee × applicable
// course pair into one of seven compliance states, driven by the
// EP-TRAIN-5A-1 obligation stream + the historical TrainingCompletion
// evidence.  No writes.  No audit.  No side effects.
//
// NOT YET CONSULTED by any UI, API route, or resolver.  Exported for:
//   - the EP-TRAIN-5C-1 backfill dry-run script
//   - the eventual EP-TRAIN-5C-3 UI swap
//   - contract tests
//
// Design rationale: see docs/ep-train-5c1-resolver-architecture.md §2.

import { prisma } from "../../prisma";
import { NotFoundError } from "../../errors";
import { resolveApplicableCourses, type ApplicableCourse } from "./applicability";

export type ComplianceState =
  /** Course does not apply to this employee. */
  | "NO_REQUIREMENT"
  /** Applicable + required + no completion + no OUTSTANDING obligation. */
  | "INITIAL_REQUIRED"
  /** Valid completion exists on the current version AND no OUTSTANDING
   *  obligation.  This is the "truly caught up" state. */
  | "COMPLIANT"
  /** OUTSTANDING REVISION obligation present. */
  | "UPDATED_REQUIRED"
  /** OUTSTANDING MANUAL_REINSTATE obligation present. */
  | "RETAKE_REQUIRED"
  /** Any of INITIAL_REQUIRED / UPDATED_REQUIRED / RETAKE_REQUIRED
   *  where TrainingProgress for the active attempt has advanced
   *  (farthestSecond > 0 OR a submitted attempt without a passing
   *  completion exists). */
  | "IN_PROGRESS"
  /** More than one OUTSTANDING obligation coexists on this course
   *  (Keep-Both path from EP-TRAIN-5B-1).  activeObligation is still
   *  the oldest; outstandingObligationCount reports the full count. */
  | "MULTIPLE_OUTSTANDING";

export interface ActiveObligationSnapshot {
  obligationId: string;
  reason: "INITIAL" | "REVISION" | "MANUAL_REINSTATE";
  issuedAt: Date;
  dueAt: Date | null;
  courseVersionId: string;
  reasonNote: string | null;
}

export interface CompletionSnapshot {
  completionId: string;
  completedAt: Date;
  score: number;
  courseVersionId: string;
  courseVersionNumber: number;
}

export interface CourseCompliance {
  courseId: string;
  courseTitle: string;
  courseCode: string;
  category: string;
  publishedVersionId: string;
  publishedVersionNumber: number;
  state: ComplianceState;
  /** The oldest actionable OUTSTANDING obligation (FIFO per
   *  EP-TRAIN-5A-1 §4).  Null when state is NO_REQUIREMENT or
   *  COMPLIANT. */
  activeObligation: ActiveObligationSnapshot | null;
  /** Latest completion on the active obligation's target version (if
   *  any), else on the currently published version.  Null when no
   *  completion exists at all. */
  latestCompletion: CompletionSnapshot | null;
  /** Every historical completion on this course, newest first.
   *  Enables the Training History display (directive §8). */
  history: CompletionSnapshot[];
  /** Count of coexisting OUTSTANDING obligations on this course. */
  outstandingObligationCount: number;
}

export interface EmployeeTrainingCompliance {
  employeeId: string;
  clubId: string;
  summary: {
    applicableCourseCount: number;
    requiredCourseCount: number;
    compliantCount: number;
    outstandingObligationCount: number;
    inProgressCount: number;
  };
  courses: CourseCompliance[];
}

/**
 * Pure resolver.  See docs/ep-train-5c1-resolver-architecture.md §2.2
 * for the step-by-step algorithm.
 */
export async function resolveEmployeeTrainingCompliance(
  employeeId: string,
): Promise<EmployeeTrainingCompliance> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, clubId: true },
  });
  if (!employee) throw new NotFoundError("Employee", employeeId);

  const applicable: ApplicableCourse[] = await resolveApplicableCourses(employeeId);
  if (applicable.length === 0) {
    return {
      employeeId: employee.id,
      clubId: employee.clubId,
      summary: {
        applicableCourseCount: 0,
        requiredCourseCount: 0,
        compliantCount: 0,
        outstandingObligationCount: 0,
        inProgressCount: 0,
      },
      courses: [],
    };
  }

  const applicableCourseIds = applicable.map((a) => a.courseId);
  const [completions, outstandingObligations, versionsForHistory, progressRows] = await Promise.all([
    prisma.trainingCompletion.findMany({
      where: {
        clubId: employee.clubId,
        employeeId,
        courseId: { in: applicableCourseIds },
      },
      orderBy: { completedAt: "desc" },
      include: {
        courseVersion: { select: { version: true } },
      },
    }),
    prisma.trainingObligation.findMany({
      where: {
        clubId: employee.clubId,
        employeeId,
        courseId: { in: applicableCourseIds },
        status: "OUTSTANDING",
      },
      orderBy: { issuedAt: "asc" },
    }),
    // Full history includes completions on NO-LONGER-APPLICABLE course
    // versions (e.g. after a role change) only within the APPLICABLE
    // course set, so Training History remains stable per course even
    // when the employee's role changes.
    prisma.trainingCourseVersion.findMany({
      where: { courseId: { in: applicableCourseIds } },
      select: { id: true, version: true, courseId: true, state: true },
    }),
    prisma.trainingProgress.findMany({
      where: {
        clubId: employee.clubId,
        employeeId,
        courseVersion: { courseId: { in: applicableCourseIds } },
      },
      select: {
        courseVersionId: true, farthestSecond: true, percentComplete: true,
        checkpointClearedJson: true,
      },
    }),
  ]);

  // Build helpful indexes.
  const completionsByCourseId = new Map<string, typeof completions>();
  for (const c of completions) {
    const arr = completionsByCourseId.get(c.courseId) ?? [];
    arr.push(c);
    completionsByCourseId.set(c.courseId, arr);
  }
  const obligationsByCourseId = new Map<string, typeof outstandingObligations>();
  for (const o of outstandingObligations) {
    const arr = obligationsByCourseId.get(o.courseId) ?? [];
    arr.push(o);
    obligationsByCourseId.set(o.courseId, arr);
  }
  const progressByVersionId = new Map<string, typeof progressRows[number]>();
  for (const p of progressRows) progressByVersionId.set(p.courseVersionId, p);
  const versionNumberById = new Map(versionsForHistory.map((v) => [v.id, v.version]));

  const courses: CourseCompliance[] = applicable.map((app) => {
    const courseCompletions = completionsByCourseId.get(app.courseId) ?? [];
    const courseObligations = obligationsByCourseId.get(app.courseId) ?? [];
    const outstandingCount = courseObligations.length;
    const active = courseObligations[0] ?? null; // oldest first

    // "latestCompletion" semantics: when an active obligation exists,
    // report the latest completion AT the obligation's target version
    // (which may be older than the current PUBLISHED version if the
    // obligation points at a RETIRED version).  When no obligation
    // exists, report the latest completion AT the current published
    // version id.
    const latestCompletionTargetVersionId = active ? active.courseVersionId : app.version.id;
    const latestCompletionRow = courseCompletions.find((c) => c.courseVersionId === latestCompletionTargetVersionId) ?? null;
    const latestCompletion: CompletionSnapshot | null = latestCompletionRow ? {
      completionId: latestCompletionRow.id,
      completedAt: latestCompletionRow.completedAt,
      score: latestCompletionRow.score,
      courseVersionId: latestCompletionRow.courseVersionId,
      courseVersionNumber: latestCompletionRow.courseVersion.version,
    } : null;

    const history: CompletionSnapshot[] = courseCompletions.map((c) => ({
      completionId: c.id,
      completedAt: c.completedAt,
      score: c.score,
      courseVersionId: c.courseVersionId,
      courseVersionNumber: c.courseVersion.version,
    }));

    // Classify.
    let state: ComplianceState;
    if (outstandingCount >= 2) {
      state = "MULTIPLE_OUTSTANDING";
    } else if (active) {
      // One outstanding obligation.  Classify by reason, then upgrade
      // to IN_PROGRESS if progress has advanced on the active target
      // version AFTER the obligation was issued (so stale progress
      // from a prior completion does not falsely report IN_PROGRESS).
      const progress = progressByVersionId.get(active.courseVersionId);
      // Pre-5C-2 note: progress is still keyed per-version, so this
      // IN_PROGRESS classification treats "there is progress on this
      // version AT ALL" as IN_PROGRESS.  5C-2 adds attempt/obligation
      // scoping; the classification here will be sharpened then.
      const hasAdvanced = (progress?.farthestSecond ?? 0) > 0;
      if (hasAdvanced) state = "IN_PROGRESS";
      else if (active.reason === "REVISION") state = "UPDATED_REQUIRED";
      else if (active.reason === "MANUAL_REINSTATE") state = "RETAKE_REQUIRED";
      else state = "INITIAL_REQUIRED";
    } else if (latestCompletion) {
      state = "COMPLIANT";
    } else if (app.version.required) {
      state = "INITIAL_REQUIRED";
    } else {
      // Optional + not completed + not applicable obligation.
      state = "NO_REQUIREMENT";
    }

    return {
      courseId: app.courseId,
      courseTitle: app.title,
      courseCode: app.code,
      category: app.category,
      publishedVersionId: app.version.id,
      publishedVersionNumber: versionNumberById.get(app.version.id) ?? app.version.version,
      state,
      activeObligation: active ? {
        obligationId: active.id,
        reason: active.reason as ActiveObligationSnapshot["reason"],
        issuedAt: active.issuedAt,
        dueAt: active.dueAt,
        courseVersionId: active.courseVersionId,
        reasonNote: active.reasonNote,
      } : null,
      latestCompletion,
      history,
      outstandingObligationCount: outstandingCount,
    };
  });

  const summary = {
    applicableCourseCount: courses.length,
    requiredCourseCount: applicable.filter((a) => a.version.required).length,
    compliantCount: courses.filter((c) => c.state === "COMPLIANT").length,
    outstandingObligationCount: courses.reduce((n, c) => n + c.outstandingObligationCount, 0),
    inProgressCount: courses.filter((c) => c.state === "IN_PROGRESS").length,
  };

  return {
    employeeId: employee.id,
    clubId: employee.clubId,
    summary,
    courses,
  };
}

/** Convenience selector for the (future, 5C-3) course page's Required
 *  Training rail.  Returns the subset of courses whose state is any
 *  "requirement outstanding" variant.  FIFO ordering by activeObligation.issuedAt
 *  ASC so the oldest actionable requirement surfaces first. */
export function outstandingCourses(
  compliance: EmployeeTrainingCompliance,
): CourseCompliance[] {
  return compliance.courses
    .filter((c) =>
      c.state === "INITIAL_REQUIRED"
      || c.state === "UPDATED_REQUIRED"
      || c.state === "RETAKE_REQUIRED"
      || c.state === "IN_PROGRESS"
      || c.state === "MULTIPLE_OUTSTANDING",
    )
    .sort((a, b) => {
      const ta = a.activeObligation?.issuedAt.getTime() ?? Number.MAX_SAFE_INTEGER;
      const tb = b.activeObligation?.issuedAt.getTime() ?? Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });
}
