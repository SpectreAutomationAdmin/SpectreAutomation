// PAY-1A.1 (2026-09-26) — simulator-directive testing hook.
//
// Focused test hook for the deployed lifecycle acceptance. Sets a
// per-instruction simulator directive so a caller can exercise RETURN
// / REJECT / TIMEOUT / ACCEPT_THEN_SETTLE behaviour end-to-end
// through the same deployed HTTP path that real lifecycle transitions
// use.
//
// NOT a lifecycle walker — every state transition still passes
// through its own dedicated endpoint. This route only configures the
// simulator; it never advances state.
//
// Security guards (defense in depth):
//   1. PAYMENTS_REAL_MONEY_ENABLED must NOT be "true". This is the
//      DEFINITIVE staging-vs-real-money signal — Next.js sets
//      NODE_ENV=production on staging for build optimisation, so
//      NODE_ENV is NOT a reliable environment discriminator here.
//   2. Only the SIMULATOR provider is affected — a future real
//      provider is unreachable through this endpoint.
//   3. Caller must hold payment:authorize (Controller-tier) — the
//      same permission that authorizes real payments.
//
// If any guard fails, the route returns 403 with a neutral message.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getSimulator, type SimulatorDirective } from "@/lib/payments/provider/simulator";
import { realMoneyEnabled } from "@/lib/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_DIRECTIVES = new Set([
  "ACCEPT_THEN_SETTLE", "REJECT", "TIMEOUT", "RETURN_AFTER_SETTLE",
]);

export async function POST(req: NextRequest) {
  // Environment guard: refuses if real-money capability is on. This
  // is the definitive signal — NODE_ENV=production on staging is
  // expected (Next.js build mode) so we do NOT gate on it. The
  // real-money capability flip is the only distinction that matters:
  // simulator directives cannot affect real money, and any future
  // real provider will refuse to construct when this flag is off.
  if (realMoneyEnabled()) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    runId?: string;
    instructionId?: string; // if omitted, applies to ALL instructions in the run
    kind?: string;
    code?: string;
    description?: string;
  };
  if (!body.runId || !body.kind || !VALID_DIRECTIVES.has(body.kind)) {
    return NextResponse.json({ error: "runId + kind (ACCEPT_THEN_SETTLE|REJECT|TIMEOUT|RETURN_AFTER_SETTLE) required" }, { status: 400 });
  }

  // Tenant + authorization gate.
  const run = await prisma.paymentRun.findUnique({
    where: { id: body.runId },
    select: { clubId: true, instructions: { select: { id: true } } },
  });
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
  if (!hasPermission(principal, run.clubId, "payment:authorize")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const directive: SimulatorDirective =
    body.kind === "REJECT"
      ? { kind: "REJECT", code: body.code, description: body.description }
      : body.kind === "RETURN_AFTER_SETTLE"
      ? { kind: "RETURN_AFTER_SETTLE", code: body.code, description: body.description }
      : body.kind === "TIMEOUT"
      ? { kind: "TIMEOUT" }
      : { kind: "ACCEPT_THEN_SETTLE" };

  const sim = getSimulator();
  const targets = body.instructionId ? [body.instructionId] : run.instructions.map((i) => i.id);
  for (const iid of targets) {
    sim.setDirective(`run:${body.runId}:inst:${iid}`, directive);
  }

  return NextResponse.json({
    ok: true,
    runId: body.runId,
    instructionsAffected: targets.length,
    directive: body.kind,
  });
}
