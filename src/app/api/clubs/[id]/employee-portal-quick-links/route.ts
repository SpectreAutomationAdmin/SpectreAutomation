// Employee Portal Quick Links (2026-08-27) — list + create routes.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { listQuickLinks, createQuickLink } from "@/lib/employee-portal/quick-links";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "settings:read")) return NOT_FOUND;
  const links = await listQuickLinks(clubId);
  return NextResponse.json({ links });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "settings:write")) return NOT_FOUND;
  let body: { label?: string; destinationType?: "url" | "file"; url?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const link = await createQuickLink(principal, clubId, {
      label: body.label ?? "",
      destinationType: body.destinationType ?? "url",
      url: body.url ?? null,
    });
    return NextResponse.json({ link }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
