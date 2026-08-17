// HR-2A (2026-08-16) — GET /api/people/employees/member-search.
//
// Lightweight Member lookup used by the Add Employee form's
// "Link to a Club Member" section. Returns up to 5 candidates
// scoped strictly to the caller's active club — the caller-supplied
// query never widens the search across tenants.
//
// Discipline:
//   • Guarded by `hr:employee:write` (same permission as create).
//   • Reads are on `Member` (public roster) with a `where: {clubId}`
//     filter — no sensitive fields returned.
//   • Never auto-links; this route only surfaces candidates.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";

export async function GET(req: NextRequest) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ candidates: [] }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:employee:write")) {
    return NextResponse.json({ candidates: [] }, { status: 403 });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ candidates: [] });

  const rows = await prisma.member.findMany({
    where: {
      clubId,
      OR: [
        { lastName: { contains: q } },
        { firstName: { contains: q } },
        { email: { contains: q } },
      ],
    },
    select: {
      id: true,
      memberNumber: true,
      firstName: true,
      lastName: true,
      email: true,
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: 5,
  });

  return NextResponse.json({ candidates: rows });
}
