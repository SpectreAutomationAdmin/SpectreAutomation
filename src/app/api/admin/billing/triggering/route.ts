// SIGNUP-2 M4-INT-B §1 (2026-10-29) -- Operator API for commercial
// authorization + payment release.
//
// GET   ?action=preflight&signupRegistrationId=...&billingCycleId=...
//       Pure read; returns PreflightResult shape (refusal reason,
//       context including loaded authorizer identity).  No side effects.
//
// POST  { action: "record-commercial-auth", signupRegistrationId, notes? }
//       Operator A step.  Writes ClubPaymentAuthorisation (idempotent).
//       Returns { authorisationId, noop }.
//
// POST  { action: "release", signupRegistrationId, billingCycleId,
//         releaseApprovalNotes?, idempotencyScope }
//       Operator B step.  Enforces SoD against the recorded operator A.
//       Does NOT invoke Stripe (worker is a separate step).
//
// POST  { action: "drain", commandId }
//       Operator-triggered worker invocation for a specific command.
//       DUAL-flag gated: refuses when M4-triggering is OFF OR when
//       M3 payment-initiation is OFF.  Returns the attempt outcome.
//
// Access:  SUPER_ADMIN only via `platform:signups:release`.
// Tenancy: service enforces registration + cycle linkage; cross-
//          registration cycles are refused inside preflight.
// Audit:   every write is service-level audited.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import {
  evaluatePreflight,
  recordCommercialAuthorisation,
  authoriseAndReleaseFirstBilling,
  drainOneBillingCommand,
} from "@/lib/billing/signup-2m4-triggering-service";
import { prisma } from "@/lib/prisma";

async function requireOperator(): Promise<
  { ok: true; principalId: string } | { ok: false; status: number; body: unknown }
> {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) {
    return { ok: false, status: 401, body: { ok: false, error: "unauthenticated" } };
  }
  if (!hasPermission(principal, null, "platform:signups:release")) {
    return { ok: false, status: 403, body: { ok: false, error: "forbidden" } };
  }
  return { ok: true, principalId: principal.id };
}

export async function GET(req: Request): Promise<Response> {
  const auth = await requireOperator();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  if (action === "preflight") {
    const signupRegistrationId = url.searchParams.get("signupRegistrationId") ?? "";
    const billingCycleId = url.searchParams.get("billingCycleId") ?? "";
    if (!signupRegistrationId || !billingCycleId) {
      return NextResponse.json({ ok: false, error: "missing_ids" }, { status: 400 });
    }
    // Preflight is a pure read and does NOT depend on the live flag;
    // we skip the flag check so the UI can display the preflight even
    // when the slice is dormant.
    try {
      const result = await evaluatePreflight({ signupRegistrationId, billingCycleId });
      return NextResponse.json({ ok: true, preflight: result }, { status: 200 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown_error";
      return NextResponse.json({ ok: false, error: "preflight_error", message: msg }, { status: 500 });
    }
  }
  // Default GET lists candidates: registrations in VERIFIED status
  // with a BillingCycle in BANK_VERIFIED subscriptionStatus.
  const rows = await prisma.billingCycle.findMany({
    where: { subscriptionStatus: "BANK_VERIFIED" },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true, clubId: true, subscriptionStatus: true,
      stripePaymentIntentId: true, syntheticTestOnly: true, createdAt: true,
      releasedByOperatorRecord: {
        select: { signupRegistrationId: true },
      },
    },
  });
  const candidates = rows.map((r) => ({
    billingCycleId: r.id,
    clubId: r.clubId,
    signupRegistrationId: r.releasedByOperatorRecord?.signupRegistrationId ?? null,
    subscriptionStatus: r.subscriptionStatus,
    syntheticTestOnly: r.syntheticTestOnly,
    createdAt: r.createdAt,
  }));
  return NextResponse.json({ ok: true, candidates }, { status: 200 });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireOperator();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const action = String(body.action ?? "");
  try {
    switch (action) {
      case "record-commercial-auth": {
        const result = await recordCommercialAuthorisation({
          signupRegistrationId: String(body.signupRegistrationId ?? ""),
          commercialApprovedByUserId: auth.principalId,
          commercialApprovalNotes: typeof body.notes === "string" ? body.notes : undefined,
        });
        return NextResponse.json({ ok: true, ...result }, { status: 201 });
      }
      case "release": {
        const result = await authoriseAndReleaseFirstBilling({
          signupRegistrationId: String(body.signupRegistrationId ?? ""),
          billingCycleId: String(body.billingCycleId ?? ""),
          releaseApprovedByUserId: auth.principalId,
          releaseApprovalNotes: typeof body.releaseApprovalNotes === "string"
            ? body.releaseApprovalNotes
            : undefined,
          idempotencyScope: String(body.idempotencyScope ?? ""),
        });
        return NextResponse.json({ ok: true, ...result }, { status: 201 });
      }
      case "drain": {
        const result = await drainOneBillingCommand(String(body.commandId ?? ""));
        return NextResponse.json({ ok: true, ...result }, { status: 200 });
      }
      default:
        return NextResponse.json({ ok: false, error: `unknown action '${action}'` }, { status: 400 });
    }
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json(
        { ok: false, error: err.code, message: err.safeMessage },
        { status: err.httpStatus },
      );
    }
    const msg = err instanceof Error ? err.message : "unknown_error";
    return NextResponse.json({ ok: false, error: "service_error", message: msg }, { status: 500 });
  }
}
