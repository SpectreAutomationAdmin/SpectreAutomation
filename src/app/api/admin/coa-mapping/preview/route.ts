// COA-MAP-1 (2026-10-06) — reporting impact preview.

import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import { previewAccountReassignmentImpact } from "@/lib/coa-mapping/impact-preview";

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

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const body = await req.json().catch(() => ({}));
  const clubId = String(body.clubId ?? "").trim();
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const accountId = String(body.accountId ?? "").trim();
  const targetFsGroupId = String(body.targetFsGroupId ?? "").trim();
  if (!accountId || !targetFsGroupId) {
    return NextResponse.json({ error: "accountId and targetFsGroupId required" }, { status: 400 });
  }

  const preview = await previewAccountReassignmentImpact({
    clubId, accountId, targetFsGroupId,
  }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : "Preview failed" }));
  if ("error" in preview) {
    return NextResponse.json(preview, { status: 400 });
  }
  return NextResponse.json(preview);
}
