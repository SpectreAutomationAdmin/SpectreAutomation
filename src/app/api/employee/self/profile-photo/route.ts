// HR-2C Shell Refinement (2026-08-24) — Employee self-photo streamer.
//
// GET /api/employee/self/profile-photo
//   Streams the bytes of the currently-authenticated employee's own
//   profile photo. Reads the permanent Employee Portal session cookie
//   (EmployeePortalPrincipal) — an admin Principal is NOT accepted.
//
//   Same-shape 404 for every deny (no session; no photo; wrong tenant;
//   wrong category) so a caller cannot enumerate employees or photo
//   ids by response code.
//
//   The equivalent admin route lives at
//   /api/hr/employees/[id]/profile-photo and requires
//   hr:documents:read. This one is portal-scoped: an employee reads
//   ONLY their own bytes.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { resolveDocumentStorage } from "@/lib/documents/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = () => NextResponse.json({ error: "not_found" }, { status: 404 });

export async function GET(_req: NextRequest) {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) return NOT_FOUND();

  const employee = await prisma.employee.findFirst({
    where: { id: principal.employeeId, clubId: principal.clubId },
    select: { id: true, clubId: true, profilePhotoDocumentId: true },
  });
  if (!employee || !employee.profilePhotoDocumentId) return NOT_FOUND();

  const doc = await prisma.employeeDocument.findUnique({
    where: { id: employee.profilePhotoDocumentId },
    select: {
      id: true, clubId: true, employeeId: true,
      category: true, mimeType: true, storageKey: true, sizeBytes: true,
    },
  });
  if (
    !doc ||
    doc.clubId !== employee.clubId ||
    doc.employeeId !== employee.id ||
    doc.category !== "profile_photo"
  ) {
    return NOT_FOUND();
  }

  try {
    const storage = await resolveDocumentStorage({ clubId: doc.clubId });
    const bytes = await storage.get({ storageKey: doc.storageKey });
    if (!bytes) return NOT_FOUND();
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": doc.mimeType,
        "Content-Length": String(bytes.length),
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=30, must-revalidate",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "storage_unavailable" }, { status: 502 });
  }
}
