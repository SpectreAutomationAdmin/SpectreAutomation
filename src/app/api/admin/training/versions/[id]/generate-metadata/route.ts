// EP-TRAIN-4Y-T §4+§5 — POST /api/admin/training/versions/[id]/generate-metadata
//
// Orchestrates grounded metadata generation for a prepared version:
//   1. Loads the resolved transcript segments (non-pending only).
//   2. Runs `generateCourseMetadata` (deterministic by default; AI
//      path returns NOT_YET_WIRED until Modal is authorised).
//   3. Updates the course's `code` and `title` + the version's
//      `description` via the existing `updateDraft` service, so
//      tenant/permission/DRAFT-state guards + audit are unchanged.
//   4. Idempotent: if the course title is still the provisional
//      placeholder, we apply the generated metadata. If the manager
//      has already edited the title, we DO NOT overwrite — the
//      directive explicitly forbids silently changing an established
//      code.
//
// Permissions: `hr:training:write`. Tenant-scoped at every read.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { updateDraft } from "@/lib/hr/training/courses";
import { generateCourseMetadata } from "@/lib/hr/training/ai-metadata/course-metadata-generator";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVISIONAL_TITLE = "Untitled training course";
const PROVISIONAL_CODE_PREFIX = "AUTO-DRAFT";

export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: versionId } = await context.params;
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: versionId, course: { clubId } },
    include: {
      course: { select: { id: true, code: true, title: true } },
    },
  });
  if (!version) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!version.videoSha256) {
    return NextResponse.json(
      { error: "video_required", reason: "NO_VIDEO" },
      { status: 400 },
    );
  }

  const isProvisional =
    version.course.title === PROVISIONAL_TITLE &&
    version.course.code.startsWith(PROVISIONAL_CODE_PREFIX);

  // EP-TRAIN-4Y-T §5 short-circuit: if the course has already been
  // established (title + code are not the AUTO-DRAFT placeholders),
  // we NEVER overwrite — so there is no need to pay the transcript
  // read cost. Return applied=false with the explicit skipped reason
  // so callers see the stable, idempotent response regardless of
  // transcript state.
  if (!isProvisional) {
    return NextResponse.json({
      ok: true,
      applied: false,
      skippedReason: "COURSE_ALREADY_FINALISED",
      metadata: null,
    });
  }

  // Load the resolved transcript via the existing build + segment
  // rows. We filter out segments the ingestion marked pending-review;
  // metadata is based ONLY on reliable evidence.
  const build = await prisma.trainingTranscriptBuild.findFirst({
    where: { clubId, sourceVideoSha256: version.videoSha256 },
    orderBy: { producedAt: "desc" },
    select: { id: true },
  });
  if (!build) {
    return NextResponse.json(
      {
        ok: false,
        reason: "TRANSCRIPT_NOT_READY",
        message: "Transcript is not yet ingested; retry after preparation completes.",
      },
      { status: 409 },
    );
  }
  // EP-TRAIN-4Y-U §8 — pending-review is about evidence grounding
  // for AI-generated question DRAFTS (segments the reviewer must
  // attest before they can serve as citation evidence). It is NOT
  // about whether the transcript text is readable. Use every
  // non-empty segment for title/description extraction. The earlier
  // filter was dropping 100% of the Silver Springs shared build's
  // segments because they carry pending-review markers from the
  // attestation workflow, leading to NO_USABLE_TRANSCRIPT on every
  // provisional course that reuses that video.
  const segments = await prisma.trainingTranscriptSegment.findMany({
    where: { transcriptBuildId: build.id, clubId },
    orderBy: { segmentIndex: "asc" },
    select: { segmentIndex: true, text: true },
  });
  const usableSegments = segments
    .filter((s) => (s.text ?? "").trim().length > 0)
    .map((s) => ({ segmentIndex: s.segmentIndex, text: s.text }));

  if (usableSegments.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        reason: "NO_USABLE_TRANSCRIPT",
        message: "Transcript has no usable segments; cannot propose metadata.",
      },
      { status: 409 },
    );
  }

  const metadata = await generateCourseMetadata({ segments: usableSegments });

  // Apply the generated metadata. The provisional-guard check above
  // already returned early for non-provisional courses — so reaching
  // this point means the course is still at AUTO-DRAFT placeholders.
  let applied = false;
  {
    try {
      await updateDraft(principal, version.id, {
        title: metadata.title,
        description: metadata.description,
      });
      // Course code update requires a dedicated path (createCourse
      // set it from the input). We update the course row directly
      // here because `updateDraft` is version-scoped. The code
      // regex guard below mirrors the service's normaliseCode.
      // Collision-safe retry: on P2002 (unique conflict on
      // (clubId, code)), swap in a fresh 6-hex suffix.
      let codeAttempt = metadata.code;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await prisma.trainingCourse.update({
            where: { id: version.courseId },
            data: { code: codeAttempt },
          });
          break;
        } catch (err) {
          if ((err as { code?: string })?.code === "P2002" && attempt < 2) {
            const fresh = await generateCourseMetadata({ segments: usableSegments });
            codeAttempt = fresh.code;
            continue;
          }
          throw err;
        }
      }
      applied = true;
      void audit(principal, {
        action: "hr.training.course.metadata.generated",
        entityType: "TrainingCourseVersion",
        entityId: version.id,
        clubId,
        after: {
          inferenceSource: metadata.inferenceSource,
          titleFirst60: metadata.title.slice(0, 60),
          codeFirst60: codeAttempt.slice(0, 60),
        },
      });
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          reason: "APPLY_FAILED",
          message: (err as Error)?.message ?? "Unknown error.",
        },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({
    ok: true,
    applied,
    skippedReason: null,
    metadata,
  });
}
