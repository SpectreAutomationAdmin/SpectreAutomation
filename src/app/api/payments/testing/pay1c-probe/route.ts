// PAY-1C (2026-09-26) — read-only staging probe endpoint.
//
// Lets Playwright exercise deployed PAY-1C service functions against
// synthetic staging data without any financial mutation. Mirrors the
// PAY-1B.1 health-sample hook's guard shape:
//   • refuses when PAYMENTS_REAL_MONEY_ENABLED is true;
//   • requires payment:authorize;
//   • operates ONLY on read-only projections + a synthetic incident
//     row that carries no financial state.
//
// Supported scenarios:
//   canonical           — derive CanonicalRailInstruction[] for a runId.
//   correlate           — resolve an external endToEndId to
//                         PaymentInstruction/Run/PayrollBatch.
//   production-gate     — report the composite production-gate result.
//   limit-check         — evaluate configured limits against a runId
//                         (does not mutate; does not raise WI).
//   open-incident       — open a synthetic PaymentIncident with a
//                         detected-source label proving the deployed
//                         code path works. Never links to real runs
//                         unless the caller opts in with linkRunId.

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { realMoneyEnabled } from "@/lib/payments";
import {
  deriveCanonicalRailInstructions,
  correlateExternalReference,
  assertNoBankSecretsInCanonical,
} from "@/lib/payments/rail/canonical";
import {
  reportProductionGate,
  type ProductionGateInput,
} from "@/lib/payments/production-gate";
import { evaluatePaymentRunLimits } from "@/lib/payments/limits";
import {
  openIncident,
  linkIncidentEntities,
  appendIncidentAction,
  type PaymentIncidentCategory,
  type PaymentIncidentSeverity,
} from "@/lib/payments/incidents";
import { setConnectionStatus } from "@/lib/payments/provider/connection";
import { assertConnectionUsable } from "@/lib/payments/provider/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProbeBody {
  scenario?: string;
  clubId?: string;
  runId?: string;
  connectionId?: string;
  providerType?: string;
  endToEndId?: string;
  linkRunId?: string;
  linkConnectionId?: string;
  category?: PaymentIncidentCategory;
  severity?: PaymentIncidentSeverity;
  summary?: string;
  // PAY-1C.1 — synthetic limit config + containment.
  limitId?: string;
  limitKind?: "PER_INSTRUCTION" | "PER_RUN" | "DAILY_TENANT_TOTAL" | "CONNECTION" | "PAYMENT_TYPE";
  limitCurrency?: string;
  limitAmount?: string;
  limitPaymentType?: "PAYROLL" | "AP" | "REFUND";
  limitReason?: string;
  incidentId?: string;
  containNext?: "SUSPENDED" | "ACTIVE";
}

export async function POST(req: NextRequest) {
  if (realMoneyEnabled()) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as ProbeBody;
  if (!body.clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasPermission(principal, body.clubId, "payment:authorize")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    switch (body.scenario) {
      case "canonical": {
        if (!body.runId) return NextResponse.json({ error: "runId required" }, { status: 400 });
        const rows = await deriveCanonicalRailInstructions(body.runId);
        // Enforce no-secret invariant server-side (client cannot bypass).
        for (const r of rows) assertNoBankSecretsInCanonical(r);
        return NextResponse.json({ ok: true, count: rows.length, rows });
      }
      case "correlate": {
        if (!body.endToEndId) return NextResponse.json({ error: "endToEndId required" }, { status: 400 });
        const c = await correlateExternalReference(body.endToEndId);
        return NextResponse.json({ ok: true, correlation: c });
      }
      case "production-gate": {
        if (!body.connectionId || !body.runId || !body.providerType) {
          return NextResponse.json({ error: "connectionId + runId + providerType required" }, { status: 400 });
        }
        const input: ProductionGateInput = {
          clubId: body.clubId,
          providerType: body.providerType,
          connectionId: body.connectionId,
          runId: body.runId,
        };
        const report = await reportProductionGate(input);
        return NextResponse.json({ ok: true, report });
      }
      case "limit-check": {
        if (!body.runId || !body.providerType) {
          return NextResponse.json({ error: "runId + providerType required" }, { status: 400 });
        }
        const result = await evaluatePaymentRunLimits({
          clubId: body.clubId,
          providerType: body.providerType,
          runId: body.runId,
        });
        return NextResponse.json({ ok: true, result });
      }
      case "check-connection-usable": {
        // Wraps the PAY-1B `assertConnectionUsable` guard as a probe
        // so the staging spec can verify a contained connection would
        // refuse a submission without needing another authorized run.
        if (!body.connectionId) return NextResponse.json({ error: "connectionId required" }, { status: 400 });
        const conn = await prisma.paymentProviderConnection.findUnique({
          where: { id: body.connectionId },
          select: { clubId: true, status: true, environment: true },
        });
        if (!conn) return NextResponse.json({ error: "connection not found" }, { status: 404 });
        if (conn.clubId !== body.clubId) return NextResponse.json({ error: "tenant mismatch" }, { status: 403 });
        try {
          await assertConnectionUsable(body.connectionId);
          return NextResponse.json({ ok: true, usable: true, status: conn.status });
        } catch (err) {
          return NextResponse.json({ ok: true, usable: false, status: conn.status, reason: (err as Error).message });
        }
      }
      case "read-run": {
        // PAY-1C.1 · read-only snapshot used by staging spec to verify
        // preservation invariants after a limit refusal / incident.
        if (!body.runId) return NextResponse.json({ error: "runId required" }, { status: 400 });
        const run = await prisma.paymentRun.findUnique({
          where: { id: body.runId },
          select: {
            id: true, clubId: true, status: true, currency: true, totalAmount: true,
            paymentFingerprint: true, providerType: true, providerRunReference: true,
            authorizedAt: true, submittedAt: true, fullySettledAt: true,
          },
        });
        if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
        if (run.clubId !== body.clubId) return NextResponse.json({ error: "tenant mismatch" }, { status: 403 });
        const instructions = await prisma.paymentInstruction.findMany({
          where: { runId: body.runId },
          select: {
            id: true, status: true, amount: true, currency: true,
            destinationSnapshotId: true, providerInstructionId: true,
            submissionAttempts: true, settledAt: true, returnedAt: true,
          },
        });
        const auth = await prisma.paymentAuthorization.findFirst({
          where: { runId: body.runId },
          select: { id: true, status: true, paymentFingerprint: true, authorizedByUserId: true, authorizedAt: true, invalidatedAt: true, invalidatedReason: true },
        });
        const jeCount = await prisma.journalEntry.count({
          where: { clubId: body.clubId, source: "PAYMENTS", sourceEntityId: { in: instructions.map((i) => i.id) } },
        });
        return NextResponse.json({
          ok: true,
          run: { ...run, totalAmount: run.totalAmount.toString() },
          instructions: instructions.map((i) => ({ ...i, amount: i.amount.toString() })),
          authorization: auth,
          journalEntryCount: jeCount,
        });
      }
      case "find-work-intake": {
        // Return the most-recent open Work Intake exception for the tenant.
        const item = await prisma.workIntakeItem.findFirst({
          where: {
            clubId: body.clubId,
            workSubtype: { startsWith: "PAYMENT_EXCEPTION_" },
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, status: true, workSubtype: true, displaySubject: true, displayPreview: true, createdAt: true },
        });
        return NextResponse.json({ ok: true, item });
      }
      case "configure-limit": {
        // PAY-1C.1 · A — creates a synthetic ACTIVE PaymentLimit
        // scoped to `body.clubId`. Refused when real-money is on.
        // Cross-tenant enforcement: clubId is set from `body.clubId`
        // (already permission-checked above).
        if (!body.limitKind || !body.limitCurrency || !body.limitAmount) {
          return NextResponse.json({ error: "limitKind + limitCurrency + limitAmount required" }, { status: 400 });
        }
        const created = await prisma.paymentLimit.create({
          data: {
            clubId: body.clubId,
            providerType: null,
            kind: body.limitKind,
            paymentType: body.limitPaymentType ?? null,
            currency: body.limitCurrency,
            amountLimit: new Prisma.Decimal(body.limitAmount),
            status: "ACTIVE",
            reason: body.limitReason ?? "PAY-1C.1 acceptance",
          },
          select: { id: true, kind: true, amountLimit: true, currency: true, status: true, clubId: true },
        });
        return NextResponse.json({ ok: true, limit: {
          ...created,
          amountLimit: created.amountLimit.toString(),
        } });
      }
      case "retire-limit": {
        if (!body.limitId) return NextResponse.json({ error: "limitId required" }, { status: 400 });
        const existing = await prisma.paymentLimit.findUnique({
          where: { id: body.limitId },
          select: { clubId: true, status: true },
        });
        if (!existing) return NextResponse.json({ error: "limit not found" }, { status: 404 });
        if (existing.clubId && existing.clubId !== body.clubId) {
          return NextResponse.json({ error: "limit tenant mismatch" }, { status: 403 });
        }
        await prisma.paymentLimit.update({
          where: { id: body.limitId },
          data: { status: "RETIRED", effectiveUntil: new Date() },
        });
        return NextResponse.json({ ok: true, retiredLimitId: body.limitId });
      }
      case "contain-connection": {
        // PAY-1C.1 · C — invokes the LEGITIMATE
        // setConnectionStatus service (not a Prisma mutation) and
        // records the containment action on the linked incident's
        // timeline (append-only). Requires a same-tenant incident +
        // connection.
        if (!body.connectionId || !body.incidentId || !body.containNext) {
          return NextResponse.json({ error: "connectionId + incidentId + containNext required" }, { status: 400 });
        }
        const conn = await prisma.paymentProviderConnection.findUnique({
          where: { id: body.connectionId },
          select: { clubId: true },
        });
        if (!conn) return NextResponse.json({ error: "connection not found" }, { status: 404 });
        if (conn.clubId !== body.clubId) {
          return NextResponse.json({ error: "connection tenant mismatch" }, { status: 403 });
        }
        const inc = await prisma.paymentIncident.findUnique({
          where: { id: body.incidentId },
          select: { clubId: true },
        });
        if (!inc) return NextResponse.json({ error: "incident not found" }, { status: 404 });
        if (inc.clubId && inc.clubId !== body.clubId) {
          return NextResponse.json({ error: "incident tenant mismatch" }, { status: 403 });
        }
        // Legitimate containment action via existing PAY-1B service.
        await setConnectionStatus(principal, body.connectionId, body.containNext);
        // Record on incident timeline (append-only, per PAY-1C.1 §12).
        await appendIncidentAction(body.incidentId, {
          actor: principal.id,
          event: body.containNext === "SUSPENDED" ? "CONTAIN_CONNECTION" : "RESTORE_CONNECTION",
          note: `connectionId=${body.connectionId} status=${body.containNext}`,
        });
        return NextResponse.json({ ok: true, connectionId: body.connectionId, status: body.containNext });
      }
      case "open-incident": {
        if (!body.category || !body.severity || !body.summary) {
          return NextResponse.json({ error: "category + severity + summary required" }, { status: 400 });
        }
        const links: { entityType: "PAYMENT_RUN" | "PROVIDER_CONNECTION"; entityId: string }[] = [];
        if (body.linkRunId) {
          const owned = await prisma.paymentRun.findUnique({
            where: { id: body.linkRunId },
            select: { clubId: true },
          });
          if (owned && owned.clubId !== body.clubId) {
            return NextResponse.json({ error: "linkRunId cross-tenant" }, { status: 403 });
          }
          if (owned) links.push({ entityType: "PAYMENT_RUN", entityId: body.linkRunId });
        }
        if (body.linkConnectionId) {
          const owned = await prisma.paymentProviderConnection.findUnique({
            where: { id: body.linkConnectionId },
            select: { clubId: true },
          });
          if (owned && owned.clubId !== body.clubId) {
            return NextResponse.json({ error: "linkConnectionId cross-tenant" }, { status: 403 });
          }
          if (owned) links.push({ entityType: "PROVIDER_CONNECTION", entityId: body.linkConnectionId });
        }
        const { id, incidentNumber } = await openIncident({
          clubId: body.clubId,
          category: body.category,
          severity: body.severity,
          summary: body.summary,
          detectedByUserId: principal.id,
          detectedSource: "OPERATOR",
        });
        if (links.length) await linkIncidentEntities(id, links);
        return NextResponse.json({ ok: true, incidentId: id, incidentNumber });
      }
      default:
        return NextResponse.json({ error: `unknown scenario: ${body.scenario}` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
