// WI-1D (2026-09-27) — Club Work-Intake hero image streamer + admin upload.
//
// Structural clone of the accepted employee-portal-hero route
// (src/app/api/clubs/[id]/employee-portal-hero/route.ts). Same auth,
// same validators, same ClubMedia service. The only difference is the
// CATEGORY constant.
//
// GET  /api/clubs/[id]/work-intake-hero
//   Streams the raw bytes of the Club's Work-Intake hero image with
//   `Content-Disposition: inline`. Rendered by the Work Intake page
//   at /app/admin/work-intake. Returns 404 (same shape) when unset
//   or when the caller lacks access — no enumeration signal.
//
// POST /api/clubs/[id]/work-intake-hero
//   Admin uploads or REPLACES the Club's Work Intake hero image.
//   Delegates to setClubMedia(...). Requires settings:write.
//
// DELETE /api/clubs/[id]/work-intake-hero
//   Clears the row. Surface reverts to the default Spectre clubhouse
//   fallback immediately.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  setClubMedia,
  clearClubMedia,
  readClubMediaBytes,
  CLUB_MEDIA_ACCEPTED_IMAGE_MIME,
  CLUB_MEDIA_MAX_BYTES,
} from "@/lib/club/media";
import { isAppError, ValidationError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORY = "work_intake_hero" as const;
const NOT_FOUND = () => NextResponse.json({ error: "not_found" }, { status: 404 });

async function callerHasClubRead(clubId: string): Promise<boolean> {
  const admin = await getCurrentPrincipal();
  if (admin && hasPermission(admin, clubId, "settings:read")) return true;
  return false;
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  if (!clubId) return NOT_FOUND();
  if (!(await callerHasClubRead(clubId))) return NOT_FOUND();
  const asset = await readClubMediaBytes(clubId, CATEGORY);
  if (!asset) return NOT_FOUND();
  return new NextResponse(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Length": String(asset.bytes.length),
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=60, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  if (!clubId) return NOT_FOUND();
  const principal = await getCurrentPrincipal();
  if (!principal) return NOT_FOUND();
  if (!hasPermission(principal, clubId, "settings:write")) return NOT_FOUND();

  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data body" }, { status: 400 });
  }
  const entry = fd.get("image");
  if (!(entry instanceof File)) {
    return NextResponse.json({ error: "image field is required" }, { status: 422 });
  }
  if (entry.size === 0) {
    return NextResponse.json({ error: "image file is empty" }, { status: 422 });
  }
  if (entry.size > CLUB_MEDIA_MAX_BYTES) {
    return NextResponse.json(
      { error: `Image exceeds ${Math.round(CLUB_MEDIA_MAX_BYTES / (1024 * 1024))} MiB limit.` },
      { status: 413 },
    );
  }
  const mimeType = (entry.type || "").toLowerCase();
  if (!CLUB_MEDIA_ACCEPTED_IMAGE_MIME.has(mimeType)) {
    return NextResponse.json(
      { error: "Image must be a JPEG, PNG, WEBP, HEIC, or HEIF." },
      { status: 422 },
    );
  }

  try {
    const buf = Buffer.from(await entry.arrayBuffer());
    const result = await setClubMedia(principal, clubId, {
      category: CATEGORY,
      bytes: buf,
      mimeType,
      displayName: entry.name || null,
    });
    return NextResponse.json(
      { id: result.id, uploadedAt: result.uploadedAt.toISOString() },
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

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  if (!clubId) return NOT_FOUND();
  const principal = await getCurrentPrincipal();
  if (!principal) return NOT_FOUND();
  if (!hasPermission(principal, clubId, "settings:write")) return NOT_FOUND();
  try {
    const result = await clearClubMedia(principal, clubId, CATEGORY);
    return NextResponse.json({ ok: true, cleared: result.cleared }, { status: 200 });
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
