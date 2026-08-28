// Announcements — list + create (2026-08-27). Admin-only; tenant-
// scoped through settings:read/write and the canonical service.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  listAnnouncements,
  createAnnouncement,
  type AnnouncementAudience,
} from "@/lib/announcements";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "settings:read")) return NOT_FOUND;
  const announcements = await listAnnouncements(clubId);
  return NextResponse.json({ announcements });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "settings:write")) return NOT_FOUND;
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
    const announcement = await createAnnouncement(principal, clubId, {
      audience: body.audience ?? "EMPLOYEE",
      title: body.title ?? "",
      body: body.body ?? "",
      isPublished: body.isPublished ?? false,
      publishedAt: body.publishedAt ? new Date(body.publishedAt) : null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      isPinned: body.isPinned ?? false,
    });
    return NextResponse.json({ announcement }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
