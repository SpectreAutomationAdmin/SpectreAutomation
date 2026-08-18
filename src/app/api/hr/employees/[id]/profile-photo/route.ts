// HR-2B.2 final (2026-08-19) — Employee profile-photo streamer.
//
// GET /api/hr/employees/[id]/profile-photo
//
// Streams the raw bytes of the employee's currently-selected profile
// photo with `Content-Disposition: inline`. Used as the `<img src>` in
// the Club-side Employee Profile so the canonical `profilePhotoDocumentId`
// pointer produces a rendered image without leaking storage keys.
//
// Authorization:
//   • Admin principal required (getCurrentPrincipal → 401 if absent).
//   • Principal must have `hr:documents:read` at the employee's clubId.
//   • Document must be category=profile_photo (defence-in-depth against
//     `?id` swapping to another document type via a compromised
//     `profilePhotoDocumentId` write path).
//   • Tenant check: employee row + document row must both share the
//     principal's active club.
//
// This endpoint is a READ that hits the canonical EmployeeDocument
// storage + the same tenant discipline as `listEmployeeDocuments`.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { resolveDocumentStorage } from "@/lib/documents/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
