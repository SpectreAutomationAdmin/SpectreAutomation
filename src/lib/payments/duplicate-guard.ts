// PAY-1C/3 (2026-09-26) — Duplicate-business-payment guard.
//
// Distinct from PAY-1A's identity-level dedupe (which prevents two
// PaymentInstructions from carrying the same providerInstructionId).
//
// This guard prevents a distinct, accidental SECOND economic payment
// against the SAME source business object:
//
//   Same source (sourceType, sourceId, recipient) +
//   Same amount +
//   Same destination +
//   Recent window
//   ⇒ suspect duplicate, refuse authorization.
//
// Recurring legitimate payments (bi-weekly payroll for the same
// employee, month after month) are NOT blocked because the source
// identity (payrollBatchId) DIFFERS across runs, even when the amount
// and recipient are identical. Source identity is the critical
// discriminator.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface DuplicateCandidate {
  paymentRunId: string;
  paymentInstructionId: string;
  status: string;
  authorizedAt: Date | null;
  amount: string;
}

export interface DuplicateCheckInput {
  clubId: string;
  sourceType: string;
  sourceId: string | null;
  recipientType: string;
  recipientId: string;
  destinationSnapshotId: string;
  amount: string;
  currency: string;
  proposedRunId: string; // exclude this run from candidates
}

// Returns candidates that would represent duplicate economic payments.
// The caller decides whether to refuse or surface for review.
export async function findDuplicateEconomicPayments(
  input: DuplicateCheckInput,
): Promise<DuplicateCandidate[]> {
  // If no source identity, we cannot safely block — a recurring
  // legitimate payment must not be affected.
  if (!input.sourceId) return [];
  const candidates = await prisma.paymentInstruction.findMany({
    where: {
      clubId: input.clubId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      recipientType: input.recipientType,
      recipientId: input.recipientId,
      destinationSnapshotId: input.destinationSnapshotId,
      currency: input.currency,
      status: {
        in: [
          "AUTHORIZED",
          "SCHEDULED",
          "SUBMITTING",
          "SUBMITTED",
          "ACCEPTED",
          "SETTLED",
        ],
      },
      runId: { not: input.proposedRunId },
    },
    select: {
      id: true,
      runId: true,
      amount: true,
      status: true,
      authorizedAt: true,
    },
  });
  const proposedAmount = new Prisma.Decimal(input.amount);
  return candidates
    .filter((c) => new Prisma.Decimal(c.amount).equals(proposedAmount))
    .map((c) => ({
      paymentRunId: c.runId,
      paymentInstructionId: c.id,
      status: c.status,
      authorizedAt: c.authorizedAt,
      amount: c.amount.toString(),
    }));
}

export async function assertNoDuplicateEconomicPayment(
  input: DuplicateCheckInput,
): Promise<void> {
  const candidates = await findDuplicateEconomicPayments(input);
  if (candidates.length > 0) {
    throw new Error(
      `PAY-1C: suspected duplicate economic payment — same source ${input.sourceType}/${input.sourceId} + same recipient ${input.recipientType}/${input.recipientId} + same amount ${input.amount} ${input.currency}. Existing: ${candidates[0].paymentInstructionId} (status=${candidates[0].status}).`,
    );
  }
}
