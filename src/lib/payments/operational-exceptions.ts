// PAY-1B/4 (2026-09-27) — Payments operational exceptions.
//
// A single service surfaces every provider-boundary condition that
// needs human attention into the existing Work Intake shell.
// Reused rather than building a new task queue.
//
// Exception kinds:
//   UNKNOWN_OUTCOME          — provider outcome cannot be safely interpreted
//   AMOUNT_MISMATCH          — provider settlement differs from authorized amount
//   CURRENCY_MISMATCH        — provider settlement currency mismatch
//   RETURN_REQUIRES_ACTION   — provider return needs Controller review
//   VERIFICATION_FAILURE     — external event verification failed
//   REFERENCE_COLLISION      — same providerInstructionId on multiple instructions
//   CONNECTION_DEGRADED      — provider health has crossed the failure threshold
//   RECONCILIATION_MISMATCH  — sum-of-instructions vs run mismatch

import { prisma } from "@/lib/prisma";

export type PaymentExceptionKind =
  | "UNKNOWN_OUTCOME"
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISMATCH"
  | "RETURN_REQUIRES_ACTION"
  | "VERIFICATION_FAILURE"
  | "REFERENCE_COLLISION"
  | "CONNECTION_DEGRADED"
  | "RECONCILIATION_MISMATCH";

export interface RaiseExceptionInput {
  clubId: string;
  kind: PaymentExceptionKind;
  paymentRunId?: string;
  paymentInstructionId?: string;
  externalEventId?: string;
  connectionId?: string;
  summary: string;
  detail?: string;
}

export async function raiseOperationalException(
  input: RaiseExceptionInput,
): Promise<{ workIntakeItemId: string }> {
  const item = await prisma.workIntakeItem.create({
    data: {
      clubId: input.clubId,
      status: "OPEN",
      judgmentRequired: true,
      displaySourceLabel: "Payments · Operational",
      displaySender: `Payments · ${input.kind}`,
      displaySubject: input.summary,
      displayPreview: input.detail ?? input.summary,
      displayReceivedAt: new Date(),
      workDomain: "PAYROLL",
      workIntent: "REVIEW",
      workSubtype: `PAYMENT_EXCEPTION_${input.kind}`,
    },
    select: { id: true },
  });
  return { workIntakeItemId: item.id };
}
