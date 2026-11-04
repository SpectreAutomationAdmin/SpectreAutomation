// EP-TRAIN-6D-4D — GET /api/admin/ai-training/drafts/[id]
//
// Tenant-scoped, read-only candidate detail. Returns a 404 same-shape
// response for every deny-reason (unauthenticated / no permission /
// cross-tenant / genuinely missing) so cross-tenant probes cannot
// distinguish states.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import {
  getCandidate,
  ReadServiceError,
} from "@/lib/hr/training/ai-review/read-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function same404(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}
function unauthenticated(): NextResponse {
  return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  if (!id || typeof id !== "string") return same404();

  const principal = await getCurrentPrincipal();
  if (!principal) return unauthenticated();
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });

  try {
    const detail = await getCandidate(principal, clubId, id);
    if (!detail) return same404();  // genuinely missing OR cross-tenant
    return NextResponse.json(detail);
  } catch (err) {
    if (err instanceof ReadServiceError) {
      if (err.code === "UNAUTHENTICATED") return unauthenticated();
      if (err.code === "FORBIDDEN") return same404();
    }
    throw err;
  }
}
