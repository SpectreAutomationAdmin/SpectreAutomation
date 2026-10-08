// COA-MAP-3A (2026-10-07) — staging-only principal + permissions
// diagnostic.  Returns the signed-in user's email, memberships, and
// resolved permission booleans for a specified clubId.
//
// Purpose: let the founder confirm what role her login actually
// holds on Coulee before any role mutation happens.  Read-only.
// Super-admin bypass is reflected.

import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { hasPermission, isSuperAdmin } from "@/lib/rbac";

export const dynamic = "force-dynamic";

function isStaging(): boolean {
  const env = (process.env.SPECTRE_ENV ?? process.env.NEXT_PUBLIC_ENVIRONMENT ?? "").toLowerCase();
  if (env === "staging") return true;
  return env !== "production" && (process.env.NODE_ENV ?? "") !== "production";
}

const CHECKS = [
  "coa:read", "coa:write",
  "settings:write",
  "gl:read", "gl:post",
] as const;

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const clubId = req.nextUrl.searchParams.get("clubId") ?? "";
  const permissions: Record<string, boolean> = {};
  for (const perm of CHECKS) {
    permissions[perm] = hasPermission(principal, clubId || null, perm);
  }
  return NextResponse.json({
    user: {
      id: principal.id,
      email: principal.email ?? null,
    },
    activeClubId: principal.activeClubId ?? null,
    superAdmin: isSuperAdmin(principal),
    memberships: principal.memberships.map((m) => ({ clubId: m.clubId, roleKey: m.roleKey })),
    forClubId: clubId || null,
    permissions,
  });
}
