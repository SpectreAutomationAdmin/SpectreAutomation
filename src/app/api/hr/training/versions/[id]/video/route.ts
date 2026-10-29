// HR-2C B2 (2026-08-20) — Training video upload + stream.
//
// POST: admin uploads a training video for a DRAFT version. Delegates
//       to canonical `uploadTrainingVideo` (permission-gated, audited).
//       Multipart form field: `video`.
// GET:  streams the video bytes back to admin previews AND to
//       employee course pages. Tenant-scoped by looking up the version's
//       clubId and verifying either:
//         - the caller is an admin with `hr:training:read` on that club, OR
//         - the caller is an employee-portal principal in the same club
//           AND the version is applicable to them (via
//           resolveApplicableCourses).
//
// Same-shape 404 for every deny → no cross-tenant enumeration signal.
//
// NOTE (per B1 accepted architecture): media delivery abstraction stays
// clean so future signed R2/CDN or HTTP Range streaming can drop in
// without touching schema or the course/quiz UI. The B1 service +
// this route are the only two places byte delivery is concerned.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import {
  uploadTrainingVideo,
  TRAINING_VIDEO_ACCEPTED_MIME,
  TRAINING_VIDEO_MAX_BYTES,
} from "@/lib/hr/training/video";
import { streamTrainingVideo } from "@/lib/hr/training/video-stream";
import { resolveApplicableCourses } from "@/lib/hr/training/applicability";
import { prisma } from "@/lib/prisma";
import { isAppError, ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = () => NextResponse.json({ error: "not_found" }, { status: 404 });

async function callerCanReadVersion(versionId: string): Promise<{ ok: boolean; clubId: string | null }> {
  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true, state: true,
      course: { select: { clubId: true, retiredAt: true } },
    },
  });
  if (!version) return { ok: false, clubId: null };
  const clubId = version.course.clubId;

  // Admin path — hr:training:read on the version's club.
  const admin = await getCurrentPrincipal();
  if (admin && hasPermission(admin, clubId, "hr:training:read")) return { ok: true, clubId };

  // Employee-portal path — same club AND version is applicable AND
  // published (retired courses stop delivering media to employees).
  const portal = await getEmployeePortalPrincipal();
  if (portal && portal.clubId === clubId && version.state === "PUBLISHED" && !version.course.retiredAt) {
    const applicable = await resolveApplicableCourses(portal.employeeId);
    if (applicable.some((a) => a.version.id === versionId)) return { ok: true, clubId };
  }
  return { ok: false, clubId: null };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  // EP-TRAIN-1 §B (2026-10-29) -- streaming + HTTP Range delivery.
  // Replaces the earlier full-buffer path.  Byte 0 of the response
  // ships as soon as R2 streams it; the browser can seek, resume,
  // and Safari can play natively because `Accept-Ranges: bytes`
  // + `206 Partial Content` are now honoured.
  const versionId = params.id;
  const { ok, clubId } = await callerCanReadVersion(versionId);
  if (!ok || !clubId) return NOT_FOUND();

  const rangeHeader = req.headers.get("range");
  const result = await streamTrainingVideo({ clubId, versionId, rangeHeader });
  if (!result) return NOT_FOUND();

  const headers: Record<string, string> = {
    "Content-Type": result.contentType,
    "Content-Length": String(result.contentLength),
    "Content-Disposition": "inline",
    // Private + short TTL preserves the prior semantics: a replaced
    // video propagates within a session.  The strong etag below lets
    // the browser skip a re-download when the body hasn't changed.
    "Cache-Control": "private, max-age=60, must-revalidate",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  };
  if (result.sha256) headers["ETag"] = `"${result.sha256}"`;
  if (result.contentRange) headers["Content-Range"] = result.contentRange;

  // Prefer the ReadableStream path (R2) so bytes flow without the
  // Node process buffering the entire body in memory.  The in-memory
  // adapter fallback returns a Buffer; wrap it so the Response
  // interface is uniform.
  if (result.bodyStream) {
    return new NextResponse(result.bodyStream, { status: result.status, headers });
  }
  if (result.bodyBuffer) {
    return new NextResponse(new Uint8Array(result.bodyBuffer), { status: result.status, headers });
  }
  return NOT_FOUND();
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NOT_FOUND();
  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: params.id },
    select: { id: true, course: { select: { clubId: true } } },
  });
  if (!version) return NOT_FOUND();
  const clubId = version.course.clubId;
  if (!hasPermission(principal, clubId, "hr:training:write")) return NOT_FOUND();

  let fd: FormData;
  try { fd = await req.formData(); }
  catch { return NextResponse.json({ error: "Expected multipart/form-data body" }, { status: 400 }); }
  const entry = fd.get("video");
  if (!(entry instanceof File)) {
    return NextResponse.json({ error: "video field is required" }, { status: 422 });
  }
  if (entry.size === 0) {
    return NextResponse.json({ error: "video file is empty" }, { status: 422 });
  }
  if (entry.size > TRAINING_VIDEO_MAX_BYTES) {
    return NextResponse.json(
      { error: `Video exceeds ${Math.round(TRAINING_VIDEO_MAX_BYTES / (1024 * 1024))} MiB limit.` },
      { status: 413 },
    );
  }
  const mimeType = (entry.type || "").toLowerCase();
  if (!TRAINING_VIDEO_ACCEPTED_MIME.has(mimeType)) {
    return NextResponse.json(
      { error: `Video must be one of ${[...TRAINING_VIDEO_ACCEPTED_MIME].join(", ")}.` },
      { status: 422 },
    );
  }
  // Optional client-supplied duration (from <video>.duration probe).
  const durationRaw = fd.get("durationSec");
  const durationSec = typeof durationRaw === "string" && durationRaw.length > 0 ? Number(durationRaw) : null;

  try {
    const buf = Buffer.from(await entry.arrayBuffer());
    const result = await uploadTrainingVideo(principal, params.id, {
      bytes: buf,
      mimeType,
      displayName: entry.name || null,
      durationSec,
    });
    return NextResponse.json(
      { ok: true, sizeBytes: result.sizeBytes, sha256: result.sha256 },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.safeMessage, issues: err.issues }, { status: err.httpStatus });
    }
    if (isAppError(err)) {
      return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
