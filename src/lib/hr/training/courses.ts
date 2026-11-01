// HR-2C (2026-08-20) — Training course authoring service.
//
// Canonical writers for TrainingCourse + TrainingCourseVersion. Every
// admin route + admin page mutation flows through here so RBAC +
// posting-guard + audit + tenant discipline fire in one place.
//
// Lifecycle:
//   createCourse  — creates the catalogue entry AND an initial
//                    DRAFT version 1. `hr:training:write`.
//   updateDraft    — mutates a DRAFT version's copy / applicability /
//                    passing score / video metadata. Refuses to touch
//                    PUBLISHED / RETIRED rows. `hr:training:write`.
//   publishDraft   — freezes a DRAFT to PUBLISHED, sets Course.currentVersionId,
//                    validates completeness (title, video required,
//                    knowledge test valid). `hr:training:publish`.
//   startNewDraft  — creates a fresh DRAFT version cloned from the
//                    current PUBLISHED version's content. Used when an
//                    admin wants to edit a live course without touching
//                    history. `hr:training:write`.
//   retireCourse   — sets Course.retiredAt + marks current version RETIRED.
//                    Historical completions survive. `hr:training:publish`.
//
// Question authoring lives in `questions.ts` and operates only on
// DRAFT versions.

import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma";
import { audit } from "../../audit";
import { requirePermission, type Principal } from "../../rbac";
import { assertTenantOwned } from "../../services/tenant";
import { assertPostingAllowed, withPostingGuard } from "../../posting-guard";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";

export const TRAINING_COURSE_CATEGORIES = [
  "Safety",
  "Orientation",
  "Equipment",
  "Food & Beverage",
  "Policy",
  "Compliance",
  "Other",
] as const;
export type TrainingCourseCategory = (typeof TRAINING_COURSE_CATEGORIES)[number];

export type TrainingVersionState = "DRAFT" | "PUBLISHED" | "RETIRED";

const COURSE_ENTITY = "TrainingCourse";
const VERSION_ENTITY = "TrainingCourseVersion";

function normaliseCategory(v: string): TrainingCourseCategory {
  const s = v.trim();
  if (!(TRAINING_COURSE_CATEGORIES as readonly string[]).includes(s)) {
    throw new ValidationError([{
      path: "category",
      message: `Category must be one of ${TRAINING_COURSE_CATEGORIES.join(", ")}`,
    }]);
  }
  return s as TrainingCourseCategory;
}

function normaliseCode(v: string): string {
  const s = v.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_\-]{1,63}$/.test(s)) {
    throw new ValidationError([{
      path: "code",
      message: "Course code must be 2-64 uppercase alphanumeric or underscore/dash characters.",
    }]);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateCourseInput {
  code: string;
  title: string;
  category: string;
  description?: string | null;
  /** Version 1 defaults (all overridable via updateDraft):
   *   required=true, passingScore=80, retakesAllowed=true,
   *   requiresKnowledgeTest=true, appliesToAll=false */
  version1Defaults?: {
    required?: boolean;
    passingScore?: number;
    retakesAllowed?: boolean;
    requiresKnowledgeTest?: boolean;
    appliesToAll?: boolean;
  };
}

export async function createCourse(
  principal: Principal,
  clubId: string,
  input: CreateCourseInput,
): Promise<{ courseId: string; versionId: string }> {
  requirePermission(principal, clubId, "hr:training:write");

  const code = normaliseCode(input.code);
  const title = input.title.trim();
  const category = normaliseCategory(input.category);
  if (title.length < 3 || title.length > 200) {
    throw new ValidationError([{ path: "title", message: "Title must be 3-200 characters." }]);
  }
  const description = input.description?.trim() || null;
  const d = input.version1Defaults ?? {};
  const passingScore = d.passingScore ?? 80;
  if (passingScore < 0 || passingScore > 100 || !Number.isInteger(passingScore)) {
    throw new ValidationError([{ path: "passingScore", message: "Passing score must be an integer 0-100." }]);
  }

  const collision = await prisma.trainingCourse.findFirst({
    where: { clubId, code }, select: { id: true },
  });
  if (collision) throw new ConflictError(`Course code ${code} already exists in this Club.`);

  const result = await prisma.$transaction(async (tx) => {
    // M1d (2026-10-27) -- posting-guard INSIDE the tx so FOR UPDATE on ClubSubscription serializes against suspension.
    await assertPostingAllowed(principal, clubId, "hr.training.course.create", COURSE_ENTITY, clubId, { tx });
    const course = await tx.trainingCourse.create({
      data: {
        clubId,
        code,
        title,
        category,
        description,
        createdByUserId: principal.id,
      },
    });
    const version = await tx.trainingCourseVersion.create({
      data: {
        courseId: course.id,
        version: 1,
        state: "DRAFT",
        title,
        description,
        passingScore,
        retakesAllowed: d.retakesAllowed ?? true,
        requiresKnowledgeTest: d.requiresKnowledgeTest ?? true,
        appliesToAll: d.appliesToAll ?? false,
        required: d.required ?? true,
      },
    });
    return { courseId: course.id, versionId: version.id };
  });

  await audit(principal, {
    action: "hr.training.course.create",
    entityType: COURSE_ENTITY,
    entityId: result.courseId,
    clubId,
    after: { code, title, category, initialVersionId: result.versionId },
  });
  return result;
}

// ---------------------------------------------------------------------------
// Update DRAFT
// ---------------------------------------------------------------------------

export interface UpdateDraftInput {
  title?: string;
  description?: string | null;
  passingScore?: number;
  retakesAllowed?: boolean;
  requiresKnowledgeTest?: boolean;
  required?: boolean;
  appliesToAll?: boolean;
  appliesToDeptIds?: string[] | null;
  appliesToPositionIds?: string[] | null;
  // Video metadata is stamped by the video-upload service, not here.
}

export async function updateDraft(
  principal: Principal,
  versionId: string,
  input: UpdateDraftInput,
): Promise<void> {
  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: versionId },
    include: { course: { select: { clubId: true } } },
  });
  if (!version) throw new NotFoundError(VERSION_ENTITY, versionId);
  assertTenantOwned({ clubId: version.course.clubId }, principal);
  requirePermission(principal, version.course.clubId, "hr:training:write");
  if (version.state !== "DRAFT") {
    throw new ConflictError(
      `Version ${version.version} is ${version.state}; open a new draft to change content.`,
    );
  }
  const data: Record<string, unknown> = {};
  if (input.title !== undefined) {
    const t = input.title.trim();
    if (t.length < 3 || t.length > 200) {
      throw new ValidationError([{ path: "title", message: "Title must be 3-200 characters." }]);
    }
    data.title = t;
  }
  if (input.description !== undefined) data.description = input.description?.trim() || null;
  if (input.passingScore !== undefined) {
    if (!Number.isInteger(input.passingScore) || input.passingScore < 0 || input.passingScore > 100) {
      throw new ValidationError([{ path: "passingScore", message: "Passing score must be an integer 0-100." }]);
    }
    data.passingScore = input.passingScore;
  }
  if (input.retakesAllowed !== undefined) data.retakesAllowed = input.retakesAllowed;
  if (input.requiresKnowledgeTest !== undefined) data.requiresKnowledgeTest = input.requiresKnowledgeTest;
  if (input.required !== undefined) data.required = input.required;
  if (input.appliesToAll !== undefined) data.appliesToAll = input.appliesToAll;
  if (input.appliesToDeptIds !== undefined) {
    data.appliesToDeptIds = input.appliesToDeptIds && input.appliesToDeptIds.length > 0
      ? JSON.stringify(input.appliesToDeptIds)
      : null;
  }
  if (input.appliesToPositionIds !== undefined) {
    data.appliesToPositionIds = input.appliesToPositionIds && input.appliesToPositionIds.length > 0
      ? JSON.stringify(input.appliesToPositionIds)
      : null;
  }
  if (Object.keys(data).length === 0) return;
  // M1d (2026-10-27) -- posting-guard INSIDE the tx so FOR UPDATE on ClubSubscription serializes against suspension.
  await withPostingGuard(
    principal,
    version.course.clubId,
    "hr.training.version.update",
    async (tx) => tx.trainingCourseVersion.update({ where: { id: versionId }, data }),
    { entityType: VERSION_ENTITY, entityId: versionId },
  );
  await audit(principal, {
    action: "hr.training.version.update",
    entityType: VERSION_ENTITY,
    entityId: versionId,
    clubId: version.course.clubId,
    after: Object.keys(data),
  });
}

// ---------------------------------------------------------------------------
// Publish DRAFT
// ---------------------------------------------------------------------------

export interface PublishReadiness {
  ready: boolean;
  reasons: string[];
}

export async function checkPublishReadiness(versionId: string): Promise<PublishReadiness> {
  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: versionId },
    include: {
      questions: {
        include: { options: true },
      },
      checkpoints: { orderBy: { atSecond: "asc" } },
      course: { select: { clubId: true } },
    },
  });
  if (!version) return { ready: false, reasons: ["Version not found."] };
  const reasons: string[] = [];
  if (version.state !== "DRAFT") reasons.push(`Version is already ${version.state}.`);
  if (!version.title || version.title.trim().length < 3) reasons.push("Course title is required.");
  if (!version.videoStorageKey) reasons.push("Training video is required.");
  // EP-TRAIN-4E A2 (2026-10-31) — a published video course MUST have
  // an authoritative duration persisted.  New uploads measure it
  // server-side; legacy versions without it (pre-EP-TRAIN-4E) are
  // blocked from re-publication until the duration is repaired via
  // the dedicated repair script.
  if (version.videoStorageKey && !version.videoDurationSec) {
    reasons.push("Training video is missing its length metadata — ask support to run the duration-repair utility before publishing.");
  }

  // Validate per-question option integrity by question type. Final-
  // assessment questions have checkpointId=null; checkpoint questions
  // are additionally verified below.
  const activeQs = version.questions.filter((q) => q.active);
  for (const q of activeQs) {
    const type = (q.questionType as "SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE") ?? "SINGLE_CHOICE";
    if (q.options.length < 2) {
      reasons.push(`Question '${q.prompt.slice(0, 40)}...' needs at least 2 answer options.`);
      continue;
    }
    const correct = q.options.filter((o) => o.isCorrect).length;
    if (type === "SINGLE_CHOICE" && correct !== 1) {
      reasons.push(`Question '${q.prompt.slice(0, 40)}...' must have exactly one correct answer.`);
    } else if (type === "MULTI_ANSWER" && (correct < 1 || correct === q.options.length)) {
      reasons.push(`Question '${q.prompt.slice(0, 40)}...' must have at least one correct answer and at least one incorrect answer.`);
    } else if (type === "TRUE_FALSE" && (q.options.length !== 2 || correct !== 1)) {
      reasons.push(`Question '${q.prompt.slice(0, 40)}...' (True/False) must have exactly two options with one correct.`);
    }
  }

  // Final assessment -- only required when the course opted into a
  // knowledge test. Preserves the legacy contract.
  if (version.requiresKnowledgeTest) {
    const finalAssessmentQs = activeQs.filter((q) => q.checkpointId === null);
    if (finalAssessmentQs.length === 0) {
      reasons.push("Final assessment requires at least one active question.");
    }
  }

  // Checkpoints -- additional invariants on top of question-type rules.
  if (version.checkpoints.length > 0) {
    const duration = version.videoDurationSec;
    for (const cp of version.checkpoints) {
      if (cp.atSecond < 0) {
        reasons.push(`Checkpoint '${cp.label ?? `@${cp.atSecond}s`}' has an invalid position.`);
      }
      if (duration !== null && cp.atSecond > duration) {
        reasons.push(`Checkpoint '${cp.label ?? `@${cp.atSecond}s`}' is past the end of the video (${duration}s).`);
      }
      const cpQs = activeQs.filter((q) => q.checkpointId === cp.id);
      if (cpQs.length === 0) {
        reasons.push(`Checkpoint '${cp.label ?? `@${cp.atSecond}s`}' needs at least one active question.`);
      }
    }
    // 1s minimum spacing across adjacent checkpoints (list is sorted).
    for (let i = 1; i < version.checkpoints.length; i++) {
      const prev = version.checkpoints[i - 1];
      const curr = version.checkpoints[i];
      if (curr.atSecond - prev.atSecond < 1) {
        reasons.push(`Checkpoints at ${prev.atSecond}s and ${curr.atSecond}s must be at least 1s apart.`);
      }
    }
    // Note: the schema's ON DELETE SET NULL on TrainingQuestion.checkpointId
    // means orphan questions cannot exist -- a deleted checkpoint
    // moves its questions back to the final-assessment bucket (which
    // the loops above already validate).
  }
  return { ready: reasons.length === 0, reasons };
}

export async function publishDraft(
  principal: Principal,
  versionId: string,
): Promise<{ versionId: string; version: number }> {
  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: versionId },
    include: { course: { select: { id: true, clubId: true } } },
  });
  if (!version) throw new NotFoundError(VERSION_ENTITY, versionId);
  assertTenantOwned({ clubId: version.course.clubId }, principal);
  requirePermission(principal, version.course.clubId, "hr:training:publish");
  const readiness = await checkPublishReadiness(versionId);
  if (!readiness.ready) {
    throw new ValidationError(
      readiness.reasons.map((r, i) => ({ path: `publish[${i}]`, message: r })),
    );
  }
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // M1d (2026-10-27) -- posting-guard INSIDE the tx so FOR UPDATE on ClubSubscription serializes against suspension.
    await assertPostingAllowed(
      principal, version.course.clubId,
      "hr.training.version.publish", VERSION_ENTITY, versionId, { tx },
    );
    // Retire any prior PUBLISHED version of the same course.
    await tx.trainingCourseVersion.updateMany({
      where: { courseId: version.course.id, state: "PUBLISHED", NOT: { id: versionId } },
      data: { state: "RETIRED", retiredAt: now },
    });
    await tx.trainingCourseVersion.update({
      where: { id: versionId },
      data: { state: "PUBLISHED", publishedAt: now, publishedByUserId: principal.id },
    });
    await tx.trainingCourse.update({
      where: { id: version.course.id },
      data: { currentVersionId: versionId },
    });
  });
  await audit(principal, {
    action: "hr.training.version.publish",
    entityType: VERSION_ENTITY,
    entityId: versionId,
    clubId: version.course.clubId,
    after: { version: version.version, courseId: version.course.id, publishedAt: now },
  });
  return { versionId, version: version.version };
}

// ---------------------------------------------------------------------------
// Start a new DRAFT (edit a live course without touching history)
// ---------------------------------------------------------------------------

export async function startNewDraft(
  principal: Principal,
  courseId: string,
): Promise<{ versionId: string; version: number }> {
  const course = await prisma.trainingCourse.findUnique({
    where: { id: courseId },
    include: {
      versions: { orderBy: { version: "desc" }, take: 1, include: { questions: { include: { options: true } } } },
    },
  });
  if (!course) throw new NotFoundError(COURSE_ENTITY, courseId);
  assertTenantOwned(course, principal);
  requirePermission(principal, course.clubId, "hr:training:write");

  const latest = course.versions[0];
  if (latest && latest.state === "DRAFT") {
    // Reuse the open draft rather than stacking parallel ones.
    return { versionId: latest.id, version: latest.version };
  }
  const nextNumber = (latest?.version ?? 0) + 1;
  const source = latest;

  const result = await prisma.$transaction(async (tx) => {
    // M1d (2026-10-27) -- posting-guard INSIDE the tx so FOR UPDATE on ClubSubscription serializes against suspension.
    await assertPostingAllowed(principal, course.clubId, "hr.training.version.draft", VERSION_ENTITY, courseId, { tx });
    const draft = await tx.trainingCourseVersion.create({
      data: {
        courseId,
        version: nextNumber,
        state: "DRAFT",
        title: source?.title ?? course.title,
        description: source?.description ?? course.description,
        passingScore: source?.passingScore ?? 80,
        retakesAllowed: source?.retakesAllowed ?? true,
        requiresKnowledgeTest: source?.requiresKnowledgeTest ?? true,
        videoStorageKey: source?.videoStorageKey ?? null,
        videoMimeType: source?.videoMimeType ?? null,
        videoSizeBytes: source?.videoSizeBytes ?? null,
        videoSha256: source?.videoSha256 ?? null,
        videoDurationSec: source?.videoDurationSec ?? null,
        appliesToAll: source?.appliesToAll ?? false,
        appliesToDeptIds: source?.appliesToDeptIds ?? null,
        appliesToPositionIds: source?.appliesToPositionIds ?? null,
        required: source?.required ?? true,
      },
    });
    if (source && source.questions) {
      for (const q of source.questions) {
        const clonedQ = await tx.trainingQuestion.create({
          data: {
            courseVersionId: draft.id,
            prompt: q.prompt,
            displayOrder: q.displayOrder,
            active: q.active,
          },
        });
        for (const o of q.options) {
          await tx.trainingAnswerOption.create({
            data: {
              questionId: clonedQ.id,
              text: o.text,
              isCorrect: o.isCorrect,
              displayOrder: o.displayOrder,
            },
          });
        }
      }
    }
    return { versionId: draft.id, version: draft.version };
  });
  await audit(principal, {
    action: "hr.training.version.draft",
    entityType: VERSION_ENTITY,
    entityId: result.versionId,
    clubId: course.clubId,
    after: { courseId, version: result.version, clonedFrom: source?.id ?? null },
  });
  return result;
}

// ---------------------------------------------------------------------------
// Retire course
// ---------------------------------------------------------------------------

export async function retireCourse(
  principal: Principal,
  courseId: string,
): Promise<void> {
  const course = await prisma.trainingCourse.findUnique({
    where: { id: courseId },
    include: { versions: { where: { state: "PUBLISHED" }, select: { id: true } } },
  });
  if (!course) throw new NotFoundError(COURSE_ENTITY, courseId);
  assertTenantOwned(course, principal);
  requirePermission(principal, course.clubId, "hr:training:publish");
  if (course.retiredAt) return;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // M1d (2026-10-27) -- posting-guard INSIDE the tx so FOR UPDATE on ClubSubscription serializes against suspension.
    await assertPostingAllowed(principal, course.clubId, "hr.training.course.retire", COURSE_ENTITY, courseId, { tx });
    await tx.trainingCourse.update({
      where: { id: courseId },
      data: { retiredAt: now, currentVersionId: null },
    });
    if (course.versions.length > 0) {
      await tx.trainingCourseVersion.updateMany({
        where: { courseId, state: "PUBLISHED" },
        data: { state: "RETIRED", retiredAt: now },
      });
    }
  });
  await audit(principal, {
    action: "hr.training.course.retire",
    entityType: COURSE_ENTITY,
    entityId: courseId,
    clubId: course.clubId,
    after: { retiredAt: now, publishedVersionsRetired: course.versions.length },
  });
}

// ---------------------------------------------------------------------------
// EP-TRAIN-4E B1-B5 (2026-10-31) — restore + hard-delete lifecycle
// ---------------------------------------------------------------------------

/** Un-archive a course that was previously `retireCourse`'d.
 *  Clears Course.retiredAt and promotes the most-recently-published
 *  version back to PUBLISHED (currentVersionId points to it again).
 *  Idempotent: calling on a non-retired course is a no-op. */
export async function restoreCourse(
  principal: Principal,
  courseId: string,
): Promise<void> {
  const course = await prisma.trainingCourse.findUnique({
    where: { id: courseId },
    include: {
      versions: {
        orderBy: [{ publishedAt: "desc" }, { version: "desc" }],
      },
    },
  });
  if (!course) throw new NotFoundError(COURSE_ENTITY, courseId);
  assertTenantOwned(course, principal);
  requirePermission(principal, course.clubId, "hr:training:publish");
  if (!course.retiredAt) return;

  // Pick the version that was PUBLISHED (or last RETIRED-from-published)
  // to re-promote.  If no version was ever published, the course goes
  // back to its draft-only state (no currentVersionId).
  const candidate = course.versions.find((v) => v.state === "PUBLISHED")
    ?? course.versions.find((v) => v.state === "RETIRED" && v.publishedAt !== null)
    ?? null;

  await prisma.$transaction(async (tx) => {
    await assertPostingAllowed(principal, course.clubId, "hr.training.course.restore", COURSE_ENTITY, courseId, { tx });
    await tx.trainingCourse.update({
      where: { id: courseId },
      data: {
        retiredAt: null,
        currentVersionId: candidate?.id ?? null,
      },
    });
    if (candidate) {
      await tx.trainingCourseVersion.update({
        where: { id: candidate.id },
        data: { state: "PUBLISHED", retiredAt: null },
      });
    }
  });
  await audit(principal, {
    action: "hr.training.course.restore",
    entityType: COURSE_ENTITY,
    entityId: courseId,
    clubId: course.clubId,
    after: { restoredAt: new Date(), currentVersionId: candidate?.id ?? null },
  });
}

/** How many legitimate training records point at this course? */
async function countCourseHistory(courseId: string): Promise<{
  progressRows: number;
  attemptRows: number;
  completionRows: number;
  assignmentRows: number;
  total: number;
}> {
  const [progressRows, attemptRows, completionRows, assignmentRows] = await Promise.all([
    prisma.trainingProgress.count({ where: { courseVersion: { courseId } } }),
    prisma.trainingAttempt.count({ where: { courseVersion: { courseId } } }),
    prisma.trainingCompletion.count({ where: { courseId } }),
    prisma.trainingAssignment.count({ where: { courseId } }),
  ]);
  return {
    progressRows,
    attemptRows,
    completionRows,
    assignmentRows,
    total: progressRows + attemptRows + completionRows + assignmentRows,
  };
}

/** DELETE a DRAFT course with no legitimate training history.
 *
 *  Preconditions (ALL must hold or ConflictError is thrown):
 *   - the course has never been PUBLISHED (no publishedAt on any version);
 *   - every version is in DRAFT state;
 *   - zero TrainingProgress / TrainingAttempt / TrainingCompletion rows;
 *   - zero TrainingAssignment rows.
 *
 *  Cascading deletes (handled by Prisma schema's onDelete relations):
 *   TrainingAnswerOption → TrainingQuestion → TrainingCheckpoint →
 *   TrainingCourseVersion → TrainingCourse.
 *
 *  R2 media objects whose storageKey is only referenced by versions on
 *  THIS course are deleted after the DB write.  (Keys referenced from
 *  other courses' versions are left alone.)
 *
 *  Audit row written with a full before-snapshot. */
export async function deleteDraftCourse(
  principal: Principal,
  courseId: string,
): Promise<void> {
  const course = await prisma.trainingCourse.findUnique({
    where: { id: courseId },
    include: { versions: { select: { id: true, state: true, publishedAt: true, videoStorageKey: true } } },
  });
  if (!course) throw new NotFoundError(COURSE_ENTITY, courseId);
  assertTenantOwned(course, principal);
  requirePermission(principal, course.clubId, "hr:training:publish");

  const nonDraft = course.versions.filter((v) => v.state !== "DRAFT" || v.publishedAt !== null);
  if (nonDraft.length > 0) {
    throw new ConflictError(
      "This course has a published or retired version and can't be hard-deleted.  Archive it instead; its training history will remain available to administrators.",
    );
  }
  const history = await countCourseHistory(courseId);
  if (history.total > 0) {
    throw new ConflictError(
      `Can't delete: ${history.total} training record(s) reference this course (progress ${history.progressRows}, attempts ${history.attemptRows}, completions ${history.completionRows}, assignments ${history.assignmentRows}).  Archive it instead.`,
    );
  }

  const videoKeys = course.versions.map((v) => v.videoStorageKey).filter((k): k is string => typeof k === "string");

  await withPostingGuard(
    principal,
    course.clubId,
    "hr.training.course.delete-draft",
    async (tx) => tx.trainingCourse.delete({ where: { id: courseId } }),
    { entityType: COURSE_ENTITY, entityId: courseId },
  );
  await audit(principal, {
    action: "hr.training.course.delete-draft",
    entityType: COURSE_ENTITY,
    entityId: courseId,
    clubId: course.clubId,
    before: {
      code: course.code,
      title: course.title,
      category: course.category,
      versionCount: course.versions.length,
      videoStorageKeys: videoKeys,
    },
  });
  // R2 object cleanup is best-effort — the DB write is authoritative.
  // A failed R2 delete leaves orphan bytes that cost nothing more than
  // a sweep by a future ops task.
  await cleanupUnreferencedVideoObjects(course.clubId, videoKeys, courseId);
}

/** PERMANENTLY delete a course regardless of state — ONLY when zero
 *  legitimate training records reference it.  Intended for cleaning
 *  up disposable test courses on staging or in a dev tenant without
 *  destroying any real employee compliance evidence.
 *
 *  Preconditions:
 *   - zero TrainingProgress / TrainingAttempt / TrainingCompletion /
 *     TrainingAssignment rows (as `deleteDraftCourse`);
 *   - the caller holds `hr:training:publish`.
 *
 *  Does NOT infer "test course" from the title.  The caller provides
 *  the courseId explicitly and the server enforces the dependency
 *  invariant. */
export async function permanentlyDeleteCourse(
  principal: Principal,
  courseId: string,
): Promise<void> {
  const course = await prisma.trainingCourse.findUnique({
    where: { id: courseId },
    include: { versions: { select: { id: true, state: true, videoStorageKey: true } } },
  });
  if (!course) throw new NotFoundError(COURSE_ENTITY, courseId);
  assertTenantOwned(course, principal);
  requirePermission(principal, course.clubId, "hr:training:publish");

  const history = await countCourseHistory(courseId);
  if (history.total > 0) {
    throw new ConflictError(
      `Can't permanently delete: ${history.total} training record(s) reference this course (progress ${history.progressRows}, attempts ${history.attemptRows}, completions ${history.completionRows}, assignments ${history.assignmentRows}).  Archive it instead.`,
    );
  }

  const videoKeys = course.versions.map((v) => v.videoStorageKey).filter((k): k is string => typeof k === "string");

  await withPostingGuard(
    principal,
    course.clubId,
    "hr.training.course.delete-permanent",
    async (tx) => tx.trainingCourse.delete({ where: { id: courseId } }),
    { entityType: COURSE_ENTITY, entityId: courseId },
  );
  await audit(principal, {
    action: "hr.training.course.delete-permanent",
    entityType: COURSE_ENTITY,
    entityId: courseId,
    clubId: course.clubId,
    before: {
      code: course.code,
      title: course.title,
      category: course.category,
      versionCount: course.versions.length,
      versionStates: course.versions.map((v) => v.state),
      videoStorageKeys: videoKeys,
    },
  });
  await cleanupUnreferencedVideoObjects(course.clubId, videoKeys, courseId);
}

/** EP-TRAIN-4E-2 (2026-11-01) — concurrency-safe cleanup of
 *  unreferenced R2 video objects.
 *
 *  Required invariant (founder-mandated):
 *    "No video object may be physically deleted while any committed
 *     course version references it, including references created
 *     concurrently with cleanup."
 *
 *  Mechanism: a Postgres transaction-scoped advisory lock keyed on
 *  the storageKey (via `hashtextextended`) serializes ALL operations
 *  that touch a given storageKey — both cleanup and reference-
 *  establishment paths acquire the same lock before mutating.  The
 *  reference-count check AND the physical R2 delete happen inside
 *  the same transaction while the lock is held, so no concurrent
 *  path can establish a new reference between the check and the
 *  delete.  See `acquireStorageKeyLock` + its callers in
 *  `uploadTrainingVideo` for the reference-side participation.
 *
 *  Failure handling (per directive §2):
 *    - A failed R2 delete does NOT corrupt the DB course delete
 *      (which has already committed in a prior transaction).  The
 *      failure is recorded in AuditLog as
 *      `hr.training.video.r2-delete-failed`, allowing an operator
 *      to reconcile orphaned R2 bytes later.
 *    - A failed lock acquisition or reference recount is similarly
 *      audited as `hr.training.video.cleanup-tx-failed`.  No DB
 *      change happens if the lock-protected check fails.
 *    - A retry of this helper on the same key is safe: once the
 *      R2 object is gone, re-checking confirms it; if another
 *      reference exists meanwhile, the retry skips the delete. */
async function cleanupUnreferencedVideoObjects(
  clubId: string,
  videoKeys: string[],
  excludeCourseId: string,
): Promise<void> {
  if (videoKeys.length === 0) return;
  const uniqueKeys = Array.from(new Set(videoKeys));
  const { resolveDocumentStorage } = await import("../../documents/storage");
  const storage = await resolveDocumentStorage({ clubId });
  for (const key of uniqueKeys) {
    try {
      await prisma.$transaction(async (tx) => {
        // §2.7 of EP-TRAIN-4E-1 directive: acquire the per-key
        // advisory lock BEFORE the reference check.  Any concurrent
        // reference-creator takes the same lock and will block
        // until this transaction commits.  Any concurrent cleanup
        // will serialize on the same lock.  Transaction-scoped so
        // the lock releases automatically on commit OR abort.
        await acquireStorageKeyLock(tx, key);
        const otherRefs = await tx.trainingCourseVersion.count({
          where: {
            videoStorageKey: key,
            course: { id: { not: excludeCourseId } },
          },
        });
        if (otherRefs > 0) {
          // Another course still references this key — DO NOT touch R2.
          // Audit so an operator sees the preserved key if they're
          // tracing a cleanup.
          await tx.auditLog.create({
            data: {
              clubId,
              action: "hr.training.video.cleanup-skipped",
              entityType: "TrainingVideoStorageKey",
              entityId: key,
              afterJson: safeAuditJson({ reason: "still-referenced", otherCourseRefCount: otherRefs }),
            },
          });
          return;
        }
        // Zero references confirmed under lock.  Physical R2 delete
        // happens INSIDE this transaction while the lock is still
        // held, so no reference-creator can race in between.  If R2
        // delete throws, we fall through to the catch below WITHOUT
        // committing an audit "deleted" row — the key stays in R2
        // and the next cleanup retry will try again.
        try {
          await storage.delete({ storageKey: key });
          await tx.auditLog.create({
            data: {
              clubId,
              action: "hr.training.video.r2-deleted",
              entityType: "TrainingVideoStorageKey",
              entityId: key,
              afterJson: safeAuditJson({ deletedAt: new Date().toISOString() }),
            },
          });
        } catch (r2err) {
          // R2 failure: do NOT rollback the DB course delete (it's
          // already committed in a prior tx).  Record the orphan so
          // an operator can reconcile.  Then rethrow to abort this
          // nested transaction so the audit "r2-deleted" row doesn't
          // land — the catch below writes the failure-audit instead.
          const msg = r2err instanceof Error ? r2err.message : String(r2err);
          throw new Error(`R2_DELETE_FAILED:${msg}`);
        }
      }, { timeout: 60_000 });
    } catch (err) {
      // Any failure (lock timeout, R2 delete fail, audit insert fail)
      // lands here.  Record so operators can reconcile orphaned R2
      // bytes, then continue to the next key.
      try {
        await prisma.auditLog.create({
          data: {
            clubId,
            action: "hr.training.video.r2-delete-failed",
            entityType: "TrainingVideoStorageKey",
            entityId: key,
            afterJson: safeAuditJson({
              reason: err instanceof Error ? err.message : String(err),
              failedAt: new Date().toISOString(),
            }),
          },
        });
      } catch { /* even audit failed — swallow */ }
    }
  }
}

/** Postgres advisory lock keyed on a stable 64-bit hash of the
 *  storageKey.  Transaction-scoped so the lock releases on commit
 *  OR abort; cannot leak across requests. */
export async function acquireStorageKeyLock(tx: Prisma.TransactionClient, storageKey: string): Promise<void> {
  // hashtextextended(text, bigint) returns bigint; combined with
  // pg_advisory_xact_lock(bigint) gives us a per-storageKey
  // serialization point.  See postgresql.org/docs/current/functions-admin.html
  // and functions-string.html.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${storageKey}, 0))`;
}

/** JSON stringify + size cap for audit payloads. */
function safeAuditJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 4096 ? s.slice(0, 4093) + "..." : s;
  } catch {
    return JSON.stringify({ error: "unserialisable" });
  }
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export async function listClubCourses(
  principal: Principal,
  clubId: string,
): Promise<Array<{
  id: string;
  code: string;
  title: string;
  category: string;
  retiredAt: Date | null;
  currentVersion: { id: string; version: number; state: string; required: boolean } | null;
  draftVersion: { id: string; version: number } | null;
  // EP-TRAIN-4E B1 (2026-10-31): true iff any legitimate training
  // record points at this course.  Row-action UI uses this flag to
  // decide whether permanent-delete / draft-delete is safe to offer.
  hasHistory: boolean;
}>> {
  requirePermission(principal, clubId, "hr:training:read");
  const rows = await prisma.trainingCourse.findMany({
    where: { clubId },
    orderBy: [{ retiredAt: "asc" }, { title: "asc" }],
    include: {
      versions: {
        where: { state: { in: ["DRAFT", "PUBLISHED"] } },
        select: { id: true, version: true, state: true, required: true },
      },
      _count: {
        select: {
          completions: true,
          assignments: true,
        },
      },
    },
  });
  // Count TrainingProgress + TrainingAttempt per course via the
  // courseVersion -> course FK; a single aggregate query per fetch
  // avoids an N+1 pattern.
  //
  // EP-TRAIN-4E (2026-11-01) — the versionToCourse map MUST include
  // RETIRED versions too, because an archived course's progress /
  // attempt rows still reference the RETIRED version and must count
  // toward hasHistory.  The outer `include.versions` filter above is
  // only DRAFT/PUBLISHED because we use that collection to pick the
  // current/draft version for the UI; a separate full-state query
  // populates the version-to-course map for history counting.
  const courseIds = rows.map((r) => r.id);
  const allVersions = courseIds.length > 0
    ? await prisma.trainingCourseVersion.findMany({
        where: { courseId: { in: courseIds } },
        select: { id: true, courseId: true },
      })
    : [];
  const versionToCourse = new Map<string, string>();
  for (const v of allVersions) versionToCourse.set(v.id, v.courseId);
  const [progressGroup, attemptGroup] = courseIds.length > 0
    ? await Promise.all([
        prisma.trainingProgress.groupBy({
          by: ["courseVersionId"],
          where: { courseVersion: { courseId: { in: courseIds } } },
          _count: { _all: true },
        }),
        prisma.trainingAttempt.groupBy({
          by: ["courseVersionId"],
          where: { courseVersion: { courseId: { in: courseIds } } },
          _count: { _all: true },
        }),
      ])
    : [[], []];
  const progressByCourse = new Map<string, number>();
  const attemptByCourse = new Map<string, number>();
  for (const g of progressGroup) {
    const cid = versionToCourse.get(g.courseVersionId);
    if (!cid) continue;
    progressByCourse.set(cid, (progressByCourse.get(cid) ?? 0) + g._count._all);
  }
  for (const g of attemptGroup) {
    const cid = versionToCourse.get(g.courseVersionId);
    if (!cid) continue;
    attemptByCourse.set(cid, (attemptByCourse.get(cid) ?? 0) + g._count._all);
  }
  return rows.map((r) => {
    const currentVersion = r.versions.find((v) => v.state === "PUBLISHED") ?? null;
    const draftVersion = r.versions.find((v) => v.state === "DRAFT")
      ? { id: r.versions.find((v) => v.state === "DRAFT")!.id, version: r.versions.find((v) => v.state === "DRAFT")!.version }
      : null;
    const historyTotal =
      (r._count?.completions ?? 0)
      + (r._count?.assignments ?? 0)
      + (progressByCourse.get(r.id) ?? 0)
      + (attemptByCourse.get(r.id) ?? 0);
    return {
      id: r.id,
      code: r.code,
      title: r.title,
      category: r.category,
      retiredAt: r.retiredAt,
      currentVersion,
      draftVersion,
      hasHistory: historyTotal > 0,
    };
  });
}
