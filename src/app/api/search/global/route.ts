// Phase 4R rev-4 (2026-08-15) — global-search API.
//
// GET /api/search/global?q=<query>
//
// Auth: authenticated principal + active club. Tenant-scoped
// through `runGlobalSearch({ clubId })`.
// READ-ONLY. Never writes.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { prisma } from "@/lib/prisma";
import { runGlobalSearch, type GlobalSearchGrouped } from "@/lib/search/global-search";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<GlobalSearchGrouped | { error: string }>> {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return NextResponse.json({ error: "no_club" }, { status: 400 });

  const q = req.nextUrl.searchParams.get("q") ?? "";
  const grouped = await runGlobalSearch({ prisma, clubId, query: q });
  return NextResponse.json(grouped, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
