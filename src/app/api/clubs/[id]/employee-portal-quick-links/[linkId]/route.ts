// Employee Portal Quick Links (2026-08-27) — update + delete + file
// attach + file stream for a single link. All handlers tenant-scoped;
// same-shape 404 for unauthorized callers.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { hasPermission } from "@/lib/rbac";
import {
  updateQuickLink,
  deleteQuickLink,
  attachQuickLinkFile,
  readQuickLinkFile,
  getQuickLink,
} from "@/lib/employee-portal/quick-links";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function PATCH(req: NextRequest, { params }: { params: { id: string; linkId: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "settings:write")) return NOT_FOUND;
  let body: { label?: string; destinationType?: "url" | "file"; url?: string | null; isActive?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const link = await updateQuickLink(principal, params.id, params.linkId, body);
    return NextResponse.json({ link });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string; linkId: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "settings:write")) return NOT_FOUND;
  try {
    await deleteQuickLink(principal, params.id, params.linkId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

// File attach — multipart (or raw body when frontend sends a Blob).
export async function PUT(req: NextRequest, { params }: { params: { id: string; linkId: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "settings:write")) return NOT_FOUND;
  const contentType = req.headers.get("content-type") ?? "";
  try {
    let bytes: Buffer;
    let mimeType = "application/pdf";
    let originalName = "quick-link.pdf";
    if (contentType.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const f = form.get("file");
      if (!(f instanceof File)) return NextResponse.json({ error: "file field required" }, { status: 400 });
      bytes = Buffer.from(await f.arrayBuffer());
      mimeType = f.type || mimeType;
      originalName = f.name || originalName;
    } else {
      bytes = Buffer.from(await req.arrayBuffer());
      if (contentType) mimeType = contentType;
      const disp = req.headers.get("x-original-filename");
      if (disp) originalName = disp;
    }
    const link = await attachQuickLinkFile(principal, params.id, params.linkId, {
      bytes, mimeType, originalName,
    });
    return NextResponse.json({ link });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

// File stream — Employee or Admin can read; strictly tenant-scoped.
export async function GET(_req: NextRequest, { params }: { params: { id: string; linkId: string } }) {
  const admin = await getCurrentPrincipal();
  const employee = await getEmployeePortalPrincipal();
  const authorized = (admin && hasPermission(admin, params.id, "settings:read"))
    || (employee && employee.clubId === params.id);
  if (!authorized) return NOT_FOUND;

  const link = await getQuickLink(params.id, params.linkId);
  if (!link) return NOT_FOUND;
  if (!link.storageKey) return NextResponse.json({ error: "No file attached" }, { status: 400 });
  const bytes = await readQuickLinkFile(params.id, params.linkId);
  if (!bytes) return NOT_FOUND;
  return new NextResponse(new Uint8Array(bytes.bytes), {
    status: 200,
    headers: {
      "Content-Type": bytes.mimeType,
      "Content-Disposition": `inline; filename="${bytes.originalName.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=60, must-revalidate",
    },
  });
}
