// EP-TRAIN-4Y-X §3 (2026-11-09) — read course metadata + attribution.
//
// GET /api/admin/training/courses/[courseId]/metadata
//
// Returns the current title, description, code, and the full
// attribution record (At, RunId, Source, AttributedTitle). Used by
// Batch B pre-flight to verify the course still matches 4Y-U
// deterministic-generated metadata before firing the provenance
// repair.
//
// Permission: hr:training:read on the course's active club.
// Tenant-scoped.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ courseId: string }> },
): Promise<NextResponse> {
  const { courseId } = await context.params;
  if (!courseId) return same404();
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

  const course = await prisma.trainingCourse.findFirst({
    where: { id: courseId, clubId },
    select: {
      id: true,
      code: true,
      title: true,
      description: true,
      category: true,
      aiMetadataAttributionAt: true,
      aiMetadataAttributionRunId: true,
      aiMetadataAttributionSource: true,
      aiMetadataAttributedTitle: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!course) return same404();
  return NextResponse.json({
    ok: true,
    course: {
      id: course.id,
      code: course.code,
      title: course.title,
      description: course.description,
      category: course.category,
      createdAt: course.createdAt,
      updatedAt: course.updatedAt,
      attribution: {
        at: course.aiMetadataAttributionAt,
        runId: course.aiMetadataAttributionRunId,
        source: course.aiMetadataAttributionSource,
        attributedTitle: course.aiMetadataAttributedTitle,
      },
    },
  });
}
