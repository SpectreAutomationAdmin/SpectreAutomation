// EP-TRAIN-4Y-AY §3 — GET /api/admin/training/versions/[id]/preparation-status
//
// Unified seven-stage preparation telemetry. Reads durable DB state
// only — no writes, no Modal calls, no GPU invocations.
//
// Permission: existing hr:training:read.
// Cross-tenant version ids map to a same-shape 404.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computePreparationProgress } from "@/lib/hr/training/preparation-progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: versionId } = await context.params;
  if (!versionId) return same404();

  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:read")) {
    return same404();
  }

  const progress = await computePreparationProgress(
    { clubId, versionId },
    prisma,
  );
  if (!progress) return same404();

  return NextResponse.json(progress);
}
