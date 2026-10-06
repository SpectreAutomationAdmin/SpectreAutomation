// COA-MAP-2 (2026-10-06) — Account mapping history (read-only).
//
// Returns the full effective-dated assignment history for one account
// so the Mapping Studio's Account Inspector can render REPORTING
// HISTORY without exposing database terminology. Read over the
// existing AccountFinancialStatementAssignment table — NO schema
// change.
//
// This endpoint is club-scoped (tenant isolation enforced by
// clubId filter) and read-only (no mutations, no posting guard).

import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function hasClubAccess(p: Principal, clubId: string): boolean {
  if (isSuperAdmin(p)) return true;
  return p.memberships.some((m) => m.clubId === clubId);
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ accountId: string }> },
): Promise<NextResponse> {
  const { accountId } = await props.params;
  const principal = await requirePrincipal();
  const url = new URL(req.url);
  const clubId = (url.searchParams.get("clubId") ?? "").trim();
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const account = await prisma.account.findFirst({
    where: { id: accountId, clubId },
    select: { id: true, accountNumber: true, name: true },
  });
  if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });

  const rows = await prisma.accountFinancialStatementAssignment.findMany({
    where: { clubId, accountId },
    orderBy: { effectiveFrom: "asc" },
    include: {
      fsGroup: {
        select: {
          id: true,
          name: true,
          statement: true,
          reportingRole: true,
        },
      },
    },
  });

  const history = rows.map((r) => ({
    fsGroupId:      r.fsGroup.id,
    fsGroupName:    r.fsGroup.name,
    statement:      r.fsGroup.statement,
    reportingRole:  r.fsGroup.reportingRole,
    effectiveFrom:  r.effectiveFrom.toISOString().slice(0, 10),
    effectiveTo:    r.effectiveTo ? r.effectiveTo.toISOString().slice(0, 10) : null,
  }));

  return NextResponse.json({ account, history });
}
