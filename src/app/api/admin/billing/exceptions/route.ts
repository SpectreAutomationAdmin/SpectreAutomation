// SIGNUP-2 M4-INT-B §2 (2026-10-29) -- Operator API for billing
// exception management.
//
// GET  ?id=...                         read a single exception + linked rows.
// GET  ?state=open|all&clubId=&category=&severity=   list exceptions.
// POST { action: "acknowledge", id }               operator A ack.
// POST { action: "resolve", id, resolution, notes } record decision.
// POST { action: "escalate", id, escalationNotes }  re-open for action.
//
// Access:  SUPER_ADMIN only via `platform:signups:release`.
// Tenancy: service lookups scope by exception id -> billing cycle -> clubId;
//          operator can filter by clubId.
// Durability: no delete.  Historical financial evidence (refund /
//             dispute / returned debit / mandate invalidation /
//             renewal failure) stays on the row verbatim.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { isAppError } from "@/lib/errors";
import {
  acknowledgeException,
  recordExceptionResolution,
  escalateException,
  OPERATOR_RESOLUTIONS,
  type OperatorResolution,
} from "@/lib/billing/signup-2m4-exception-resolution";

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
  const id = url.searchParams.get("id");
  if (id) {
    const row = await prisma.billingExceptionCase.findUnique({
      where: { id },
      select: {
        id: true, billingCycleId: true, category: true, severity: true,
        stripeEventId: true, stripeResourceId: true, stripeResourceType: true,
        autoRecordedAt: true, autoRecordedPayloadJson: true,
        stripeBalanceTransactionId: true, balanceEffectAmountMinor: true,
        balanceEffectCurrency: true, balanceAvailableAt: true,
        requiresOperatorAction: true, operatorInboxEntryId: true,
        operatorAcknowledgedByUserId: true, operatorAcknowledgedAt: true,
        operatorResolution: true, operatorResolutionNotes: true,
        syntheticTestOnly: true, createdAt: true, updatedAt: true,
        billingCycle: {
          select: {
            clubId: true, subscriptionStatus: true, stripeSubscriptionId: true,
            stripePaymentIntentId: true,
          },
        },
      },
    });
    if (!row) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    const paymentAttempts = row.billingCycleId
      ? await prisma.billingInvoicePaymentAttempt.findMany({
          where: { billingCycleId: row.billingCycleId },
          orderBy: { attemptNumber: "asc" },
          take: 20,
          select: {
            id: true, stripeInvoiceId: true, stripePaymentIntentId: true,
            stripeChargeId: true, attemptNumber: true, attemptScheduledAt: true,
            attemptSettledAt: true, outcome: true,
          },
        })
      : [];
    return NextResponse.json({ ok: true, exception: row, paymentAttempts }, { status: 200 });
  }

  const state = url.searchParams.get("state") ?? "open";
  const clubId = url.searchParams.get("clubId");
  const category = url.searchParams.get("category");
  const severity = url.searchParams.get("severity");
  const whereBase: {
    billingCycle?: { clubId: string };
    category?: string;
    severity?: string;
    operatorAcknowledgedAt?: null;
    requiresOperatorAction?: boolean;
  } = {};
  if (clubId) whereBase.billingCycle = { clubId };
  if (category) whereBase.category = category;
  if (severity) whereBase.severity = severity;
  if (state === "open") {
    whereBase.operatorAcknowledgedAt = null;
    whereBase.requiresOperatorAction = true;
  }
  const rows = await prisma.billingExceptionCase.findMany({
    where: whereBase,
    orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
    take: 100,
    select: {
      id: true, billingCycleId: true, category: true, severity: true,
      stripeEventId: true, requiresOperatorAction: true,
      operatorAcknowledgedAt: true, operatorResolution: true,
      syntheticTestOnly: true, createdAt: true,
      billingCycle: { select: { clubId: true } },
    },
  });
  return NextResponse.json({ ok: true, rows }, { status: 200 });
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
      case "acknowledge": {
        const r = await acknowledgeException({
          exceptionId: String(body.id ?? ""),
          acknowledgedByUserId: auth.principalId,
        });
        return NextResponse.json({ ok: true, ...r }, { status: 200 });
      }
      case "resolve": {
        const resolution = String(body.resolution ?? "") as OperatorResolution;
        if (!OPERATOR_RESOLUTIONS.includes(resolution)) {
          return NextResponse.json({ ok: false, error: "invalid_resolution" }, { status: 400 });
        }
        await recordExceptionResolution({
          exceptionId: String(body.id ?? ""),
          resolvedByUserId: auth.principalId,
          resolution,
          resolutionNotes: String(body.notes ?? ""),
        });
        return NextResponse.json({ ok: true }, { status: 200 });
      }
      case "escalate": {
        await escalateException({
          exceptionId: String(body.id ?? ""),
          escalatedByUserId: auth.principalId,
          escalationNotes: String(body.escalationNotes ?? ""),
        });
        return NextResponse.json({ ok: true }, { status: 200 });
      }
      default:
        return NextResponse.json({ ok: false, error: `unknown action '${action}'` }, { status: 400 });
    }
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json(
        { ok: false, error: err.code, message: err.safeMessage },
        { status: err.status },
      );
    }
    const msg = err instanceof Error ? err.message : "unknown_error";
    return NextResponse.json({ ok: false, error: "service_error", message: msg }, { status: 500 });
  }
}
