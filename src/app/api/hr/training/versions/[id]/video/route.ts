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
import { logger } from "@/lib/observability/logger";
import {
  isMockInferenceAllowed,
  recordProcessingAuthorization,
} from "@/lib/hr/training/generation/processing-authorization";
import { advancePreparation } from "@/lib/hr/training/preparation-orchestrator";
import {
  markVersionNonBillable,
  resolveTestScope,
  type TestScope,
} from "@/lib/hr/training/generation/test-execution-identity";

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

  // EP-TRAIN-4Y-BF — test execution identity. Whether an upload is a
  // test is decided by WHO is authenticated (a principal the server
  // recognises as a test principal), never by a request header. A test
  // principal's upload is always non-billable; everyone else's is a
  // real upload. Every mismatch is refused BEFORE anything is stored:
  //   - a test principal reaching for a real manager's course (it
  //     would leave that course permanently simulated-only);
  //   - a real account uploading into a test course (it would be
  //     answered with simulated content);
  //   - a test principal where simulated processing is not allowed;
  //   - test controls sent by anyone who is not a test principal.
  let scope: TestScope;
  try {
    scope = await resolveTestScope(principal, { clubId, courseVersionId: params.id });
  } catch {
    // Could not establish whose course this is: store nothing.
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
  if (scope === "TEST_PRINCIPAL_ON_REAL_COURSE") {
    return NextResponse.json(
      { error: "Test accounts can only upload to courses they created." },
      { status: 409 },
    );
  }
  if (scope === "REAL_PRINCIPAL_ON_TEST_COURSE") {
    return NextResponse.json(
      {
        error:
          "This course was created by automated testing and cannot take a real upload. Please create a new course.",
      },
      { status: 409 },
    );
  }
  const TEST_CONTROL_HEADERS = [
    "x-spectre-training-inference",
    "x-spectre-training-hold",
    "x-spectre-training-mock-delay-ms",
    "x-spectre-training-mock-fault",
  ] as const;
  const testExecution = scope === "TEST";
  const sentTestControl = TEST_CONTROL_HEADERS.some((h) => req.headers.get(h) !== null);
  if (testExecution && !isMockInferenceAllowed()) {
    return NextResponse.json(
      { error: "Test accounts cannot upload in this environment." },
      { status: 409 },
    );
  }
  if (!testExecution && sentTestControl) {
    return NextResponse.json(
      { error: "Test controls are only available to test accounts." },
      { status: 409 },
    );
  }
  // The controls below only tune a simulated run (pace, one injected
  // fault, hold). None of them can select real processing.
  const holdRequested = testExecution && req.headers.get("x-spectre-training-hold") === "1";
  const mockDelayMs = testExecution
    ? Number(req.headers.get("x-spectre-training-mock-delay-ms") ?? "0") || 0
    : 0;
  const requestedFault = testExecution ? req.headers.get("x-spectre-training-mock-fault") : null;
  const mockFault =
    requestedFault === "drop-first-checkpoint"
      ? ("DROP_FIRST_CHECKPOINT" as const)
      : requestedFault === "formatting-defects"
        ? ("FORMATTING_DEFECTS" as const)
        : ("NONE" as const);

  try {
    if (testExecution) {
      // Durable, written first: from this point the version can never
      // reach a billable provider, whatever happens to this request.
      await markVersionNonBillable(principal, {
        clubId,
        courseVersionId: params.id,
        reason: "video uploaded by a test principal",
      });
    }
    const buf = Buffer.from(await entry.arrayBuffer());
    const result = await uploadTrainingVideo(principal, params.id, {
      bytes: buf,
      mimeType,
      displayName: entry.name || null,
      durationSec,
    });

    // A successful upload authorizes Spectre to prepare the whole course
    // and starts it, server-side, right now. Every later stage is
    // triggered by the one before it; nothing else is asked of the
    // manager. A failure here never fails the upload — the worker
    // watchdog picks the course up on its next pass.
    // (holdRequested: staging test control that leaves a course exactly
    // as an upload from before automatic preparation would be.)
    let preparation: { action: string } | null = null;
    if (!holdRequested) {
      try {
        await recordProcessingAuthorization(principal, {
          clubId,
          courseVersionId: params.id,
          operation: "GENERATE_FULL",
          source: "UPLOAD",
          inferenceMode: testExecution ? "MOCK" : "LIVE",
          mockDelayMs,
          mockFault,
        });
        const advanced = await advancePreparation({
          clubId,
          courseVersionId: params.id,
          trigger: "UPLOAD",
        });
        preparation = { action: advanced.action };
      } catch (err) {
        logger.error("training.video.upload.preparation_start_failed", {
          clubId,
          courseVersionId: params.id,
          error: (err as Error)?.message ?? String(err),
        });
      }
    }

    return NextResponse.json(
      { ok: true, sizeBytes: result.sizeBytes, sha256: result.sha256, preparation },
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
