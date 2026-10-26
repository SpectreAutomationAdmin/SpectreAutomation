// SIGNUP-2 Phase 2H (2026-10-26) -- Tenant reinstatement endpoint.
//
// POST /api/admin/signup-ops/tenants/[clubId]/reinstate
//   body: { authoriserUserId, reasonCode, reasonNotes, skipFinancialRecheck? }
//
// Progresses one step: SUSPENDED -> UNDER_REVIEW (single operator)
// or UNDER_REVIEW -> ACTIVE (requires authoriser != operator).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { ForbiddenError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { reinstateTenant } from "@/lib/billing/signup-2h-tenant-lifecycle-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: { clubId: string } },
): Promise<Response> {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!hasPermission(principal, null, "platform:tenants:reinstate")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: any = null;
  try { body = await req.json(); } catch { body = {}; }
  const authoriserUserId = body?.authoriserUserId as string | undefined;
  if (!authoriserUserId || typeof authoriserUserId !== "string") {
    return NextResponse.json(
      { error: "bad_request", detail: "authoriserUserId required" },
      { status: 400 },
    );
  }
  try {
    const result = await reinstateTenant({
      clubId: params.clubId,
      operatorUserId: principal.id,
      authoriserUserId,
      reasonCode: body?.reasonCode,
      reasonNotes: body?.reasonNotes,
      skipFinancialRecheck: body?.skipFinancialRecheck === true,
    });
    logger.info("signup.lifecycle.reinstate_api", {
      operatorUserIdTail: principal.id.slice(-6),
      authoriserUserIdTail: authoriserUserId.slice(-6),
      clubIdTail: params.clubId.slice(-6),
      okFlag: result.ok,
    });
    return NextResponse.json({ ok: true, outcome: result });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden", detail: err.message }, { status: 403 });
    }
    logger.error("signup.lifecycle.reinstate_api_failed", {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
