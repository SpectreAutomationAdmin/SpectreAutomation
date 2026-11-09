// EP-TRAIN-4Y-S §5+§6 — PATCH /api/admin/training/versions/[id]/draft-metadata
//
// Lightweight metadata-only update for the Manager Review surface.
// Accepts { title, description } via FormData (so blur-save in the
// client is a one-liner `fetch(PATCH, { body: FormData })`) and
// delegates to the existing `updateDraft` service — which already
// enforces tenant ownership, `hr:training:write`, DRAFT-only, and
// audit. No new auth surface; no bypass.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { updateDraft } from "@/lib/hr/training/courses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let title: string | undefined;
  let description: string | null | undefined;
  try {
    const form = await req.formData();
    const titleField = form.get("title");
    if (typeof titleField === "string") title = titleField;
    const descField = form.get("description");
    if (typeof descField === "string") description = descField || null;
  } catch {
    return NextResponse.json({ error: "invalid_form_data" }, { status: 400 });
  }

  if (title === undefined && description === undefined) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }

  try {
    await updateDraft(principal, id, { title, description });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: "update_failed", message: (err as Error)?.message ?? String(err) },
      { status: 500 },
    );
  }
}
