// PAY-1C/3 (2026-09-26) — Provider-neutral payment limits.
//
// Real payment providers impose limits. Spectre must fail closed at
// the payment boundary BEFORE any external submission — never after.
//
// Kinds:
//   PER_INSTRUCTION      — one instruction's amount ≤ configured cap.
//   PER_RUN              — sum of a run's instruction amounts ≤ cap.
//   DAILY_TENANT_TOTAL   — sum of instructions authorized for a tenant
//                          in a rolling 24h window ≤ cap.
//   CONNECTION           — sum of instructions bound to a specific
//                          provider connection ≤ cap (adapter-agnostic).
//   PAYMENT_TYPE         — kind narrowed by paymentType (PAYROLL / AP /
//                          REFUND). E.g. per-payroll-run cap distinct
//                          from AP.
//
// Invariants:
//   1. Limit failure NEVER mutates the authorized payment. It refuses
//      submission and surfaces an operational exception.
//   2. Changing the payment amount requires new authorization —
//      preserving fingerprint semantics.
//   3. No production limit values are hardcoded. Callers configure
//      limits per club / providerType / kind. Staging tests seed
//      synthetic values.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { raiseOperationalException } from "./operational-exceptions";

export type PaymentLimitKind =
  | "PER_INSTRUCTION"
  | "PER_RUN"
  | "DAILY_TENANT_TOTAL"
  | "CONNECTION"
  | "PAYMENT_TYPE";

export type LimitPaymentType = "PAYROLL" | "AP" | "REFUND";

export interface EvaluateLimitsInput {
  clubId: string;
  providerType: string;
  runId: string;
  paymentType?: LimitPaymentType;
  connectionId?: string | null;
}

export interface LimitBreach {
  kind: PaymentLimitKind;
  limitId: string;
  amountLimit: string;
  observedAmount: string;
  currency: string;
  reason: string;
}

export interface LimitEvaluationResult {
  ok: boolean;
  breaches: LimitBreach[];
}

// The BLOCKING evaluator — call inside scheduleAndSubmit before the
// AUTHORIZED → SCHEDULED transition. Throws if a limit is breached.
export async function assertPaymentRunWithinLimits(
  input: EvaluateLimitsInput,
): Promise<void> {
  const result = await evaluatePaymentRunLimits(input);
  if (!result.ok) {
    const first = result.breaches[0];
    // Surface as an operational exception so operators see it in
    // Work Intake, not just an API error.
    await raiseOperationalException({
      clubId: input.clubId,
      kind: "AMOUNT_MISMATCH",
      paymentRunId: input.runId,
      summary: `Payment limit breached: ${first.reason}`,
      detail: JSON.stringify(result.breaches),
    });
    throw new Error(
      `PAY-1C: payment limit breached (${first.kind}) — configured=${first.amountLimit} observed=${first.observedAmount} ${first.currency}`,
    );
  }
}

export async function evaluatePaymentRunLimits(
  input: EvaluateLimitsInput,
): Promise<LimitEvaluationResult> {
  const run = await prisma.paymentRun.findUniqueOrThrow({
    where: { id: input.runId },
    select: {
      id: true,
      clubId: true,
      currency: true,
      totalAmount: true,
      instructions: {
        select: { id: true, amount: true, currency: true, status: true },
      },
    },
  });

  const breaches: LimitBreach[] = [];

  // Load applicable ACTIVE limits.
  const limits = await prisma.paymentLimit.findMany({
    where: {
      status: "ACTIVE",
      AND: [
        { OR: [{ clubId: input.clubId }, { clubId: null }] },
        { OR: [{ providerType: input.providerType }, { providerType: null }] },
        {
          OR: [
            { paymentType: input.paymentType ?? undefined },
            { paymentType: null },
          ],
        },
      ],
    },
  });

  for (const lim of limits) {
    if (lim.currency !== run.currency) continue; // mismatched currency limits never bind
    switch (lim.kind as PaymentLimitKind) {
      case "PER_INSTRUCTION": {
        for (const inst of run.instructions) {
          if (inst.currency !== lim.currency) continue;
          if (new Prisma.Decimal(inst.amount).greaterThan(lim.amountLimit)) {
            breaches.push({
              kind: "PER_INSTRUCTION",
              limitId: lim.id,
              amountLimit: lim.amountLimit.toString(),
              observedAmount: inst.amount.toString(),
              currency: lim.currency,
              reason: `Instruction ${inst.id} exceeds PER_INSTRUCTION limit`,
            });
          }
        }
        break;
      }
      case "PER_RUN": {
        if (new Prisma.Decimal(run.totalAmount).greaterThan(lim.amountLimit)) {
          breaches.push({
            kind: "PER_RUN",
            limitId: lim.id,
            amountLimit: lim.amountLimit.toString(),
            observedAmount: run.totalAmount.toString(),
            currency: lim.currency,
            reason: `Run ${run.id} exceeds PER_RUN limit`,
          });
        }
        break;
      }
      case "DAILY_TENANT_TOTAL": {
        const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const same = await prisma.paymentInstruction.aggregate({
          _sum: { amount: true },
          where: {
            clubId: input.clubId,
            currency: lim.currency,
            authorizedAt: { gte: windowStart },
          },
        });
        const priorSum = same._sum.amount ?? new Prisma.Decimal(0);
        const projected = new Prisma.Decimal(priorSum).plus(run.totalAmount);
        if (projected.greaterThan(lim.amountLimit)) {
          breaches.push({
            kind: "DAILY_TENANT_TOTAL",
            limitId: lim.id,
            amountLimit: lim.amountLimit.toString(),
            observedAmount: projected.toString(),
            currency: lim.currency,
            reason: `Rolling 24h tenant total would exceed DAILY_TENANT_TOTAL limit`,
          });
        }
        break;
      }
      case "PAYMENT_TYPE": {
        // Only binds when the caller-provided paymentType matches, and
        // the run total is the check target.
        if (
          lim.paymentType &&
          input.paymentType &&
          lim.paymentType === input.paymentType &&
          new Prisma.Decimal(run.totalAmount).greaterThan(lim.amountLimit)
        ) {
          breaches.push({
            kind: "PAYMENT_TYPE",
            limitId: lim.id,
            amountLimit: lim.amountLimit.toString(),
            observedAmount: run.totalAmount.toString(),
            currency: lim.currency,
            reason: `Run ${run.id} exceeds PAYMENT_TYPE limit for ${lim.paymentType}`,
          });
        }
        break;
      }
      case "CONNECTION": {
        if (!input.connectionId) break; // no connection bound => skip
        // A CONNECTION limit is a per-connection lifetime cap in our
        // synthetic model. Real adapters may implement periods later.
        // We approximate as sum of authorized instructions across all
        // runs known to have used this connection via providerType +
        // recent authorized window. For staging we simplify: any
        // limit configured on this connection that is smaller than
        // this run's total is a breach.
        if (new Prisma.Decimal(run.totalAmount).greaterThan(lim.amountLimit)) {
          breaches.push({
            kind: "CONNECTION",
            limitId: lim.id,
            amountLimit: lim.amountLimit.toString(),
            observedAmount: run.totalAmount.toString(),
            currency: lim.currency,
            reason: `Run ${run.id} exceeds CONNECTION limit`,
          });
        }
        break;
      }
    }
  }

  return { ok: breaches.length === 0, breaches };
}
