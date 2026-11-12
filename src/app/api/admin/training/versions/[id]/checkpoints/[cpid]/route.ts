// EP-TRAIN-4Y-AX §2 (2026-11-11) — DELETE a checkpoint on a DRAFT
// version. Thin wrapper over the existing `deleteCheckpoint` service.
// Ships to support the Playwright acceptance flow's authorised
// cleanup path — the service already enforces DRAFT-only, tenant
// scope, `hr:training:write`, and refuses to delete a checkpoint
// with questions still bound to it.
//
// Response: 200 { ok: true } on success; 404 (same-shape) on cross-
// tenant / missing / forbidden; 409 on non-DRAFT / non-empty.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { deleteCheckpoint } from "@/lib/hr/training/checkpoints";
import {
  AppError,
  ValidationError,
  ConflictError,
  NotFoundError,
} from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

function appErrorToResponse(err: AppError): NextResponse {
  if (err instanceof ValidationError) {
    return NextResponse.json(
      { error: "validation_failed", issues: err.issues, message: err.safeMessage },
      { status: 422 },
    );
  }
  if (err instanceof ConflictError) {
    return NextResponse.json({ error: "conflict", message: err.safeMessage }, { status: 409 });
  }
  if (err instanceof NotFoundError) return same404();
  return NextResponse.json(
    { error: "app_error", message: err.safeMessage },
    { status: 400 },
  );
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string; cpid: string }> },
): Promise<NextResponse> {
  const { id: versionId, cpid: checkpointId } = await context.params;
  if (!versionId || !checkpointId) return same404();

  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    return same404();
  }

  // Tenant ownership: the checkpoint must belong to a course owned by
  // this club AND to the version path parameter. Mismatch → 404.
  const cp = await prisma.trainingCheckpoint.findFirst({
    where: {
      id: checkpointId,
      courseVersionId: versionId,
      courseVersion: { course: { clubId } },
    },
    select: { id: true },
  });
  if (!cp) return same404();

  // The service's default behaviour refuses to delete a checkpoint
  // that still has active questions bound to it — exactly the shape
  // the AX authorised-cleanup flow needs: the manager deletes the
  // disposable question first, then the empty checkpoint.
  try {
    await deleteCheckpoint(principal, checkpointId);
    return NextResponse.json({ ok: true, checkpointId });
  } catch (err) {
    if (err instanceof AppError) return appErrorToResponse(err);
    throw err;
  }
}
