// EP-TRAIN-6D-4D — GET /api/admin/ai-training/drafts
//
// Tenant-scoped, read-only queue of persisted AI training candidates.
// Requires `hr:training:ai:read` on the active club.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import {
  listCandidates,
  ReadServiceError,
  type LifecycleState,
} from "@/lib/hr/training/ai-review/read-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same-shape responses for every denial — no cross-tenant enumeration signal.
function same404(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}
function unauthenticated(): NextResponse {
  return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
}
function badRequest(code: string): NextResponse {
  return NextResponse.json({ error: code }, { status: 400 });
}

const ALLOWED_STATES = new Set<LifecycleState>([
  "GENERATED",
  "VALIDATION_PENDING",
  "REQUIRES_HUMAN_REVIEW",
  "APPROVED_DRAFT",
  "REJECTED",
  "EDITED_VALIDATION_STALE",
  "VALIDATION_FAILED",
  "ARCHIVED",
]);

export async function GET(req: NextRequest): Promise<NextResponse> {
  const principal = await getCurrentPrincipal();
  if (!principal) return unauthenticated();
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });

  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  const limitRaw = url.searchParams.get("limit");
  let limit: number | undefined = undefined;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 50) return badRequest("invalid_limit");
    limit = n;
  }

  // states[]=X&states[]=Y OR comma-separated states=X,Y
  const statesParam = url.searchParams.getAll("states");
  const statesRaw: string[] = statesParam.length > 0
    ? statesParam.flatMap((s) => s.split(",").map((t) => t.trim()).filter(Boolean))
    : [];
  const states: LifecycleState[] = [];
  for (const s of statesRaw) {
    if (!ALLOWED_STATES.has(s as LifecycleState)) return badRequest("invalid_state");
    states.push(s as LifecycleState);
  }

  try {
    const page = await listCandidates(principal, clubId, {
      cursor: cursor ?? undefined,
      limit,
      states: states.length > 0 ? states : undefined,
    });
    return NextResponse.json({
      rows: page.rows,
      nextCursor: page.nextCursor,
      limit: page.limit,
      states: page.states,
    });
  } catch (err) {
    if (err instanceof ReadServiceError) {
      if (err.code === "UNAUTHENTICATED") return unauthenticated();
      if (err.code === "FORBIDDEN") return same404();   // same-shape 404 on authz failure
    }
    throw err;
  }
}
