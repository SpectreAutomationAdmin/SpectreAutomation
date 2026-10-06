// COA-MAP-1 (2026-10-06) — edit / delete a Financial Statement Group.

import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import {
  editTenantGroup,
  deleteTenantGroup,
  GroupServiceError,
} from "@/lib/coa-mapping/group-service";
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

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const { id } = await props.params;
  const principal = await requirePrincipal();
  const body = await req.json().catch(() => ({}));
  const clubId = String(body.clubId ?? "").trim();
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const result = await editTenantGroup({
      clubId,
      groupId: id,
      name: body.name,
      reportingRole: (body.reportingRole as ReportingRole | null | undefined),
      parentGroupId: body.parentGroupId,
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

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const { id } = await props.params;
  const principal = await requirePrincipal();
  const clubId = req.nextUrl.searchParams.get("clubId") ?? "";
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    await deleteTenantGroup({
      clubId,
      groupId: id,
      actorUserId: principal.id,
      actorEmail: principal.email ?? null,
    });
    return NextResponse.json({ deleted: id });
  } catch (e) {
    if (e instanceof GroupServiceError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    throw e;
  }
}
