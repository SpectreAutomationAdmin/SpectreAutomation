// POST /api/admin/ai-training/versions/[versionId]/checkpoint-events
//
// Saves the checkpoints that AI-drafted checkpoint questions need before
// they can be added to the course, for a draft version where they are
// missing: one prepared before checkpoints were saved automatically, or
// one whose checkpoint was removed afterwards. Idempotent.
//
// 200 { ok: true, created, existing, checkpoints: [{ id, atSecond }] }
// 401 unauthenticated · 404 not found, cross-tenant or no hr:training:write
// 409 version is not a draft · 403 writes are currently blocked

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import {
  withPostingGuard,
  SupportReadOnlyError,
  TrainingModeBlockedError,
} from "@/lib/posting-guard";
import { AppError } from "@/lib/errors";
import { ensureCheckpointEventsForVersion } from "@/lib/hr/training/generation/checkpoint-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function POST(
  _req: Request,
  context: { params: Promise<{ versionId: string }> },
): Promise<NextResponse> {
  const { versionId } = await context.params;
  if (!versionId || typeof versionId !== "string") return same404();

  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:write")) return same404();

  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: versionId, course: { clubId } },
    select: { id: true, state: true },
  });
  if (!version) return same404();
  if (version.state !== "DRAFT") {
    return NextResponse.json(
      {
        error: "conflict",
        message: "This course version is no longer a draft, so its checkpoints cannot be changed.",
      },
      { status: 409 },
    );
  }

  try {
    // Gate only: ensureCheckpointEventsForVersion opens its own transaction.
    await withPostingGuard(
      principal,
      clubId,
      "hr.training.checkpoint.auto_create",
      async () => undefined,
      { entityType: "TrainingCourseVersion", entityId: versionId },
    );
  } catch (err) {
    if (err instanceof TrainingModeBlockedError) {
      return NextResponse.json(
        { error: "training_mode", message: "Changes cannot be saved while the club is in training mode." },
        { status: 403 },
      );
    }
    if (err instanceof SupportReadOnlyError) {
      return NextResponse.json(
        { error: "support_read_only", message: "This support session is read-only, so changes cannot be saved." },
        { status: 403 },
      );
    }
    if (err instanceof AppError) {
      return NextResponse.json(
        { error: err.code, message: err.safeMessage },
        { status: err.httpStatus },
      );
    }
    throw err;
  }

  const result = await ensureCheckpointEventsForVersion({
    clubId,
    courseVersionId: versionId,
    actorUserId: principal.id,
  });
  const checkpoints = await prisma.trainingCheckpoint.findMany({
    where: { courseVersionId: versionId, courseVersion: { course: { clubId } } },
    orderBy: [{ atSecond: "asc" }, { displayOrder: "asc" }],
    select: { id: true, atSecond: true },
  });
  return NextResponse.json({
    ok: true,
    created: result.created,
    existing: result.existing,
    checkpoints,
  });
}
