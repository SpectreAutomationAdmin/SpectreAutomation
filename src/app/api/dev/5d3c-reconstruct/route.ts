// EP-TRAIN-5D-3C-B (2026-11-02) — one-time temporary admin endpoint to
// reconstruct ORIENTATION_2027 v4 from the intact v2 instructional content
// using the real `publishDraft` service.
//
// This file is intentionally TEMPORARY and MUST be removed in the follow-on
// Deploy #2 cleanup slice after successful execution per the founder's
// EP-TRAIN-5D-3C-B directive §5.
//
// Guards (defense-in-depth):
//   1. process.env.FLY_APP_NAME === "spectre-staging"
//      -- physically unreachable from any other Fly app.
//   2. process.env.SPECTRE_5D3C_RECONSTRUCT_ENABLED === "1"
//      -- explicit secret-set gate on staging.
//   3. Authenticated session via getCurrentPrincipal.
//   4. caller.email === the founder's address.
//   5. caller has hr:training:publish on COULEE_CLUB_ID.
//   6. Request body matches the hard-coded expected shape, including
//      course + v2 + v3 ids, expected passingScore, expected baseline.
//   7. Idempotence: no v4+ already exists.
//
// The endpoint invokes the actual `publishDraft` service for publication
// (no manually replicated Prisma publication transaction). Only draft
// cloning is implemented inline because `startNewDraft` clones from the
// latest version, not from an arbitrary source.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { publishDraft } from "@/lib/hr/training/courses";
import { reconstructTrainingDraftFromSource } from "@/lib/hr/training/reconstruct-5d3c-helper";
import { AppError, ValidationError, ConflictError, UnauthenticatedError, ForbiddenError, NotFoundError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPECTED_FLY_APP = "spectre-staging";
const FOUNDER_EMAIL = "cturcato@spectreautomation.com";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const ORIENT_COURSE_ID = "cmvvgznyf000gz9nu3nbqm09q";
const ORIENT_V2_ID = "cmvwwd7vw004jjjkgpzpn5tzx";
const ORIENT_V3_ID = "cmvzdjzt10002wu9jpfsp9hjc";
const EXPECTED_PASSING_SCORE = 80;
const SLICE = "EP-TRAIN-5D-3C-B";

function refuse(message: string, status: number) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(req: NextRequest) {
  if (process.env.FLY_APP_NAME !== EXPECTED_FLY_APP) return refuse("Not on staging Fly app.", 403);
  if (process.env.SPECTRE_5D3C_RECONSTRUCT_ENABLED !== "1") return refuse("Endpoint disabled.", 403);

  const caller = await getCurrentPrincipal();
  if (!caller) return refuse("Unauthenticated.", 401);
  if (caller.email !== FOUNDER_EMAIL) return refuse("Not authorized.", 403);
  if (!hasPermission(caller, COULEE_CLUB_ID, "hr:training:publish")) return refuse("Missing permission.", 403);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return refuse("Malformed request body.", 400);
  }
  const allowedKeys = new Set(["expectedCourseId", "expectedSourceVersionId", "expectedCurrentVersionId", "expectedPassingScore"]);
  for (const key of Object.keys(body)) if (!allowedKeys.has(key)) return refuse(`Unknown parameter: ${key}`, 400);
  if (body.expectedCourseId !== ORIENT_COURSE_ID) return refuse("expectedCourseId mismatch.", 400);
  if (body.expectedSourceVersionId !== ORIENT_V2_ID) return refuse("expectedSourceVersionId mismatch.", 400);
  if (body.expectedCurrentVersionId !== ORIENT_V3_ID) return refuse("expectedCurrentVersionId mismatch.", 400);
  if (body.expectedPassingScore !== EXPECTED_PASSING_SCORE) return refuse("expectedPassingScore mismatch.", 400);

  try {
    // Verify course + v2 + v3 baseline matches the hard-coded expectations.
    const course = await prisma.trainingCourse.findUnique({
      where: { id: ORIENT_COURSE_ID },
      select: { id: true, clubId: true, retiredAt: true, currentVersionId: true },
    });
    if (!course) return refuse("Course not found.", 404);
    if (course.clubId !== COULEE_CLUB_ID) return refuse("Course tenant mismatch.", 400);
    if (course.retiredAt) return refuse("Course is retired.", 409);
    if (course.currentVersionId !== ORIENT_V3_ID) return refuse("course.currentVersionId drift.", 409);

    const v3 = await prisma.trainingCourseVersion.findUnique({
      where: { id: ORIENT_V3_ID },
      select: { id: true, state: true, retiredAt: true, version: true },
    });
    if (!v3 || v3.state !== "PUBLISHED" || v3.retiredAt !== null) return refuse("v3 is not current PUBLISHED.", 409);

    // Verify baseline obligation state (defense-in-depth; prevents replay/surprise).
    const obByStatus = await prisma.trainingObligation.groupBy({ by: ["status"], _count: { _all: true } });
    const byStatus = Object.fromEntries(obByStatus.map((r) => [r.status, r._count._all]));
    const expectedByStatus = { OUTSTANDING: 1, SUPERSEDED: 1, CANCELED: 5 };
    for (const [k, v] of Object.entries(expectedByStatus)) {
      if (byStatus[k] !== v) {
        return refuse(`Obligation baseline mismatch at ${k}: expected ${v}, got ${byStatus[k] ?? 0}`, 409);
      }
    }

    // Snapshot BEFORE (for the response + for the final hard-fail post-condition
    // assertions after publishDraft).
    const obCountBefore = await prisma.trainingObligation.count();
    const founderBefore = {
      completions: await prisma.trainingCompletion.count({ where: { employeeId: "cmu0fiaod000187prcy9ufo2d" } }),
      attempts: await prisma.trainingAttempt.count({ where: { employeeId: "cmu0fiaod000187prcy9ufo2d" } }),
      progress: await prisma.trainingProgress.count({ where: { employeeId: "cmu0fiaod000187prcy9ufo2d" } }),
    };

    // TX1 -- clone v2 into v4 DRAFT via the shared reconstruction helper.
    const draft = await reconstructTrainingDraftFromSource(caller, {
      courseId: ORIENT_COURSE_ID,
      sourceVersionId: ORIENT_V2_ID,
      expectedPassingScore: EXPECTED_PASSING_SCORE,
      slice: SLICE,
    });

    // Pre-publication structural guard.
    const v4Draft = await prisma.trainingCourseVersion.findUnique({
      where: { id: draft.draftId },
      include: {
        checkpoints: { orderBy: { displayOrder: "asc" } },
        questions: { include: { options: { orderBy: { displayOrder: "asc" } } }, orderBy: { displayOrder: "asc" } },
      },
    });
    if (!v4Draft || v4Draft.state !== "DRAFT") return refuse("v4 draft not in expected state.", 500);
    if (v4Draft.passingScore !== EXPECTED_PASSING_SCORE) return refuse("v4 passingScore drift.", 500);
    if (v4Draft.checkpoints.length !== 2) return refuse(`v4 checkpoint count=${v4Draft.checkpoints.length}, expected 2`, 500);
    if (v4Draft.questions.length !== 6) return refuse(`v4 question count=${v4Draft.questions.length}, expected 6`, 500);
    const tf = v4Draft.questions.find((q) => q.prompt === "Ta dah?");
    if (!tf || tf.questionType !== "TRUE_FALSE") return refuse("v4 missing TRUE_FALSE on 'Ta dah?'.", 500);
    const cpBound = v4Draft.questions.filter((q) => q.checkpointId !== null).length;
    if (cpBound !== 2) return refuse(`v4 checkpoint-bound questions=${cpBound}, expected 2`, 500);

    // TX2 -- publish via the real publishDraft service.
    const publishResult = await publishDraft(caller, draft.draftId);

    // Post-condition verification.
    const v4Final = await prisma.trainingCourseVersion.findUnique({
      where: { id: draft.draftId },
      select: { id: true, state: true, version: true, publishedAt: true, publishedByUserId: true, passingScore: true },
    });
    const v3Final = await prisma.trainingCourseVersion.findUnique({
      where: { id: ORIENT_V3_ID },
      select: { state: true, retiredAt: true },
    });
    const v2Final = await prisma.trainingCourseVersion.findUnique({
      where: { id: ORIENT_V2_ID },
      select: { state: true, retiredAt: true },
    });
    const courseFinal = await prisma.trainingCourse.findUnique({
      where: { id: ORIENT_COURSE_ID },
      select: { currentVersionId: true },
    });
    const obCountAfter = await prisma.trainingObligation.count();
    const obByStatusAfter = Object.fromEntries(
      (await prisma.trainingObligation.groupBy({ by: ["status"], _count: { _all: true } })).map((r) => [r.status, r._count._all]),
    );
    const founderAfter = {
      completions: await prisma.trainingCompletion.count({ where: { employeeId: "cmu0fiaod000187prcy9ufo2d" } }),
      attempts: await prisma.trainingAttempt.count({ where: { employeeId: "cmu0fiaod000187prcy9ufo2d" } }),
      progress: await prisma.trainingProgress.count({ where: { employeeId: "cmu0fiaod000187prcy9ufo2d" } }),
    };

    const errors: string[] = [];
    if (!v4Final || v4Final.state !== "PUBLISHED") errors.push("v4 not PUBLISHED");
    if (!v3Final || v3Final.state !== "RETIRED" || v3Final.retiredAt === null) errors.push("v3 not RETIRED");
    if (!v2Final || v2Final.state !== "RETIRED") errors.push("v2 state unexpectedly changed");
    if (!courseFinal || courseFinal.currentVersionId !== draft.draftId) errors.push("currentVersionId did not flip to v4");
    if (obCountAfter !== obCountBefore) errors.push(`obligation count drift ${obCountBefore} -> ${obCountAfter}`);
    if (JSON.stringify(founderBefore) !== JSON.stringify(founderAfter)) errors.push("founder record changed");

    return NextResponse.json({
      ok: errors.length === 0,
      slice: SLICE,
      errors,
      v4Final, v3Final, v2Final, courseFinal,
      publishResult,
      obCountBefore, obCountAfter,
      obByStatusAfter,
      founderBefore, founderAfter,
    }, { status: errors.length === 0 ? 200 : 500 });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return refuse(err.message, 401);
    if (err instanceof ForbiddenError) return refuse(err.message, 403);
    if (err instanceof NotFoundError) return refuse(err.message, 404);
    if (err instanceof ConflictError) return refuse(err.message, 409);
    if (err instanceof ValidationError) {
      return NextResponse.json({ ok: false, error: err.message, issues: err.issues }, { status: 400 });
    }
    if (err instanceof AppError) return refuse(err.message, 500);
    const message = err instanceof Error ? err.message : String(err);
    return refuse(message, 500);
  }
}
