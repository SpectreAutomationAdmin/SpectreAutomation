// SIGNUP-2 Phase 2H (2026-10-26) -- Tenant suspension endpoint.
//
// POST /api/admin/signup-ops/tenants/[clubId]/suspend
//   body: { trigger, targetStatus?, reasonCode?, reasonNotes?, triggerEvidence? }
//
// Fail-closed on SPECTRE_SIGNUP_2H_SUSPENSION_LIVE.
// Requires platform:tenants:suspend permission (SUPER_ADMIN-only by default).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { ForbiddenError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import {
  suspendTenant,
  SUSPENSION_TRIGGERS,
  type SuspensionTrigger,
} from "@/lib/billing/signup-2h-tenant-lifecycle-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: { clubId: string } },
): Promise<Response> {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!hasPermission(principal, null, "platform:tenants:suspend")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: any = null;
  try { body = await req.json(); } catch { body = {}; }
  const trigger = body?.trigger as string | undefined;
  if (!trigger || !(SUSPENSION_TRIGGERS as readonly string[]).includes(trigger)) {
    return NextResponse.json(
      { error: "bad_request", detail: `trigger must be one of ${SUSPENSION_TRIGGERS.join(", ")}` },
      { status: 400 },
    );
  }
  try {
    const result = await suspendTenant({
      clubId: params.clubId,
      trigger: trigger as SuspensionTrigger,
      targetStatus: body?.targetStatus,
      operatorUserId: principal.id,
      reasonCode: body?.reasonCode,
      reasonNotes: body?.reasonNotes,
      triggerEvidence: body?.triggerEvidence,
    });
    logger.info("signup.lifecycle.suspend_api", {
      operatorUserIdTail: principal.id.slice(-6),
      clubIdTail: params.clubId.slice(-6),
      trigger,
      okFlag: result.ok,
    });
    return NextResponse.json({ ok: true, outcome: result });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden", detail: err.message }, { status: 403 });
    }
    logger.error("signup.lifecycle.suspend_api_failed", {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
