// EP-UX-2C §2 (2026-11-01) — training-video thumbnail delivery.
//
// Serves the representative-frame JPEG for a published training
// video, scoped to the same tenant + applicability rules as the
// video stream itself (/api/hr/training/versions/[id]/video).  No
// employee can see another employee's course thumbnail they don't
// have access to.
//
// Returns 404 (no body hint) for every deny — matches the video
// route's cross-tenant discipline.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { resolveApplicableCourses } from "@/lib/hr/training/applicability";
import { resolveDocumentStorage } from "@/lib/documents/storage";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = () => NextResponse.json({ error: "not_found" }, { status: 404 });

async function callerCanReadVersion(versionId: string): Promise<{ ok: boolean; clubId: string | null; thumbnailStorageKey: string | null; thumbnailMimeType: string | null }> {
  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      state: true,
      videoThumbnailStorageKey: true,
      videoThumbnailMimeType: true,
      course: { select: { clubId: true, retiredAt: true } },
    },
  });
  if (!version) return { ok: false, clubId: null, thumbnailStorageKey: null, thumbnailMimeType: null };
  const clubId = version.course.clubId;

  // Admin path — hr:training:read on the version's club.
  const admin = await getCurrentPrincipal();
  if (admin && hasPermission(admin, clubId, "hr:training:read")) {
    return { ok: true, clubId, thumbnailStorageKey: version.videoThumbnailStorageKey, thumbnailMimeType: version.videoThumbnailMimeType };
  }

  // Employee-portal path — same club AND version is applicable AND
  // published AND course not retired.
  const portal = await getEmployeePortalPrincipal();
  if (portal && portal.clubId === clubId && version.state === "PUBLISHED" && !version.course.retiredAt) {
    const applicable = await resolveApplicableCourses(portal.employeeId);
    if (applicable.some((a) => a.version.id === versionId)) {
      return { ok: true, clubId, thumbnailStorageKey: version.videoThumbnailStorageKey, thumbnailMimeType: version.videoThumbnailMimeType };
    }
  }
  return { ok: false, clubId: null, thumbnailStorageKey: null, thumbnailMimeType: null };
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { ok, clubId, thumbnailStorageKey, thumbnailMimeType } = await callerCanReadVersion(params.id);
  if (!ok || !clubId) return NOT_FOUND();
  if (!thumbnailStorageKey) {
    // The version is reachable but no thumbnail has been extracted
    // yet — the UI falls back to the branded placeholder.  Returning
    // 404 (same shape as the "no access" deny) is intentional: the
    // consumer treats both as "no thumbnail, show the placeholder."
    return NOT_FOUND();
  }
  const storage = await resolveDocumentStorage({ clubId });
  const bytes = await storage.get({ storageKey: thumbnailStorageKey });
  if (!bytes) return NOT_FOUND();
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const headers: Record<string, string> = {
    "Content-Type": thumbnailMimeType ?? "image/jpeg",
    "Content-Length": String(buf.length),
    // Short private cache + strong etag by content hash would be ideal;
    // simple private 5-minute cache is enough for this slice (thumbnails
    // change infrequently and are not cross-tenant).
    "Cache-Control": "private, max-age=300",
    "X-Content-Type-Options": "nosniff",
  };
  return new NextResponse(new Uint8Array(buf), { status: 200, headers });
}
