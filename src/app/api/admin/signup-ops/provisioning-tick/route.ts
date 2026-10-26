// SIGNUP-2 Phase 2G (2026-10-26) -- Operator-tick POST endpoint.
//
// Advances Phase 2G provisioning jobs by one step each.  Super-admin
// gated; fail-closed on the Phase 2G flag.  The Fly-worker cron that
// calls this every N minutes is a follow-on wiring slice (founder
// decision D6 defaults to operator-tick only).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isSuperAdmin } from "@/lib/rbac";
import { ForbiddenError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import {
  sweepProvisioningCandidates,
  tickProvisioningJob,
} from "@/lib/billing/signup-2g-provisioning-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!isSuperAdmin(principal)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  try {
    if (jobId) {
      const outcome = await tickProvisioningJob(jobId);
      logger.info("signup.provisioning.tick_api_single", {
        operatorUserIdTail: principal.id.slice(-6),
        jobIdTail: jobId.slice(-6),
        okFlag: outcome.ok,
      });
      return NextResponse.json({ ok: true, mode: "single", outcome });
    }
    const result = await sweepProvisioningCandidates();
    logger.info("signup.provisioning.tick_api_sweep", {
      operatorUserIdTail: principal.id.slice(-6),
      ...result,
    });
    return NextResponse.json({ ok: true, mode: "sweep", ...result });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden", detail: err.message }, { status: 403 });
    }
    logger.error("signup.provisioning.tick_api_failed", {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
