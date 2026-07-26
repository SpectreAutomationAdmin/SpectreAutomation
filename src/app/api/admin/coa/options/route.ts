import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";

export async function GET() {
  const p = await getCurrentPrincipal();
  if (!p) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "gl:post")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [accounts, departments] = await Promise.all([
    prisma.account.findMany({
      where: { clubId, isActive: true },
      orderBy: { accountNumber: "asc" },
      select: { accountNumber: true, name: true, type: true, allowManualPosting: true, isHeader: true },
    }),
    prisma.department.findMany({
      where: { clubId, isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { code: true, name: true },
    }),
  ]);
  return NextResponse.json({
    accounts: accounts.map((a) => ({ number: a.accountNumber, name: a.name, type: a.type, allowManualPosting: a.allowManualPosting, isHeader: a.isHeader })),
    departments,
  });
}
