// EP-TRAIN-4Y-BC §6 — POST /api/admin/training/versions/[id]/authorize-recovery
//
// Records a durable `hr.training.generation.authorize` AuditLog row
// scoped to GENERATE_RECOVERY. Called by the manager's explicit
// "Continue preparation" click when the preparation outcome is
// PARTIALLY_GENERATED. Separate from /start-preparation because
// recovery has a different scope (shortfall-only) and a tighter
// cost profile.
//
// Permission: hr:training:write. 403 → 404 same-shape.
// Idempotent: repeated clicks just write additional audit rows (each
// one extends the TTL).

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordProcessingAuthorization } from "@/lib/hr/training/generation/processing-authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function POST(
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
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    return same404();
  }
  // Tenant-scoped version existence check (same-shape 404 on cross-tenant).
  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: versionId, course: { clubId } },
    select: { id: true },
  });
  if (!version) return same404();

  await recordProcessingAuthorization(principal, {
    clubId,
    courseVersionId: versionId,
    operation: "GENERATE_RECOVERY",
  });

  return NextResponse.json({ ok: true, operation: "GENERATE_RECOVERY" }, { status: 200 });
}
