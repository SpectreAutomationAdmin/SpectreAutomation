// EP-TRAIN-4Y-BE — POST /api/admin/training/versions/[id]/continue-preparation
//
// The single endpoint behind the "Continue preparation" button. It
// works out which stage is stalled, resumes from the last completed
// stage, and ALWAYS answers with a sentence the manager can read:
//
//   200 { action, message }                       — resumed / already running / done
//   200 { action: "CONFIRMATION_REQUIRED", ... }  — new GPU spend needs a yes
//   409 { action: "REJECTED", message }           — cannot proceed, with the reason
//
// Spend rule: an upload authorizes the normal pipeline for two hours.
// Inside that window a stalled stage resumes immediately. Outside it
// (or for a shortfall top-up) the estimated cost is shown first and
// nothing is enqueued until the manager confirms.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { computePreparationProgress } from "@/lib/hr/training/preparation-progress";
import { advancePreparation } from "@/lib/hr/training/preparation-orchestrator";
import {
  hasFreshProcessingAuthorization,
  recordProcessingAuthorization,
} from "@/lib/hr/training/generation/processing-authorization";
import { sizeForDuration } from "@/lib/hr/training/generation/duration-sizing";
import {
  COLD_BOOT_WORST_CASE_MS,
  PER_CALL_WORST_CASE_MS,
  getPilotBudgetMicros,
  msToCostMicros,
} from "@/lib/hr/training/generation/pilot-budget-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPICAL_CALL_MS = 30_000;
const TYPICAL_TRANSCRIBE_MS = 90_000;

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function estimateSpend(input: {
  readonly checkpointCount: number;
  readonly finalCount: number;
  readonly includesTranscription: boolean;
  readonly includesMetadata: boolean;
}) {
  const calls =
    (input.includesMetadata ? 1 : 0) + input.checkpointCount + Math.ceil(input.finalCount / 3);
  const transcribeMs = input.includesTranscription ? TYPICAL_TRANSCRIBE_MS : 0;
  const typicalMicros = msToCostMicros(calls * TYPICAL_CALL_MS + COLD_BOOT_WORST_CASE_MS + transcribeMs);
  const maximumMicros = msToCostMicros(
    calls * PER_CALL_WORST_CASE_MS + COLD_BOOT_WORST_CASE_MS + (input.includesTranscription ? PER_CALL_WORST_CASE_MS : 0),
  );
  return { calls, typicalMicros, maximumMicros };
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: versionId } = await context.params;
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json(
      { action: "REJECTED", message: "Your session has expired. Sign in again to continue." },
      { status: 401 },
    );
  }
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    return NextResponse.json(
      { action: "REJECTED", message: "You do not have permission to prepare training courses." },
      { status: 404 },
    );
  }
  const body = (await req.json().catch(() => ({}))) as { confirmSpend?: unknown };
  const confirmSpend = body.confirmSpend === true;

  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: versionId, course: { clubId } },
    select: { id: true, videoDurationSec: true },
  });
  const progress = version
    ? await computePreparationProgress({ clubId, versionId }, prisma)
    : null;
  if (!version || !progress) {
    return NextResponse.json(
      { action: "REJECTED", message: "This course version was not found." },
      { status: 404 },
    );
  }

  const respond = (
    status: number,
    payload: { action: string; message: string } & Record<string, unknown>,
  ) => {
    void audit(principal, {
      action: "hr.training.preparation.continue",
      entityType: "TrainingCourseVersion",
      entityId: versionId,
      clubId,
      after: { action: payload.action, confirmSpend, httpStatus: status },
    });
    return NextResponse.json(payload, { status });
  };

  const outcome = progress.overall.outcome;
  if (outcome === "READY_FOR_REVIEW") {
    return respond(200, {
      action: "ALREADY_READY",
      message: "This course is already prepared and ready for review.",
    });
  }

  const budgetMicros = getPilotBudgetMicros(versionId);
  const sized = sizeForDuration(version.videoDurationSec);

  // Shortfall top-up: always additional spend, always confirmed.
  if (outcome === "PARTIALLY_GENERATED") {
    const shortfall = progress.overall.generationShortfall;
    const missingCp = shortfall ? Math.max(0, shortfall.checkpointPlanned - shortfall.checkpointProduced) : 0;
    const missingFa = shortfall ? Math.max(0, shortfall.finalPlanned - shortfall.finalProduced) : 0;
    if (!confirmSpend) {
      const est = estimateSpend({
        checkpointCount: missingCp,
        finalCount: missingFa,
        includesTranscription: false,
        includesMetadata: false,
      });
      return respond(200, {
        action: "CONFIRMATION_REQUIRED",
        message:
          `Spectre will write the ${missingCp} missing checkpoint question(s) and ${missingFa} missing ` +
          `final-assessment question(s). Existing questions are kept as they are.`,
        estimate: {
          typical: usd(est.typicalMicros),
          maximum: usd(est.maximumMicros),
          courseCap: usd(budgetMicros),
        },
      });
    }
    await recordProcessingAuthorization(principal, {
      clubId,
      courseVersionId: versionId,
      operation: "GENERATE_RECOVERY",
      source: "MANAGER_CONTINUE",
    });
    return respond(200, {
      action: "RECOVERY_AUTHORIZED",
      message: "Confirmed. Writing the missing questions now.",
    });
  }

  // PREPARING / BLOCKED / FAILED — find out what the next step is.
  const plan = await advancePreparation(principal, {
    clubId,
    courseVersionId: versionId,
    trigger: "MANAGER_CONTINUE",
    dryRun: true,
  });
  const needsEnqueue =
    plan.action === "WOULD_ENQUEUE_TRANSCRIPTION" || plan.action === "WOULD_ENQUEUE_GENERATION";
  if (!needsEnqueue) {
    const rejected = plan.action === "NO_VIDEO" || plan.action === "NOT_DRAFT" || plan.action === "NOT_FOUND";
    return respond(rejected ? 409 : 200, { action: rejected ? "REJECTED" : plan.action, message: plan.message });
  }

  const authorized = await hasFreshProcessingAuthorization({
    clubId,
    courseVersionId: versionId,
    operation: "GENERATE_FULL",
  });
  if (!authorized && !confirmSpend) {
    const est = estimateSpend({
      checkpointCount: sized.checkpointCount,
      finalCount: sized.finalCount,
      includesTranscription: plan.action === "WOULD_ENQUEUE_TRANSCRIPTION",
      includesMetadata: true,
    });
    return respond(200, {
      action: "CONFIRMATION_REQUIRED",
      message:
        `${plan.message} This course was uploaded before automatic preparation was authorized, ` +
        `so Spectre needs your confirmation before using AI processing. Target: ` +
        `${sized.checkpointCount} knowledge checkpoints and ${sized.finalCount} final-assessment questions.`,
      estimate: {
        typical: usd(est.typicalMicros),
        maximum: usd(est.maximumMicros),
        courseCap: usd(budgetMicros),
      },
    });
  }
  if (!authorized) {
    await recordProcessingAuthorization(principal, {
      clubId,
      courseVersionId: versionId,
      operation: "GENERATE_FULL",
      source: "MANAGER_CONTINUE",
    });
  }

  const result = await advancePreparation(principal, {
    clubId,
    courseVersionId: versionId,
    trigger: "MANAGER_CONTINUE",
  });
  const failed = result.action === "REJECTED" || result.action === "NOT_AUTHORIZED";
  return respond(failed ? 409 : 200, {
    action: failed ? "REJECTED" : result.action,
    message: result.message,
    rejectionCode: result.rejectionCode ?? null,
  });
}
