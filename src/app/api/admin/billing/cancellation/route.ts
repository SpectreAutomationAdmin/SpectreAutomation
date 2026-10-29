// SIGNUP-2 M4-INT §2 (2026-10-29) -- Operator cancellation API.
//
// POST  { action: "request",      ... } -- operator A files a request.
// POST  { action: "authorize",    ... } -- operator B authorizes it.
// POST  { action: "reject",       ... } -- operator B refuses it.
// POST  { action: "schedule",     ... } -- enqueue the Stripe command.
// POST  { action: "reverse",      ... } -- reverse SCHEDULED before effective.
// GET   ?requestId=...                 -- read a single request.
// GET   ?state=...&clubId=...          -- list requests.
//
// Access:  SUPER_ADMIN only via `platform:signups:release`.
// Tenancy: cross-tenant refused by the service (ForbiddenError).
// Flag:    SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE must be ON for any
//          write action; service refuses otherwise.  GETs do not
//          require the flag -- read-only observability of existing
//          cancellation rows is always permitted.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { isAppError } from "@/lib/errors";
import {
  requestCancellation,
  authorizeCancellation,
  rejectCancellation,
  scheduleCancellation,
  reverseCancellation,
  evaluatePostCancellationAccess,
} from "@/lib/billing/signup-2m4-cancellation-service";

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
  const requestId = url.searchParams.get("requestId");
  if (requestId) {
    const row = await prisma.billingCancellationRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true, clubId: true, billingCycleId: true, state: true,
        requestedByUserId: true, requestedAt: true, requestReason: true,
        requestedEffectiveDate: true, authorizedByUserId: true, authorizedAt: true,
        approvedEffectiveDate: true, rejectedByUserId: true, rejectedAt: true,
        rejectionReason: true, scheduledCommandId: true, scheduledAt: true,
        stripeSubscriptionId: true, stripeCancelAt: true, actualEffectiveAt: true,
        reversedByUserId: true, reversedAt: true, reversalReason: true,
        validationEvidenceJson: true, syntheticTestOnly: true, createdAt: true,
      },
    });
    if (!row) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    const access = await evaluatePostCancellationAccess({ clubId: row.clubId });
    return NextResponse.json({ ok: true, request: row, access }, { status: 200 });
  }
  const state = url.searchParams.get("state") ?? undefined;
  const clubId = url.searchParams.get("clubId") ?? undefined;
  const rows = await prisma.billingCancellationRequest.findMany({
    where: {
      state: state ? { equals: state } : undefined,
      clubId: clubId ? { equals: clubId } : undefined,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true, clubId: true, billingCycleId: true, state: true,
      requestedByUserId: true, requestedAt: true, requestReason: true,
      approvedEffectiveDate: true, actualEffectiveAt: true,
      syntheticTestOnly: true, createdAt: true,
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
      case "request": {
        const result = await requestCancellation({
          clubId: String(body.clubId ?? ""),
          billingCycleId: String(body.billingCycleId ?? ""),
          requestedByUserId: auth.principalId,
          requestReason: String(body.requestReason ?? ""),
          requestedEffectiveDate: body.requestedEffectiveDate
            ? new Date(String(body.requestedEffectiveDate))
            : null,
        });
        return NextResponse.json({ ok: true, ...result }, { status: 201 });
      }
      case "authorize": {
        const approvedDate = new Date(String(body.approvedEffectiveDate ?? ""));
        const evidence = body.validationEvidence as {
          contractExecutionId?: string | null;
          noticeOk?: boolean;
          outstandingInvoiceIds?: string[];
          openExceptionIds?: string[];
          governanceReference?: string | null;
        } | undefined;
        const result = await authorizeCancellation({
          requestId: String(body.requestId ?? ""),
          authorizedByUserId: auth.principalId,
          authorizationNotes: typeof body.authorizationNotes === "string"
            ? body.authorizationNotes
            : undefined,
          approvedEffectiveDate: approvedDate,
          validationEvidence: {
            contractExecutionId: evidence?.contractExecutionId ?? null,
            noticeOk: evidence?.noticeOk === true,
            outstandingInvoiceIds: Array.isArray(evidence?.outstandingInvoiceIds)
              ? evidence!.outstandingInvoiceIds : [],
            openExceptionIds: Array.isArray(evidence?.openExceptionIds)
              ? evidence!.openExceptionIds : [],
            governanceReference: evidence?.governanceReference ?? null,
          },
        });
        return NextResponse.json({ ok: true, ...result }, { status: 200 });
      }
      case "reject": {
        const result = await rejectCancellation({
          requestId: String(body.requestId ?? ""),
          rejectedByUserId: auth.principalId,
          rejectionReason: String(body.rejectionReason ?? ""),
        });
        return NextResponse.json({ ok: true, ...result }, { status: 200 });
      }
      case "schedule": {
        const result = await scheduleCancellation(String(body.requestId ?? ""));
        return NextResponse.json({ ok: true, ...result }, { status: 200 });
      }
      case "reverse": {
        const result = await reverseCancellation({
          requestId: String(body.requestId ?? ""),
          reversedByUserId: auth.principalId,
          reversalReason: String(body.reversalReason ?? ""),
        });
        return NextResponse.json({ ok: true, ...result }, { status: 200 });
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
