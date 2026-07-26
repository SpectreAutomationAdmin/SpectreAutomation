import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";

export async function GET() {
  const p = await getCurrentPrincipal();
  if (!p) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "ap:invoice:create")) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [vendors, accounts, departments, taxCodes] = await Promise.all([
    prisma.vendor.findMany({
      where: { clubId, status: { in: ["ACTIVE", "PENDING_APPROVAL", "DRAFT"] } },
      orderBy: { legalName: "asc" },
      select: { id: true, legalName: true, vendorNumber: true },
    }),
    prisma.account.findMany({
      where: { clubId, type: "EXPENSE", isHeader: false, isActive: true },
      orderBy: { accountNumber: "asc" },
      select: { accountNumber: true, name: true },
    }),
    prisma.department.findMany({
      where: { clubId, isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { code: true, name: true },
    }),
    prisma.taxCode.findMany({
      where: { clubId, isActive: true },
      orderBy: { key: "asc" },
      select: { key: true, name: true, ratePct: true },
    }),
  ]);
  return NextResponse.json({
    vendors: vendors.map((v) => ({ value: v.id, label: `${v.legalName} (${v.vendorNumber})` })),
    accounts: accounts.map((a) => ({ value: a.accountNumber, label: `${a.accountNumber} · ${a.name}` })),
    departments: departments.map((d) => ({ value: d.code, label: d.name })),
    taxCodes: taxCodes.map((t) => ({ value: t.key, label: `${t.name} (${t.ratePct.toString()}%)`, rate: Number(t.ratePct.toString()) })),
  });
}
