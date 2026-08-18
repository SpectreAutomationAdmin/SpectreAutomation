// HR-2B.2 final (2026-08-19) — Employee profile-photo streamer.
// HR-2B.3.1 (2026-08-18) §2 — admin add/replace + delete.
//
// GET  /api/hr/employees/[id]/profile-photo
//   Streams the raw bytes of the employee's currently-selected profile
//   photo with `Content-Disposition: inline`. Used as the `<img src>`
//   in the Club-side Employee Profile so the canonical
//   `profilePhotoDocumentId` pointer produces a rendered image without
//   leaking storage keys.
//
// POST /api/hr/employees/[id]/profile-photo
//   Admin uploads or REPLACES the employee's profile photo. Delegates
//   to canonical HR services (`uploadEmployeeDocument` +
//   `setProfilePhoto`) so RBAC + audit + tenant discipline all fire
//   from the same well-worn code paths the employee-onboarding
//   `uploadSelfPhoto` uses. Response never returns bytes.
//
// DELETE /api/hr/employees/[id]/profile-photo
//   Clears the `Employee.profilePhotoDocumentId` pointer via
//   `setProfilePhoto(principal, id, null)`. Does NOT hard-delete the
//   document row — evidentiary trail is preserved.
//
// Authorization:
//   • GET  — `hr:documents:read`.
//   • POST — `hr:employee:write` (matches the pointer-write semantics
//            of `setProfilePhoto`; the canonical services enforce it
//            again in-depth).
//   • DELETE — same as POST.
//   • Document category MUST be `profile_photo` on GET (defence in
//     depth against a compromised pointer write path).

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { resolveDocumentStorage } from "@/lib/documents/storage";
import { uploadEmployeeDocument } from "@/lib/hr/documents";
import { setProfilePhoto } from "@/lib/hr/employees";
import { isAppError, ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MiB
const ACCEPTED_PHOTO_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
]);

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const employee = await prisma.employee.findUnique({
    where: { id: params.id },
    select: { id: true, clubId: true, profilePhotoDocumentId: true },
  });
  if (!employee) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!hasPermission(principal, employee.clubId, "hr:documents:read")) {
    // Same-shape response as not_found so a caller lacking the
    // capability cannot enumerate employee ids by response code.
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!employee.profilePhotoDocumentId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const doc = await prisma.employeeDocument.findUnique({
    where: { id: employee.profilePhotoDocumentId },
    select: {
      id: true,
      clubId: true,
      employeeId: true,
      category: true,
      mimeType: true,
      storageKey: true,
      sizeBytes: true,
    },
  });
  if (
    !doc ||
    doc.clubId !== employee.clubId ||
    doc.employeeId !== employee.id ||
    doc.category !== "profile_photo"
  ) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const storage = await resolveDocumentStorage({ clubId: doc.clubId });
    const bytes = await storage.get({ storageKey: doc.storageKey });
    if (!bytes) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": doc.mimeType,
        "Content-Length": String(bytes.length),
        "Content-Disposition": "inline",
        // Short cache with revalidate so photo replacement propagates
        // to already-open Club-side profile pages within a session.
        "Cache-Control": "private, max-age=30, must-revalidate",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "storage_unavailable" }, { status: 502 });
  }
}

/**
 * Admin add / replace employee profile photo.
 *
 * Multipart body: single `photo` file. Rejected pre-upload if the
 * MIME isn't on the allowlist or the file exceeds 10 MiB. On success
 * a new EmployeeDocument row (category=profile_photo) is created via
 * `uploadEmployeeDocument`, and `Employee.profilePhotoDocumentId` is
 * repointed via `setProfilePhoto` — same discipline the employee-
 * onboarding `uploadSelfPhoto` uses, just with an admin Principal as
 * the actor. A previous photo document is NOT hard-deleted; only the
 * pointer is repointed so the audit trail is preserved.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const employee = await prisma.employee.findUnique({
    where: { id: params.id },
    select: { id: true, clubId: true },
  });
  if (!employee) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Cross-tenant enumeration guard — same 404 shape as "no such
  // employee" so a caller in a foreign club cannot probe.
  if (!hasPermission(principal, employee.clubId, "hr:employee:write")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data body" }, { status: 400 });
  }
  const entry = fd.get("photo");
  if (!(entry instanceof File)) {
    return NextResponse.json({ error: "photo field is required" }, { status: 422 });
  }
  if (entry.size === 0) {
    return NextResponse.json({ error: "photo file is empty" }, { status: 422 });
  }
  if (entry.size > MAX_PHOTO_BYTES) {
    return NextResponse.json(
      { error: `Photo exceeds ${MAX_PHOTO_BYTES / (1024 * 1024)} MiB limit.` },
      { status: 413 },
    );
  }
  const mimeType = (entry.type || "").toLowerCase();
  if (!ACCEPTED_PHOTO_MIME.has(mimeType)) {
    return NextResponse.json(
      { error: "Photo must be a JPEG, PNG, HEIC, HEIF, or WEBP image." },
      { status: 422 },
    );
  }

  const buf = Buffer.from(await entry.arrayBuffer());
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const storageKey = `hr/employees/${employee.id}/profile_photo/${sha256}`;

  try {
    const storage = await resolveDocumentStorage({ clubId: employee.clubId });
    await storage.put({ storageKey, body: buf, mimeType });
    const doc = await uploadEmployeeDocument(principal, employee.id, {
      category: "profile_photo",
      storageKey,
      contentSha256: sha256,
      sizeBytes: buf.length,
      mimeType,
      displayName: entry.name || null,
      // profile_photo is NOT in EMPLOYEE_DOCUMENT_SENSITIVE_CATEGORIES,
      // so this passes through and the service stamps STANDARD.
      sensitivity: "STANDARD",
    });
    await setProfilePhoto(principal, employee.id, doc.id);
    return NextResponse.json(
      { documentId: doc.id, uploadedAt: doc.uploadedAt.toISOString() },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json(
        { error: err.safeMessage, issues: err.issues },
        { status: err.httpStatus },
      );
    }
    if (isAppError(err)) {
      return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

/**
 * Clear the `Employee.profilePhotoDocumentId` pointer. The document
 * row is preserved (never hard-deleted here) so the audit trail
 * survives. Same authz as POST — `hr:employee:write` at the
 * employee's club.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const employee = await prisma.employee.findUnique({
    where: { id: params.id },
    select: { id: true, clubId: true, profilePhotoDocumentId: true },
  });
  if (!employee) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!hasPermission(principal, employee.clubId, "hr:employee:write")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!employee.profilePhotoDocumentId) {
    // Already cleared. Idempotent success.
    return NextResponse.json({ ok: true }, { status: 200 });
  }
  try {
    await setProfilePhoto(principal, employee.id, null);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
