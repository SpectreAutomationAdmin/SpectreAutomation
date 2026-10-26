// SIGNUP-2 Phase 2F (2026-10-26) -- POST sweep trigger.
//
// Operator-triggered sweep.  Super-admin gated.  Fail-closed on the
// Phase 2F flag.  The eventual Fly-worker cron that calls this
// endpoint every 5 minutes is a follow-up wiring step (tracked in
// the Stripe follow-up doc + the Phase 2F plan).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isSuperAdmin } from "@/lib/rbac";
import { ForbiddenError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { sweepActivationCandidates } from "@/lib/billing/signup-2f-activation-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!isSuperAdmin(principal)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  // Mock evidence can ONLY be authorised when the caller passes
  // testOnly=1 AND SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP=1 on the
  // staging container.  Production never has that env var set.
  const testOnlyRequested = url.searchParams.get("testOnly") === "1";
  const testOnlyEnabled = process.env.SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP === "1";
  const testOnly = testOnlyRequested && testOnlyEnabled;
  try {
    const result = await sweepActivationCandidates({ testOnly });
    logger.info("signup.activation.sweep_api", {
      operatorUserIdTail: principal.id.slice(-6),
      testOnly,
      ...result,
    });
    return NextResponse.json({ ok: true, testOnly, ...result });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: "forbidden", detail: err.message }, { status: 403 });
    }
    logger.error("signup.activation.sweep_api_failed", {
      detail: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
