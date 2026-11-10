// EP-TRAIN-4Y-X §3 (2026-11-09) — read course metadata + attribution.
// EP-TRAIN-4Y-AA §2 (2026-11-09) — PATCH to persist manager edits to
// the COURSE-LEVEL title / description.
//
// The GET side returns the current title, description, code, and the
// full AI attribution record (At, RunId, Source, AttributedTitle).
// Used by Batch B pre-flight and by the Manager Review surface.
//
// The PATCH side writes manager edits to `TrainingCourse` directly so
// that subsequent re-reads (course list, review page, preview-as-
// employee) all see the manager's text — not the Qwen-written
// snapshot. The Qwen writer's `isProvisional` guard in
// worker-handler.ts already uses `aiMetadataAttributedTitle` as the
// baseline: any manager edit that changes `course.title` makes
// `titleMatchesAttributedSnapshot === false`, so future metadata
// runs skip and the manager's content is protected from silent
// overwrite (directive §2).
//
// Permission: hr:training:read on GET, hr:training:write on PATCH.
// Tenant-scoped. Audited.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COURSE_ENTITY = "TrainingCourse";
const TITLE_MIN = 3;
const TITLE_MAX = 200;
const DESC_MAX = 2000;

function same404() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}
function unauthenticated() {
  return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
}
function badRequest(code: string, message?: string) {
  return NextResponse.json(
    { error: code, ...(message ? { message } : {}) },
    { status: 400 },
  );
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ courseId: string }> },
): Promise<NextResponse> {
  const { courseId } = await context.params;
  if (!courseId) return same404();
  const principal = await getCurrentPrincipal();
  if (!principal) return unauthenticated();
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

export async function PATCH(
  req: Request,
  context: { params: Promise<{ courseId: string }> },
): Promise<NextResponse> {
  const { courseId } = await context.params;
  if (!courseId) return same404();
  const principal = await getCurrentPrincipal();
  if (!principal) return unauthenticated();
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    return same404();
  }

  // Accept JSON or multipart form (the client sends FormData from
  // blur-save). Reject empty / malformed early.
  let title: string | undefined;
  let description: string | null | undefined;
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (ct.includes("application/json")) {
      const body = (await req.json()) as {
        title?: unknown;
        description?: unknown;
      };
      if (body.title !== undefined) {
        if (typeof body.title !== "string") return badRequest("invalid_title");
        title = body.title;
      }
      if (body.description !== undefined) {
        if (body.description === null) description = null;
        else if (typeof body.description === "string") description = body.description;
        else return badRequest("invalid_description");
      }
    } else {
      const form = await req.formData();
      const t = form.get("title");
      if (typeof t === "string") title = t;
      const d = form.get("description");
      if (typeof d === "string") description = d || null;
    }
  } catch {
    return badRequest("invalid_body");
  }

  // Normalise + validate.
  if (title !== undefined) {
    title = title.trim();
    if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
      return badRequest("invalid_title", `Title must be ${TITLE_MIN}-${TITLE_MAX} characters.`);
    }
  }
  if (description !== undefined && description !== null) {
    description = description.trim();
    if (description.length > DESC_MAX) {
      return badRequest("invalid_description", `Description must be at most ${DESC_MAX} characters.`);
    }
    // Empty string after trim → null (clear the description).
    if (description.length === 0) description = null;
  }

  if (title === undefined && description === undefined) {
    return badRequest("no_fields");
  }

  // Tenant-scoped existence check — same shape 404 on cross-tenant.
  const course = await prisma.trainingCourse.findFirst({
    where: { id: courseId, clubId },
    select: {
      id: true,
      title: true,
      description: true,
      aiMetadataAttributedTitle: true,
    },
  });
  if (!course) return same404();

  const data: Record<string, unknown> = {};
  if (title !== undefined) data.title = title;
  if (description !== undefined) data.description = description;

  // EP-TRAIN-4Y-AD §6 (2026-11-10) — manager edits must shield the
  // course from subsequent AI/deterministic retries. Set the
  // attribution source to "manager" + refresh the attributed-title
  // snapshot to the NEW title so downstream writers (which use
  // `inferCurrentSource`) classify this course as "manager" and
  // refuse to overwrite.
  const dataWithProvenance: Record<string, unknown> = { ...data };
  if (title !== undefined) {
    dataWithProvenance.aiMetadataAttributedTitle = title;
  }
  dataWithProvenance.aiMetadataAttributionAt = new Date();
  dataWithProvenance.aiMetadataAttributionSource = "manager";

  try {
    await prisma.trainingCourse.update({
      where: { id: courseId },
      data: dataWithProvenance,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "update_failed",
        message: (err as Error)?.message ?? String(err),
      },
      { status: 500 },
    );
  }

  // Audit — the manager edit must be traceable per the project's
  // sensitive-writes rule.
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (title !== undefined) {
    before.title = course.title;
    after.title = title;
  }
  if (description !== undefined) {
    before.description = course.description;
    after.description = description;
  }
  await audit(principal, {
    action: "hr.training.course.metadata.update",
    entityType: COURSE_ENTITY,
    entityId: courseId,
    clubId,
    before,
    after,
  });

  return NextResponse.json({
    ok: true,
    course: { id: courseId },
    managerEditShieldsAttribution:
      title !== undefined && title !== course.aiMetadataAttributedTitle,
  });
}
