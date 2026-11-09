// EP-TRAIN-4Y-W §5 (2026-11-09) — provenance repair service.
//
// Problem: before the V-1 attribution columns existed, the 4Y-U
// route wrote deterministic title/description/code directly onto
// TrainingCourse. Those rows carry no attribution snapshot, so the
// V-1 isProvisional guard treats them as MANAGER-FINALISED and
// refuses to overwrite with later Qwen output.
//
// §5 asks for an EXPLICIT, AUDITABLE service that repairs the
// provenance for a specific course that we KNOW (from acceptance
// evidence, not content inference) was last written by the
// deterministic path. The directive explicitly forbids title
// wording / code-suffix pattern matching as proof of authorship.
//
// Contract:
//   - Caller MUST supply an `expectedAuthoredBy: "deterministic"`
//     attestation. The caller is responsible for proving that fact
//     out of band (acceptance report, git log, ops workflow).
//   - Caller MUST supply the exact `titleAtRepair` the caller
//     observed on the course row. The repair is a compare-and-set:
//     if the course title has changed since the caller observed it,
//     we abort as `TITLE_DRIFTED`. This closes the TOCTOU race where
//     a manager edits the title between the caller's read and the
//     repair write.
//   - The service does NOT overwrite title / description / code.
//     It only sets the attribution columns.
//   - The service records an audit row with action
//     `hr.training.course.metadata.provenance_repaired`.
//   - Permission gate: `hr:training:write` on the course's tenant.
//
// Idempotency: if attribution is already set for this course and
// the attributedTitle matches the current title, the service returns
// `{outcome: "ALREADY_ATTRIBUTED"}` without a write.
//
// §5 also requires: "Preserve manager edits." The compare-and-set
// semantics above guarantee we cannot stomp a manager edit even
// under a concurrent race.

import { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { hasPermission, type Principal } from "@/lib/rbac";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
} from "@/lib/errors";

export type ProvenanceSource = "deterministic" | "ai";

export interface RepairProvenanceInput {
  readonly courseId: string;
  readonly clubId: string;
  /** Caller-supplied, out-of-band attestation. The service does not
   *  infer this from title content. */
  readonly expectedAuthoredBy: ProvenanceSource;
  /** The title the caller OBSERVED on the course row. Compare-and-set:
   *  if the current title differs, the repair aborts. */
  readonly titleAtRepair: string;
  /** Optional provenance evidence string stored on audit meta for
   *  future readers (e.g. "4Y-U acceptance 2026-11-09, commit 1d69b536"). */
  readonly evidence?: string;
}

export type RepairOutcome =
  | "ATTRIBUTED"
  | "ALREADY_ATTRIBUTED"
  | "TITLE_DRIFTED"
  | "COURSE_NOT_FOUND";

export class ProvenanceRepairRejected extends AppError {
  readonly outcome: RepairOutcome;
  constructor(outcome: RepairOutcome, message: string, httpStatus: number) {
    super(`PROVENANCE_REPAIR_${outcome}`, message, httpStatus);
    this.outcome = outcome;
  }
}

/** Repair the provenance attribution for a single course that was
 *  previously written by a non-attributed path (pre-V-1 4Y-U).
 *
 *  This is the ONLY authorised way to retroactively set
 *  aiMetadataAttribution* on a TrainingCourse without going through
 *  the write path that normally sets them. */
export async function repairCourseMetadataProvenance(
  principal: Principal | null,
  input: RepairProvenanceInput,
  opts: { prisma?: PrismaClient; now?: Date } = {},
): Promise<{
  readonly outcome: RepairOutcome;
  readonly courseId: string;
  readonly attributedAt: Date | null;
  readonly attributedSource: ProvenanceSource | null;
}> {
  if (!principal) throw new UnauthenticatedError();
  if (!hasPermission(principal, input.clubId, "hr:training:write")) {
    throw new ForbiddenError("hr:training:write required");
  }
  const db = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();

  const course = await db.trainingCourse.findFirst({
    where: { id: input.courseId, clubId: input.clubId },
    select: {
      id: true,
      title: true,
      aiMetadataAttributionAt: true,
      aiMetadataAttributionSource: true,
      aiMetadataAttributedTitle: true,
    },
  });
  if (!course) {
    throw new ProvenanceRepairRejected(
      "COURSE_NOT_FOUND",
      `Course ${input.courseId} not found for club ${input.clubId}.`,
      404,
    );
  }

  // Idempotency: already-attributed + attributedTitle matches current
  // title → no write, no audit.
  if (
    course.aiMetadataAttributionAt !== null &&
    course.aiMetadataAttributedTitle !== null &&
    course.aiMetadataAttributedTitle === course.title
  ) {
    return {
      outcome: "ALREADY_ATTRIBUTED",
      courseId: course.id,
      attributedAt: course.aiMetadataAttributionAt,
      attributedSource: course.aiMetadataAttributionSource as ProvenanceSource | null,
    };
  }

  // Compare-and-set on title: if the current title doesn't match the
  // snapshot the caller observed, the title was edited since. We
  // abort rather than silently stamp attribution onto a title we
  // haven't verified matches what the caller attested to.
  if (course.title !== input.titleAtRepair) {
    throw new ProvenanceRepairRejected(
      "TITLE_DRIFTED",
      `Course title has drifted from the caller's observation; refusing to stamp attribution.`,
      409,
    );
  }

  // Set attribution. The write is scoped so Prisma's updateMany
  // guard + where-filter gives us a second compare-and-set at the
  // DB layer. The updateMany returns count=0 if a concurrent write
  // moved the title between our read and our write.
  const upd = await db.trainingCourse.updateMany({
    where: { id: course.id, clubId: input.clubId, title: input.titleAtRepair },
    data: {
      aiMetadataAttributionAt: now,
      aiMetadataAttributionRunId: null,
      aiMetadataAttributionSource: input.expectedAuthoredBy,
      aiMetadataAttributedTitle: input.titleAtRepair,
    },
  });
  if (upd.count === 0) {
    throw new ProvenanceRepairRejected(
      "TITLE_DRIFTED",
      "Compare-and-set failed at the DB layer (concurrent edit).",
      409,
    );
  }

  void audit(principal, {
    action: "hr.training.course.metadata.provenance_repaired",
    entityType: "TrainingCourse",
    entityId: course.id,
    clubId: input.clubId,
    after: {
      attributedSource: input.expectedAuthoredBy,
      attributedTitleFirst60: input.titleAtRepair.slice(0, 60),
      evidenceFirst120: (input.evidence ?? "").slice(0, 120),
    },
  });

  return {
    outcome: "ATTRIBUTED",
    courseId: course.id,
    attributedAt: now,
    attributedSource: input.expectedAuthoredBy,
  };
}

/** Narrow eligibility check: does this course currently LOOK like a
 *  candidate for provenance repair? Pure function, no DB mutation.
 *  Used by the HTTP route to short-circuit requests that can be
 *  rejected cheaply BEFORE loading the full course. The caller must
 *  still supply the attestation via repairCourseMetadataProvenance;
 *  eligibility alone is not proof of authorship. */
export function courseEligibleForProvenanceRepair(course: {
  readonly title: string | null;
  readonly aiMetadataAttributionAt: Date | null;
}): boolean {
  // Must not have attribution set already.
  if (course.aiMetadataAttributionAt !== null) return false;
  // Must have a non-placeholder title (we only repair courses whose
  // identity has actually been written). A still-provisional
  // "Untitled training course" doesn't need provenance — the normal
  // write path will set it.
  if (course.title === null || course.title.trim().length === 0) return false;
  if (course.title === "Untitled training course") return false;
  return true;
}

// Re-exported for test convenience.
export type {
  RepairProvenanceInput as RepairProvenanceInputT,
};
