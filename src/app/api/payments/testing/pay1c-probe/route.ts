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
  type PaymentIncidentCategory,
  type PaymentIncidentSeverity,
} from "@/lib/payments/incidents";

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
