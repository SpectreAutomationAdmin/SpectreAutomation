// COA-MAP-1 (2026-10-06) — list + create Financial Statement Groups.
//
// Staging-only during the compatibility window; follows the admin
// API pattern of AR-HIST-1 / MEM-HIST-2 / GOLF-HIST-1.

import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { createTenantGroup, GroupServiceError } from "@/lib/coa-mapping/group-service";
import type { ReportingRole } from "@/lib/coa-mapping/reporting-role";

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

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const clubId = req.nextUrl.searchParams.get("clubId") ?? "";
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const groups = await prisma.financialStatementGroup.findMany({
    where: { clubId },
    orderBy: [{ statement: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      key: true,
      name: true,
      statement: true,
      cashFlowSection: true,
      sortOrder: true,
      parentGroupId: true,
      reportingRole: true,
      isTenantCreated: true,
      _count: { select: { accounts: true } },
    },
  });
  return NextResponse.json({ groups });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const body = await req.json().catch(() => ({}));
  const clubId = String(body.clubId ?? "").trim();
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const result = await createTenantGroup({
      clubId,
      name: String(body.name ?? "").trim(),
      statement: body.statement,
      parentGroupId: body.parentGroupId ?? null,
      reportingRole: (body.reportingRole as ReportingRole | null | undefined) ?? null,
      sortOrder: body.sortOrder,
      actorUserId: principal.id,
      actorEmail: principal.email ?? null,
    });
    return NextResponse.json({ group: result.group, auditId: result.auditId });
  } catch (e) {
    if (e instanceof GroupServiceError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    throw e;
  }
}
