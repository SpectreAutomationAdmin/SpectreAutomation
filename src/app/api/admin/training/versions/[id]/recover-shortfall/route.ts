// EP-TRAIN-4Y-BC §3 — POST /api/admin/training/versions/[id]/recover-shortfall
//
// Shortfall-only recovery: computes per-bucket deficits between the
// duration-based target and the actual persisted drafts, then requests
// a generation run sized to EXACTLY the missing counts.
//
// Preservation guarantees (directive §2):
//   - existing TrainingQuestionAiDraft rows are NOT modified
//   - existing TrainingQuestion rows are NOT modified
//   - existing TrainingCheckpoint rows are NOT modified
//   - the four FA drafts on cmwgl11wv002jh25jb8gfzlwi remain
//     byte-identical with their IDs, content hashes, review state
//     and provenance intact
//
// Permission: hr:training:write. Requires a fresh GENERATE_RECOVERY
// authorization (§6) — written by /authorize-recovery.
//
// Idempotency: `requestGeneration`'s planIdentity hash collides on
// repeated calls with the same shortfall shape, so repeated clicks
// return the existing in-flight run instead of creating duplicates.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import {
  buildPlanAndRequestGeneration,
  BuildAndEnqueueRejected,
} from "@/lib/hr/training/generation/enqueue-helper";
import {
  parseShortfallGroupMap,
  destinationKindForGroup,
} from "@/lib/hr/training/generation/destination-resolver";
import { sizeForDuration, clampToBucket } from "@/lib/hr/training/generation/duration-sizing";
import { hasFreshProcessingAuthorization } from "@/lib/hr/training/generation/processing-authorization";
import { AppError, UnauthenticatedError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

const PRODUCED_STATES = new Set([
  "REQUIRES_HUMAN_REVIEW",
  "APPROVED_DRAFT",
  "PROMOTED",
  "EDITED_VALIDATION_STALE",
  "VALIDATION_PENDING",
]);

export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: versionId } = await context.params;
  if (!versionId) return same404();
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:write")) return same404();

  // Fresh GENERATE_RECOVERY (or GENERATE_FULL) authorization required.
  const authorized = await hasFreshProcessingAuthorization({
    clubId,
    courseVersionId: versionId,
    operation: "GENERATE_RECOVERY",
  });
  if (!authorized) {
    return NextResponse.json(
      {
        error: "authorization_required",
        message:
          "Call /authorize-recovery first with an explicit manager action. Legacy " +
          "browser polling cannot authorize GPU inference.",
      },
      { status: 403 },
    );
  }

  // Tenant-scoped version lookup + duration.
  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: versionId, course: { clubId } },
    select: {
      id: true, state: true, videoSha256: true, videoDurationSec: true,
    },
  });
  if (!version) return same404();
  if (version.state !== "DRAFT") {
    return NextResponse.json({ error: "version_not_draft" }, { status: 409 });
  }
  if (!version.videoSha256) {
    return NextResponse.json({ error: "video_missing" }, { status: 409 });
  }

  // Count existing drafts per destination. Uses the destination
  // resolver (contentHash → group via shortfallReasonJson) across
  // every historical run for this course.
  const runs = await prisma.trainingQuestionAiGenerationRun.findMany({
    where: { clubId, courseVersionId: versionId },
    select: { id: true, shortfallReasonJson: true },
  });
  const composedMap = new Map<string, string>();
  for (const r of runs) {
    const m = parseShortfallGroupMap(r.shortfallReasonJson);
    for (const [hash, group] of m.entries()) {
      if (!composedMap.has(hash)) composedMap.set(hash, group);
    }
  }
  const drafts = await prisma.trainingQuestionAiDraft.findMany({
    where: { clubId, courseVersionId: versionId },
    select: { state: true, contentHash: true },
  });
  let producedCp = 0;
  let producedFa = 0;
  for (const d of drafts) {
    if (!PRODUCED_STATES.has(d.state)) continue;
    const kind = destinationKindForGroup(composedMap.get(d.contentHash) ?? null);
    if (kind === "CHECKPOINT") producedCp++;
    else if (kind === "FINAL_ASSESSMENT") producedFa++;
  }

  // Duration-based target (§2 of BB), with max-clamp from the bucket.
  const sized = sizeForDuration(version.videoDurationSec);
  const target = clampToBucket(sized.bucket, {
    checkpointCount: sized.checkpointCount,
    finalCount: sized.finalCount,
  });
  const shortfallCp = Math.max(0, target.checkpointCount - producedCp);
  const shortfallFa = Math.max(0, target.finalCount - producedFa);

  if (shortfallCp === 0 && shortfallFa === 0) {
    return NextResponse.json({
      ok: true,
      outcome: "ALREADY_SATISFIED",
      target, produced: { checkpoint: producedCp, final: producedFa },
    });
  }

  try {
    const result = await buildPlanAndRequestGeneration(principal, {
      clubId,
      courseVersionId: versionId,
      checkpointCount: shortfallCp,
      finalCount: shortfallFa,
    });
    logger.info("training.recover_shortfall.enqueued", {
      clubId, courseVersionId: versionId,
      target, produced: { checkpoint: producedCp, final: producedFa },
      shortfall: { checkpoint: shortfallCp, final: shortfallFa },
      generationRunId: result.generationRunId,
    });
    return NextResponse.json({
      ok: true,
      outcome: "RECOVERY_ENQUEUED",
      generationRunId: result.generationRunId,
      state: result.state,
      idempotent: result.idempotent,
      target,
      produced: { checkpoint: producedCp, final: producedFa },
      shortfall: { checkpoint: shortfallCp, final: shortfallFa },
    });
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    if (err instanceof BuildAndEnqueueRejected) {
      return NextResponse.json(
        { error: "recovery_rejected", rejectionCode: err.rejectionCode, detail: err.detail },
        { status: err.httpStatus },
      );
    }
    if (err instanceof AppError) {
      return NextResponse.json({ error: err.code, message: err.safeMessage }, { status: err.httpStatus });
    }
    throw err;
  }
}
