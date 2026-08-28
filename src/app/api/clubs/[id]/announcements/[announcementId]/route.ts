// Announcements — update + delete (2026-08-27). Admin-only;
// tenant-scoped through the canonical service.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  updateAnnouncement,
  deleteAnnouncement,
  type AnnouncementAudience,
} from "@/lib/announcements";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; announcementId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "settings:write")) return NOT_FOUND;
  let body: {
    audience?: AnnouncementAudience;
    title?: string;
    body?: string;
    isPublished?: boolean;
    publishedAt?: string | null;
    expiresAt?: string | null;
    isPinned?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const announcement = await updateAnnouncement(principal, params.id, params.announcementId, {
      audience: body.audience,
      title: body.title,
      body: body.body,
      isPublished: body.isPublished,
      publishedAt: body.publishedAt === null
        ? null
        : body.publishedAt !== undefined
          ? new Date(body.publishedAt)
          : undefined,
      expiresAt: body.expiresAt === null
        ? null
        : body.expiresAt !== undefined
          ? new Date(body.expiresAt)
          : undefined,
      isPinned: body.isPinned,
    });
    return NextResponse.json({ announcement });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; announcementId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "settings:write")) return NOT_FOUND;
  try {
    await deleteAnnouncement(principal, params.id, params.announcementId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
