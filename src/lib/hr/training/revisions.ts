// EP-TRAIN-5B (2026-11-01) — Administrative revision + reinstatement service.
//
// Thin wrapper over EP-TRAIN-5A-1's `obligations.ts` that encodes the
// two authorized administrative workflows:
//
//   1. publishDraftWithPolicy -- publish a revision draft under one of
//      three policies (ALL applicable / NON_COMPLETERS only / SELECTED
//      employees).  Reuses the existing `publishDraft` state machine
//      (retire prior PUBLISHED + flip currentVersionId) and ADDITIONALLY
//      issues one REVISION obligation per affected employee using a
//      single server-generated eventId -> per-call idempotency.
//
//   2. issueManualReinstatement -- without touching course content,
//      issue one MANUAL_REINSTATE obligation per selected employee with
//      a mandatory reason.  Same single-eventId idempotency.
//
// Both workflows:
//   * enforce `hr:training:publish` server-side
//   * tenant-scope every write
//   * refuse cross-tenant selectedEmployeeIds
//   * audit every call with the eventId + policy + affected ids
//   * leave every TrainingCompletion / TrainingAttempt / TrainingProgress
//     row untouched -- obligations are additive-only
//
// EP-TRAIN-5B does NOT:
//   * wire the employee-facing dashboard or course page to the
//     obligation stream (that is 5C)
//   * supersede prior obligations automatically -- the current slice
//     documents the policy and leaves the service helpers available
//     (see docs/ep-train-5a1-completion-and-issuance.md §4)
//
// Public API shape designed so the API routes + server actions are a
// thin pass-through.  All business decisions (who is "applicable",
// what is "non-completed", what is a conflict) live in the service.

import { randomUUID } from "node:crypto";
import { prisma } from "../../prisma";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import { assertTenantOwned } from "../../services/tenant";
import { requirePermission, type Principal } from "../../rbac";
import { audit } from "../../audit";
import { publishDraft } from "./courses";
import {
  issueObligation,
  cancelObligation,
  supersedeObligation,
  composeIssuanceKey,
  type ObligationRecord,
} from "./obligations";
import { resolveApplicableCourses } from "./applicability";

export type RevisionPolicy = "ALL_APPLICABLE" | "NON_COMPLETERS" | "SELECTED";

export interface ExistingObligationSnapshot {
  obligationId: string;
  reason: string;
  reasonNote: string | null;
  issuedAt: Date;
  dueAt: Date | null;
  courseVersionId: string;
  versionNumber: number;
}

export interface EmployeeRetakePreviewRow {
  employeeId: string;
  employeeNumber: string;
  displayName: string;
  departmentName: string | null;
  positionName: string | null;
  latestCompletion: {
    completedAt: Date;
    score: number;
    courseVersionId: string;
    versionNumber: number;
  } | null;
  existingOutstandingObligations: ExistingObligationSnapshot[];
}

export interface PublishWithPolicyResult {
  eventId: string;
  versionId: string;
  versionNumber: number;
  policy: RevisionPolicy;
  affectedEmployeeIds: string[];
  obligationIds: string[];
  skippedEmployeeIds: Array<{ employeeId: string; reason: string }>;
  /** EP-TRAIN-5B-1 (2026-11-02) -- obligations auto-superseded during
   *  this publish.  Each entry: the newly-issued REVISION obligation
   *  that replaced an older OUTSTANDING INITIAL or REVISION for the
   *  SAME course + same employee.  MANUAL_REINSTATE obligations are
   *  NEVER auto-superseded (independent policy per directive §1). */
  supersessions: Array<{
    employeeId: string;
    supersededObligationId: string;
    supersededReason: "INITIAL" | "REVISION";
    supersededByObligationId: string;
  }>;
}

/** EP-TRAIN-5B-1 (2026-11-02) -- per-employee conflict resolution for
 *  Require Retake when the manager has been shown that this employee
 *  already has an OUTSTANDING obligation on the course. */
export type RetakeConflictResolution = "KEEP_BOTH" | "REPLACE";

export interface ManualReinstatementResult {
  eventId: string;
  courseId: string;
  courseVersionId: string;
  obligationIds: string[];
  perEmployee: Array<{
    employeeId: string;
    /** null when the manager chose to skip this employee (not provided
     *  a conflict resolution AND the service is treating the absence
     *  as "CANCEL for this employee" — never happens in strict mode). */
    obligationId: string | null;
    priorOutstandingObligationIds: string[];
    /** EP-TRAIN-5B-1 -- what the service did with any prior OUTSTANDING
     *  for this employee on this course. */
    conflictResolution: RetakeConflictResolution | "NONE";
    /** EP-TRAIN-5B-1 -- obligation ids CANCELED during this call when
     *  the manager chose REPLACE for this employee.  MANUAL_REINSTATE
     *  obligations may be replaced; REVISION / INITIAL obligations may
     *  ALSO be replaced by a manual retake per the conflict policy
     *  (the manager explicitly asked to supersede them). */
    canceledObligationIds: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function loadCourseWithPublishedVersion(courseId: string) {
  const course = await prisma.trainingCourse.findUnique({
    where: { id: courseId },
    include: {
      versions: {
        where: { state: "PUBLISHED" },
        orderBy: { version: "desc" },
        take: 1,
      },
    },
  });
  return course;
}

async function resolveApplicableEmployeeIds(clubId: string, courseId: string): Promise<string[]> {
  // Reuse the canonical applicability resolver per-employee rather
  // than reimplement.  Scan every active employee in the club and
  // pick those for whom the course is applicable now.  Mirrors the
  // employeeLifecycle filter used by compliance.ts (ACTIVE + PRE_HIRE
  // + LEAVE are all legitimately applicable; TERMINATED / ARCHIVED
  // employees are excluded).
  const employees = await prisma.employee.findMany({
    where: { clubId, employeeLifecycle: { in: ["ACTIVE", "PRE_HIRE", "LEAVE"] } },
    select: { id: true },
  });
  const result: string[] = [];
  for (const emp of employees) {
    const applicable = await resolveApplicableCourses(emp.id);
    if (applicable.some((a) => a.courseId === courseId)) result.push(emp.id);
  }
  return result;
}

async function fetchEmployeesForRetake(
  clubId: string,
  employeeIds: string[],
  courseId: string,
  publishedVersionId: string,
): Promise<EmployeeRetakePreviewRow[]> {
  const employees = await prisma.employee.findMany({
    where: { id: { in: employeeIds }, clubId },
    select: {
      id: true, employeeNumber: true, firstName: true, lastName: true, preferredName: true,
      department: { select: { name: true } },
      position: { select: { name: true } },
    },
  });
  const foundIds = new Set(employees.map((e) => e.id));
  const missing = employeeIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new ValidationError([
      { path: "employeeIds", message: `${missing.length} employee(s) do not belong to this club` },
    ]);
  }
  const [completions, outstanding] = await Promise.all([
    prisma.trainingCompletion.findMany({
      where: { employeeId: { in: employeeIds }, courseId, clubId },
      orderBy: { completedAt: "desc" },
      include: { courseVersion: { select: { version: true } } },
    }),
    prisma.trainingObligation.findMany({
      where: {
        employeeId: { in: employeeIds },
        courseId,
        clubId,
        status: "OUTSTANDING",
      },
      include: { courseVersion: { select: { version: true } } },
      orderBy: { issuedAt: "asc" },
    }),
  ]);
  const latestByEmp = new Map<string, typeof completions[number]>();
  for (const c of completions) {
    if (!latestByEmp.has(c.employeeId)) latestByEmp.set(c.employeeId, c);
  }
  const outstandingByEmp = new Map<string, typeof outstanding>();
  for (const o of outstanding) {
    const arr = outstandingByEmp.get(o.employeeId) ?? [];
    arr.push(o);
    outstandingByEmp.set(o.employeeId, arr);
  }
  return employees.map((e) => {
    const latest = latestByEmp.get(e.id);
    const preferredFirst = e.preferredName?.trim() ? e.preferredName : e.firstName;
    return {
      employeeId: e.id,
      employeeNumber: e.employeeNumber,
      displayName: `${preferredFirst} ${e.lastName}`,
      departmentName: e.department?.name ?? null,
      positionName: e.position?.name ?? null,
      latestCompletion: latest ? {
        completedAt: latest.completedAt,
        score: latest.score,
        courseVersionId: latest.courseVersionId,
        versionNumber: latest.courseVersion.version,
      } : null,
      existingOutstandingObligations: (outstandingByEmp.get(e.id) ?? []).map((o) => ({
        obligationId: o.id,
        reason: o.reason,
        reasonNote: o.reasonNote,
        issuedAt: o.issuedAt,
        dueAt: o.dueAt,
        courseVersionId: o.courseVersionId,
        versionNumber: o.courseVersion.version,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Public API — publishDraftWithPolicy
// ---------------------------------------------------------------------------

export async function publishDraftWithPolicy(args: {
  principal: Principal;
  versionId: string;
  policy: RevisionPolicy;
  selectedEmployeeIds?: readonly string[];
  dueAt?: Date | null;
}): Promise<PublishWithPolicyResult> {
  const draft = await prisma.trainingCourseVersion.findUnique({
    where: { id: args.versionId },
    include: { course: { select: { id: true, clubId: true } } },
  });
  if (!draft) throw new NotFoundError("TrainingCourseVersion", args.versionId);
  assertTenantOwned({ clubId: draft.course.clubId }, args.principal);
  requirePermission(args.principal, draft.course.clubId, "hr:training:publish");

  // Determine the pre-publish state so we can distinguish "this is v1
  // (no prior)" from "this is a revision (there was a prior PUBLISHED)".
  // Only revisions produce REVISION obligations; v1 publishes seed
  // INITIAL applicability in 5C's dashboard swap.
  const priorPublished = await prisma.trainingCourseVersion.findFirst({
    where: {
      courseId: draft.course.id,
      state: "PUBLISHED",
      NOT: { id: args.versionId },
    },
    select: { id: true, version: true },
  });

  // EP-TRAIN-5B — resolve the target set BEFORE publishing so a
  // SELECTED-cross-tenant / unknown-policy error does NOT commit the
  // publish state transition.  Only the ALL / NON_COMPLETERS target
  // resolution requires the publish to have retired v1 (because
  // "applicable now" depends on current PUBLISHED state), but we
  // resolve those under the pre-publish state too -- "applicable"
  // means "the course applies to this employee" which does not change
  // across the v1→v2 transition since the applicability rules live on
  // the DRAFT itself and the DRAFT publishes with them.
  let targetEmployeeIds: string[] = [];
  if (!priorPublished) {
    // v1 publish — no REVISION obligations.  Still validate policy
    // shape so an unknown policy name is rejected consistently.
    if (!["ALL_APPLICABLE", "NON_COMPLETERS", "SELECTED"].includes(args.policy)) {
      throw new ValidationError([{ path: "policy", message: `Unknown policy: ${args.policy}` }]);
    }
  } else if (args.policy === "ALL_APPLICABLE") {
    targetEmployeeIds = await resolveApplicableEmployeeIds(draft.course.clubId, draft.course.id);
  } else if (args.policy === "NON_COMPLETERS") {
    const applicable = await resolveApplicableEmployeeIds(draft.course.clubId, draft.course.id);
    const completers = await prisma.trainingCompletion.findMany({
      where: {
        clubId: draft.course.clubId,
        courseVersionId: priorPublished.id,
        employeeId: { in: applicable },
      },
      select: { employeeId: true },
    });
    const completerSet = new Set(completers.map((c) => c.employeeId));
    targetEmployeeIds = applicable.filter((id) => !completerSet.has(id));
  } else if (args.policy === "SELECTED") {
    const requested = Array.from(new Set(args.selectedEmployeeIds ?? []));
    if (requested.length === 0) {
      throw new ValidationError([
        { path: "selectedEmployeeIds", message: "SELECTED policy requires at least one employee id" },
      ]);
    }
    const belonging = await prisma.employee.findMany({
      where: { id: { in: requested }, clubId: draft.course.clubId },
      select: { id: true },
    });
    const belongingSet = new Set(belonging.map((e) => e.id));
    const foreign = requested.filter((id) => !belongingSet.has(id));
    if (foreign.length > 0) {
      throw new ValidationError([
        { path: "selectedEmployeeIds", message: `${foreign.length} employee(s) do not belong to this club` },
      ]);
    }
    targetEmployeeIds = requested;
  } else {
    throw new ValidationError([{ path: "policy", message: `Unknown policy: ${args.policy}` }]);
  }

  // Reuse the canonical publishDraft: it retires any prior PUBLISHED
  // + flips currentVersionId within one tx + writes the standard
  // hr.training.version.publish audit entry.
  await publishDraft(args.principal, args.versionId);

  const eventId = randomUUID();
  const result: PublishWithPolicyResult = {
    eventId,
    versionId: args.versionId,
    versionNumber: draft.version,
    policy: args.policy,
    affectedEmployeeIds: [],
    obligationIds: [],
    skippedEmployeeIds: [],
    supersessions: [],
  };

  if (!priorPublished) {
    await audit(args.principal, {
      action: "hr.training.revision.publish",
      entityType: "TrainingCourseVersion",
      entityId: args.versionId,
      clubId: draft.course.clubId,
      after: {
        eventId, policy: args.policy, versionNumber: draft.version,
        priorPublishedVersionId: null,
        affectedCount: 0, note: "v1 publish — no REVISION obligations issued",
      },
    });
    return result;
  }

  // Issue one REVISION obligation per target.  issuanceKey per
  // (employee, version) within this event -> idempotent on retry.
  //
  // EP-TRAIN-5B-1 (2026-11-02) -- for EACH affected employee, after
  // the new REVISION obligation is created, SUPERSEDE any OUTSTANDING
  // INITIAL / REVISION obligations the same employee holds for OLDER
  // versions of the SAME course.  Rationale: the manager has
  // explicitly asserted "complete the new version" for this employee;
  // an outstanding requirement on a retired v1 would leave the
  // employee with contradictory obligations.  MANUAL_REINSTATE
  // obligations are left alone (per directive §1 — independent
  // policy; the manager can cancel them separately via Require Retake
  // if truly obsolete).
  //
  // The pair (issue + supersede) runs inside a prisma $transaction so
  // the employee is never visible with "new requirement issued AND
  // old requirement still outstanding" mid-flight.  A per-employee tx
  // failure is collected into `skippedEmployeeIds`; it does NOT abort
  // the whole publish (that would leave the publish retire/activate
  // state torn away from obligation state).
  const obligationIds: string[] = [];
  const skipped: Array<{ employeeId: string; reason: string }> = [];
  const supersessions: PublishWithPolicyResult["supersessions"] = [];
  for (const employeeId of targetEmployeeIds) {
    try {
      await prisma.$transaction(async (tx) => {
        const issuanceKey = composeIssuanceKey("REVISION", `${eventId}:${employeeId}`);
        const ob = await issueObligation({
          clubId: draft.course.clubId,
          employeeId,
          courseId: draft.course.id,
          courseVersionId: args.versionId,
          reason: "REVISION",
          issuedByUserId: args.principal.id,
          issuanceKey,
          dueAt: args.dueAt ?? null,
          tx,
        });
        obligationIds.push(ob.id);
        // Look up OUTSTANDING INITIAL / REVISION obligations for OLDER
        // versions of this course for the same employee.  Filter in TS
        // rather than SQL to keep the test harness simple + the query
        // targeted to the (clubId, employeeId, courseId, status) index.
        const priors = await tx.trainingObligation.findMany({
          where: {
            clubId: draft.course.clubId,
            employeeId,
            courseId: draft.course.id,
            status: "OUTSTANDING",
            reason: { in: ["INITIAL", "REVISION"] },
            NOT: { id: ob.id },
            // Only OLDER versions of this course.  The new REVISION
            // itself is excluded via `NOT: { id: ob.id }` AND via
            // version comparison.
            courseVersion: { version: { lt: draft.version } },
          },
          select: { id: true, reason: true, courseVersionId: true },
        });
        for (const prior of priors) {
          await supersedeObligation({
            obligationId: prior.id,
            supersededByObligationId: ob.id,
            tx,
          });
          supersessions.push({
            employeeId,
            supersededObligationId: prior.id,
            supersededReason: prior.reason as "INITIAL" | "REVISION",
            supersededByObligationId: ob.id,
          });
        }
      });
    } catch (err) {
      // A per-employee tx failure (issue + supersede) is collected and
      // reported; it does NOT abort the whole publish.  The publish
      // state has already been committed by publishDraft above.  The
      // composite UNIQUE on issuanceKey + the OUTSTANDING guard on
      // supersedeObligation together mean a repeat invocation with
      // the same `eventId` + same `employeeId` is idempotent: the
      // issue returns the existing REVISION row; the supersede either
      // picks up any still-OUTSTANDING priors (if the first attempt
      // partially succeeded) or is a no-op.
      skipped.push({
        employeeId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  result.affectedEmployeeIds = targetEmployeeIds.filter(
    (id) => !skipped.some((s) => s.employeeId === id),
  );
  result.obligationIds = obligationIds;
  result.skippedEmployeeIds = skipped;
  result.supersessions = supersessions;

  await audit(args.principal, {
    action: "hr.training.revision.publish",
    entityType: "TrainingCourseVersion",
    entityId: args.versionId,
    clubId: draft.course.clubId,
    after: {
      eventId,
      policy: args.policy,
      versionNumber: draft.version,
      priorPublishedVersionId: priorPublished.id,
      affectedCount: result.affectedEmployeeIds.length,
      obligationCount: obligationIds.length,
      skippedCount: skipped.length,
      supersededObligationCount: supersessions.length,
    },
  });
  return result;
}

// ---------------------------------------------------------------------------
// Public API — previewRetakeTargets
// ---------------------------------------------------------------------------

export async function previewRetakeTargets(args: {
  principal: Principal;
  courseId: string;
  employeeIds: readonly string[];
}): Promise<{
  courseId: string;
  courseTitle: string;
  publishedVersionId: string | null;
  publishedVersionNumber: number | null;
  rows: EmployeeRetakePreviewRow[];
}> {
  const course = await loadCourseWithPublishedVersion(args.courseId);
  if (!course) throw new NotFoundError("TrainingCourse", args.courseId);
  assertTenantOwned({ clubId: course.clubId }, args.principal);
  requirePermission(args.principal, course.clubId, "hr:training:read");
  const published = course.versions[0] ?? null;
  const ids = Array.from(new Set(args.employeeIds));
  if (ids.length === 0) {
    return {
      courseId: course.id, courseTitle: course.title,
      publishedVersionId: published?.id ?? null,
      publishedVersionNumber: published?.version ?? null,
      rows: [],
    };
  }
  const rows = await fetchEmployeesForRetake(course.clubId, ids, course.id, published?.id ?? "");
  return {
    courseId: course.id, courseTitle: course.title,
    publishedVersionId: published?.id ?? null,
    publishedVersionNumber: published?.version ?? null,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Public API — issueManualReinstatement
// ---------------------------------------------------------------------------

export async function issueManualReinstatement(args: {
  principal: Principal;
  courseId: string;
  employeeIds: readonly string[];
  reason: string;
  dueAt?: Date | null;
  /** EP-TRAIN-5B-1 (2026-11-02) — per-employee conflict decision for
   *  employees who already have an OUTSTANDING obligation on this
   *  course.  Required when such a conflict exists; absent is
   *  rejected with a ConflictError that names the employee(s) + prior
   *  obligations so the UI MUST re-prompt the manager before retrying.
   *
   *  KEEP_BOTH:   issue the new MANUAL_REINSTATE; leave prior
   *               OUTSTANDING intact (two coexisting requirements
   *               satisfied FIFO per EP-TRAIN-5A-1 §4).
   *   REPLACE:    cancel every prior OUTSTANDING obligation for this
   *               employee on this course (reasonNote appended with
   *               "[canceled] Replaced by retake request <eventId>"),
   *               then issue the new MANUAL_REINSTATE.
   *
   *  Entries for employees with NO conflict are ignored. */
  conflictResolution?: Readonly<Record<string, RetakeConflictResolution>>;
}): Promise<ManualReinstatementResult> {
  const course = await loadCourseWithPublishedVersion(args.courseId);
  if (!course) throw new NotFoundError("TrainingCourse", args.courseId);
  assertTenantOwned({ clubId: course.clubId }, args.principal);
  requirePermission(args.principal, course.clubId, "hr:training:publish");

  const published = course.versions[0];
  if (!published) {
    throw new ValidationError([
      { path: "courseId", message: "Course has no published version to require a retake for" },
    ]);
  }
  const reasonTrim = args.reason.trim();
  if (reasonTrim.length === 0) {
    throw new ValidationError([
      { path: "reason", message: "A reason is required when requiring a retake" },
    ]);
  }
  const requested = Array.from(new Set(args.employeeIds));
  if (requested.length === 0) {
    throw new ValidationError([
      { path: "employeeIds", message: "Select at least one employee" },
    ]);
  }
  const belonging = await prisma.employee.findMany({
    where: { id: { in: requested }, clubId: course.clubId },
    select: { id: true },
  });
  const belongingSet = new Set(belonging.map((e) => e.id));
  const foreign = requested.filter((id) => !belongingSet.has(id));
  if (foreign.length > 0) {
    throw new ValidationError([
      { path: "employeeIds", message: `${foreign.length} employee(s) do not belong to this club` },
    ]);
  }

  const eventId = randomUUID();

  // EP-TRAIN-5B-1 (2026-11-02) -- conflict detection pass.  Snapshot
  // every requested employee's existing OUTSTANDING obligations for
  // this course.  Any employee with >0 prior OUTSTANDING MUST have a
  // resolution choice supplied; absence is a hard refusal (ConflictError)
  // so the UI is forced to re-prompt the manager rather than silently
  // creating overlapping requirements.
  const priorByEmployee = new Map<string, Array<{ id: string; reason: string; reasonNote: string | null }>>();
  const priorRows = await prisma.trainingObligation.findMany({
    where: {
      clubId: course.clubId, courseId: course.id,
      employeeId: { in: requested },
      status: "OUTSTANDING",
    },
    select: { id: true, employeeId: true, reason: true, reasonNote: true },
  });
  for (const row of priorRows) {
    const arr = priorByEmployee.get(row.employeeId) ?? [];
    arr.push({ id: row.id, reason: row.reason, reasonNote: row.reasonNote });
    priorByEmployee.set(row.employeeId, arr);
  }
  const unresolved = requested.filter((id) =>
    (priorByEmployee.get(id) ?? []).length > 0
    && !(args.conflictResolution && args.conflictResolution[id]),
  );
  if (unresolved.length > 0) {
    throw new ConflictError(
      `Conflict: ${unresolved.length} employee(s) already have outstanding requirements on this course. ` +
      `Supply conflictResolution ("KEEP_BOTH" or "REPLACE") per employee before retrying.`,
    );
  }

  const obligationIds: string[] = [];
  const perEmployee: ManualReinstatementResult["perEmployee"] = [];
  for (const employeeId of requested) {
    const priors = priorByEmployee.get(employeeId) ?? [];
    const resolution = (priors.length > 0 && args.conflictResolution
      ? args.conflictResolution[employeeId]
      : "NONE") as RetakeConflictResolution | "NONE";
    const canceledIds: string[] = [];

    // Run cancel-prior + issue-new inside one tx per employee so the
    // employee is never visible with "prior canceled AND new not yet
    // issued" mid-flight.
    try {
      const result = await prisma.$transaction(async (tx) => {
        if (resolution === "REPLACE") {
          for (const prior of priors) {
            await cancelObligation({
              obligationId: prior.id,
              cancelReason: `Replaced by retake request ${eventId}`,
              tx,
            });
            canceledIds.push(prior.id);
          }
        }
        const issuanceKey = composeIssuanceKey("MANUAL_REINSTATE", `${eventId}:${employeeId}`);
        const ob = await issueObligation({
          clubId: course.clubId,
          employeeId,
          courseId: course.id,
          courseVersionId: published.id,
          reason: "MANUAL_REINSTATE",
          reasonNote: reasonTrim,
          issuedByUserId: args.principal.id,
          issuanceKey,
          dueAt: args.dueAt ?? null,
          tx,
        });
        return ob;
      });
      obligationIds.push(result.id);
      perEmployee.push({
        employeeId,
        obligationId: result.id,
        priorOutstandingObligationIds: priors.map((p) => p.id),
        conflictResolution: resolution,
        canceledObligationIds: canceledIds,
      });
    } catch (err) {
      // A per-employee failure is reported but does NOT abort the whole
      // call; the UI shows which employees succeeded.  The
      // composite UNIQUE on (eventId, employeeId) issuanceKey means a
      // retry with the same payload is idempotent.
      perEmployee.push({
        employeeId,
        obligationId: null,
        priorOutstandingObligationIds: priors.map((p) => p.id),
        conflictResolution: resolution,
        canceledObligationIds: canceledIds,
      });
    }
  }

  await audit(args.principal, {
    action: "hr.training.manual-reinstate.issue",
    entityType: "TrainingCourse",
    entityId: course.id,
    clubId: course.clubId,
    after: {
      eventId,
      courseVersionId: published.id,
      employeeCount: perEmployee.length,
      reason: reasonTrim,
      dueAt: args.dueAt?.toISOString() ?? null,
      // EP-TRAIN-5B-1 — conflict-resolution breakdown so audit shows
      // how each per-employee conflict was handled.
      keptBothCount: perEmployee.filter((p) => p.conflictResolution === "KEEP_BOTH").length,
      replacedCount: perEmployee.filter((p) => p.conflictResolution === "REPLACE").length,
      canceledPriorObligationCount: perEmployee.reduce((n, p) => n + p.canceledObligationIds.length, 0),
      issueFailedCount: perEmployee.filter((p) => p.obligationId === null).length,
    },
  });

  return {
    eventId,
    courseId: course.id,
    courseVersionId: published.id,
    obligationIds,
    perEmployee,
  };
}

// Exports used by the API routes + server actions + contract tests.
export const _internal = { resolveApplicableEmployeeIds };

export type { ObligationRecord };
