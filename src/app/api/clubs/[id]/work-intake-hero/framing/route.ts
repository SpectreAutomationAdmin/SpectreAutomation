// WI-1D (2026-09-27) — Work Intake hero framing (focal + zoom) endpoint.
//
// Structural clone of the accepted employee-portal-hero framing route.
// Same auth, same validators, same ClubMedia service. Only CATEGORY
// changes.
//
// POST   /api/clubs/[id]/work-intake-hero/framing
//   Body: { mode: "desktop"|"mobile"|"both", desktop?, mobile? }
// DELETE /api/clubs/[id]/work-intake-hero/framing
//   Body: { mode: "desktop"|"mobile"|"both" }

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  updateClubMediaFraming,
  resetClubMediaFraming,
} from "@/lib/club/media";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "settings:write")) return NOT_FOUND;

  let body: {
    mode?: "desktop" | "mobile" | "both";
    desktop?: { focalX?: number; focalY?: number; zoom?: number };
    mobile?: { focalX?: number; focalY?: number; zoom?: number };
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const mode = body.mode ?? "both";
  if (mode !== "desktop" && mode !== "mobile" && mode !== "both") {
    return NextResponse.json({ error: "invalid mode" }, { status: 400 });
  }

  try {
    const { framing } = await updateClubMediaFraming(principal, clubId, {
      category: "work_intake_hero",
      mode,
      desktop: body.desktop,
      mobile: body.mobile,
    });
    return NextResponse.json({ framing });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "settings:write")) return NOT_FOUND;

  let body: { mode?: "desktop" | "mobile" | "both" };
  try {
    body = await req.json();
  } catch {
    body = { mode: "both" };
  }
  const mode = body.mode ?? "both";
  if (mode !== "desktop" && mode !== "mobile" && mode !== "both") {
    return NextResponse.json({ error: "invalid mode" }, { status: 400 });
  }
  try {
    const { framing } = await resetClubMediaFraming(principal, clubId, "work_intake_hero", mode);
    return NextResponse.json({ framing });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
