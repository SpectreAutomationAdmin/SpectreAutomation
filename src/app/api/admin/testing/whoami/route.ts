// COA-MAP-3A (2026-10-07) — staging-only principal + permissions
// diagnostic.
// COA-MAP-3B (2026-10-07) — hardened against 500s.  The previous
// version called `requirePrincipal()` directly; an unauthenticated
// request (expired cookie, no cookie, cookie schema drift) raised
// `UnauthenticatedError` → uncaught → HTTP 500.  The founder hit
// exactly this path from her browser.  This revision:
//
//   • uses `getCurrentPrincipal()` (null-safe) instead of
//     `requirePrincipal()`;
//   • returns a structured 401 payload when there is no session,
//     so the founder can see "no session" vs "wrong role";
//   • wraps the whole handler in try/catch so any unexpected
//     error returns a structured 500 with the error message
//     instead of an opaque Next.js error page.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
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
  try {
    if (!isStaging()) {
      return NextResponse.json({ error: "Not available in production." }, { status: 404 });
    }

    const principal = await getCurrentPrincipal().catch(() => null);
    if (!principal) {
      return NextResponse.json(
        {
          status: "unauthenticated",
          reason: "No signed-in session on this request. Check that you are logged in in this browser tab.",
          cookiesPresent: Boolean(req.headers.get("cookie")),
        },
        { status: 401 },
      );
    }

    const clubId = req.nextUrl.searchParams.get("clubId") ?? "";
    const permissions: Record<string, boolean> = {};
    for (const perm of CHECKS) {
      permissions[perm] = hasPermission(principal, clubId || null, perm);
    }
    return NextResponse.json({
      status: "ok",
      user: {
        id: principal.id,
        email: principal.email ?? null,
        name: principal.name ?? null,
      },
      activeClubId: principal.activeClubId ?? null,
      superAdmin: isSuperAdmin(principal),
      memberships: (principal.memberships ?? []).map((m) => ({ clubId: m.clubId, roleKey: m.roleKey })),
      forClubId: clubId || null,
      permissions,
    });
  } catch (e) {
    // Diagnostic MUST NOT 500 — surface a structured JSON error so
    // the founder sees what went wrong in-browser.
    return NextResponse.json(
      {
        status: "error",
        reason: e instanceof Error ? e.message : "Unknown error resolving principal.",
      },
      { status: 500 },
    );
  }
}
