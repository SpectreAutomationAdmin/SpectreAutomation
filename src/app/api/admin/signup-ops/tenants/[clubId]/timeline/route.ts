// SIGNUP-2 Phase 2H (2026-10-26) -- Tenant lifecycle timeline (read-only).
//
// GET /api/admin/signup-ops/tenants/[clubId]/timeline
//
// Super-admin diagnostic surface.  Returns up to 50 most-recent
// TenantLifecycleTransition rows for the Club.  No mutations.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { logger } from "@/lib/observability/logger";
import { readTenantLifecycleTimeline } from "@/lib/billing/signup-2h-tenant-lifecycle-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: { clubId: string } },
): Promise<Response> {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (
    !hasPermission(principal, null, "platform:tenants:suspend") &&
    !hasPermission(principal, null, "platform:tenants:reinstate") &&
    !hasPermission(principal, null, "platform:tenants:remediate")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const timeline = await readTenantLifecycleTimeline(params.clubId);
  logger.info("signup.lifecycle.timeline_api", {
    operatorUserIdTail: principal.id.slice(-6),
    clubIdTail: params.clubId.slice(-6),
    rowCount: timeline.length,
  });
  return NextResponse.json({ ok: true, timeline });
}
