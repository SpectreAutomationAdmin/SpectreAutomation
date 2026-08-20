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

import { prisma } from "../../prisma";
import { audit } from "../../audit";
import { requirePermission, type Principal } from "../../rbac";
import { assertTenantOwned } from "../../services/tenant";
import { assertPostingAllowed } from "../../posting-guard";
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
  await assertPostingAllowed(principal, clubId, "hr.training.course.create", COURSE_ENTITY, clubId);

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
  await assertPostingAllowed(principal, version.course.clubId, "hr.training.version.update", VERSION_ENTITY, versionId);
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
  await prisma.trainingCourseVersion.update({ where: { id: versionId }, data });
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
      course: { select: { clubId: true } },
    },
  });
  if (!version) return { ready: false, reasons: ["Version not found."] };
  const reasons: string[] = [];
  if (version.state !== "DRAFT") reasons.push(`Version is already ${version.state}.`);
  if (!version.title || version.title.trim().length < 3) reasons.push("Course title is required.");
  if (!version.videoStorageKey) reasons.push("Training video is required.");
  // Note: an explicit-assignment-only course (no All / dept / position)
  // is legitimate per §16 — the admin simply assigns per-employee.
  // We do NOT require broadcast applicability at publish time.
  if (version.requiresKnowledgeTest) {
    const activeQs = version.questions.filter((q) => q.active);
    if (activeQs.length === 0) reasons.push("Knowledge test requires at least one active question.");
    for (const q of activeQs) {
      if (q.options.length < 2) {
        reasons.push(`Question '${q.prompt.slice(0, 40)}...' needs at least 2 answer options.`);
      }
      const correctCount = q.options.filter((o) => o.isCorrect).length;
      if (correctCount !== 1) {
        reasons.push(`Question '${q.prompt.slice(0, 40)}...' must have exactly one correct answer.`);
      }
    }
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
  await assertPostingAllowed(
    principal, version.course.clubId,
    "hr.training.version.publish", VERSION_ENTITY, versionId,
  );
  const readiness = await checkPublishReadiness(versionId);
  if (!readiness.ready) {
    throw new ValidationError(
      readiness.reasons.map((r, i) => ({ path: `publish[${i}]`, message: r })),
    );
  }
  const now = new Date();
  await prisma.$transaction(async (tx) => {
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
  await assertPostingAllowed(principal, course.clubId, "hr.training.version.draft", VERSION_ENTITY, courseId);

  const latest = course.versions[0];
  if (latest && latest.state === "DRAFT") {
    // Reuse the open draft rather than stacking parallel ones.
    return { versionId: latest.id, version: latest.version };
  }
  const nextNumber = (latest?.version ?? 0) + 1;
  const source = latest;

  const result = await prisma.$transaction(async (tx) => {
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
  await assertPostingAllowed(principal, course.clubId, "hr.training.course.retire", COURSE_ENTITY, courseId);
  if (course.retiredAt) return;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
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
    },
  });
  return rows.map((r) => {
    const currentVersion = r.versions.find((v) => v.state === "PUBLISHED") ?? null;
    const draftVersion = r.versions.find((v) => v.state === "DRAFT")
      ? { id: r.versions.find((v) => v.state === "DRAFT")!.id, version: r.versions.find((v) => v.state === "DRAFT")!.version }
      : null;
    return {
      id: r.id,
      code: r.code,
      title: r.title,
      category: r.category,
      retiredAt: r.retiredAt,
      currentVersion,
      draftVersion,
    };
  });
}
