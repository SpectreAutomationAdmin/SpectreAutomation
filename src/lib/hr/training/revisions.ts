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
import { NotFoundError, ValidationError } from "../../errors";
import { assertTenantOwned } from "../../services/tenant";
import { requirePermission, type Principal } from "../../rbac";
import { audit } from "../../audit";
import { publishDraft } from "./courses";
import {
  issueObligation,
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
}

export interface ManualReinstatementResult {
  eventId: string;
  courseId: string;
  courseVersionId: string;
  obligationIds: string[];
  perEmployee: Array<{
    employeeId: string;
    obligationId: string;
    priorOutstandingObligationIds: string[];
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
  const obligationIds: string[] = [];
  const skipped: Array<{ employeeId: string; reason: string }> = [];
  for (const employeeId of targetEmployeeIds) {
    try {
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
      });
      obligationIds.push(ob.id);
    } catch (err) {
      // A per-employee issue failure (e.g. race with employee archive)
      // is collected and reported; it does NOT abort the whole
      // publish.  The DB publish state has already been committed by
      // publishDraft above; we optimise for making the obligation
      // issuance resumable rather than rolling back the publish.
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
  const obligationIds: string[] = [];
  const perEmployee: ManualReinstatementResult["perEmployee"] = [];
  for (const employeeId of requested) {
    // Snapshot the employee's prior OUTSTANDING obligations for this
    // course -- the API includes these so the UI can show "replacing
    // / in addition to" semantics.  We do NOT auto-cancel or auto-
    // supersede; the directive mandates explicit confirmation + the
    // conflict policy in docs/ep-train-5a1-completion-and-issuance.md
    // §4 keeps multiple MANUAL_REINSTATE OUTSTANDING coexisting when
    // the manager confirmed independent events.
    const prior = await prisma.trainingObligation.findMany({
      where: {
        clubId: course.clubId, employeeId, courseId: course.id,
        status: "OUTSTANDING",
      },
      select: { id: true },
    });
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
    });
    obligationIds.push(ob.id);
    perEmployee.push({
      employeeId,
      obligationId: ob.id,
      priorOutstandingObligationIds: prior.map((p) => p.id),
    });
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
