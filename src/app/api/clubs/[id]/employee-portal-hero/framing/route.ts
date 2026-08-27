// HR portal hero framing (2026-08-26) — canonical write endpoint for
// the Employee Portal Hero framing (desktop + mobile focal + zoom).
//
// POST   /api/clubs/[id]/employee-portal-hero/framing
//   Body: { mode: "desktop"|"mobile"|"both", desktop?, mobile? }
//   Persists normalized focal X/Y + zoom via `updateClubMediaFraming`.
//   Values clamped server-side; admin-facing UI cannot supply out-of-
//   range values. Returns the resolved framing pair.
//
// DELETE /api/clubs/[id]/employee-portal-hero/framing
//   Body: { mode: "desktop"|"mobile"|"both" }
//   Nulls the columns for the selected mode(s) — subsequent renders
//   fall through to `DEFAULT_HERO_FRAMING`.
//
// Both routes: 404 same-shape refusal when the caller lacks
// `settings:write` on the target club (parity with the parent route).

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
      category: "employee_portal_hero",
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
    const { framing } = await resetClubMediaFraming(principal, clubId, "employee_portal_hero", mode);
    return NextResponse.json({ framing });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
