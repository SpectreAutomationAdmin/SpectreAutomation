// COA-MAP-1 (2026-10-06) — reassign an account to a different
// Financial Statement Group with an effective date.

import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import { reassignAccount, ReassignmentError } from "@/lib/coa-mapping/assignment-service";

export const dynamic = "force-dynamic";

function isStaging(): boolean {
  const env = (process.env.SPECTRE_ENV ?? process.env.NEXT_PUBLIC_ENVIRONMENT ?? "").toLowerCase();
  if (env === "staging") return true;
  return env !== "production" && (process.env.NODE_ENV ?? "") !== "production";
}
function hasClubAccess(p: Principal, clubId: string): boolean {
  if (isSuperAdmin(p)) return true;
  return p.memberships.some((m) => m.clubId === clubId);
}

function parseEffectiveFrom(s: string | undefined | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ accountId: string }> },
): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const { accountId } = await props.params;
  const principal = await requirePrincipal();
  const body = await req.json().catch(() => ({}));
  const clubId = String(body.clubId ?? "").trim();
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const targetFsGroupId = String(body.targetFsGroupId ?? "").trim();
  if (!targetFsGroupId) return NextResponse.json({ error: "targetFsGroupId required" }, { status: 400 });

  // Default effectiveFrom = today (UTC midnight) when none supplied.
  const now = new Date();
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const effectiveFrom = parseEffectiveFrom(body.effectiveFrom) ?? defaultFrom;

  try {
    const result = await reassignAccount({
      clubId,
      accountId,
      targetFsGroupId,
      effectiveFrom,
      actorUserId: principal.id,
      actorEmail: principal.email ?? null,
      reason: body.reason ?? null,
      acknowledgeWarnings: Boolean(body.acknowledgeWarnings),
    });
    const statusCode =
      result.outcome === "OK" ? 200 :
      result.outcome === "BLOCKED" ? 409 :
      /* WARNING_UNACKNOWLEDGED */ 422;
    return NextResponse.json(result, { status: statusCode });
  } catch (e) {
    if (e instanceof ReassignmentError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    throw e;
  }
}
