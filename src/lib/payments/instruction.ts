// PAY-1A (2026-09-26) — PaymentInstruction service.
//
// Invariants:
//   • Instructions are created in PREPARED state alongside their Run.
//   • Once AUTHORIZED, material fields (amount, recipient, destination,
//     execution date, fundingBankAccountId at the Run level) MUST NOT
//     mutate. See `assertMaterialFieldsUnchanged`.
//   • Reconciliation: SUM(amounts) must equal the source's frozen
//     liability. See `assertRunReconciles`.

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { instructionFingerprint } from "./fingerprint";
import type {
  PaymentSourceType,
  RecipientType,
  PaymentInstructionMaterialFields,
} from "./types";

export interface CreateInstructionInput {
  clubId: string;
  runId: string;
  sourceType: PaymentSourceType;
  sourceId: string | null;
  sourceReference?: string | null;
  recipientType: RecipientType;
  recipientId: string;
  amount: string;              // Decimal-safe
  currency: string;
  destinationSnapshotId: string;
  requestedExecutionDate: Date;
  fundingBankAccountId: string; // for fingerprint only
}

export async function createInstruction(
  input: CreateInstructionInput,
  tx: Prisma.TransactionClient,
): Promise<{ id: string; instructionFingerprint: string }> {
  const material: PaymentInstructionMaterialFields = {
    clubId: input.clubId,
    runId: input.runId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    recipientType: input.recipientType,
    recipientId: input.recipientId,
    amount: input.amount,
    currency: input.currency,
    destinationSnapshotId: input.destinationSnapshotId,
    requestedExecutionDate: input.requestedExecutionDate.toISOString(),
    fundingBankAccountId: input.fundingBankAccountId,
  };
  const fp = instructionFingerprint(material);

  const row = await tx.paymentInstruction.create({
    data: {
      clubId: input.clubId,
      runId: input.runId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceReference: input.sourceReference ?? null,
      recipientType: input.recipientType,
      recipientId: input.recipientId,
      amount: new Prisma.Decimal(input.amount),
      currency: input.currency,
      destinationSnapshotId: input.destinationSnapshotId,
      requestedExecutionDate: input.requestedExecutionDate,
      status: "PREPARED",
      instructionFingerprint: fp,
    },
    select: { id: true, instructionFingerprint: true },
  });
  return row;
}

// Exact Decimal-safe reconciliation. Throws if totals differ by any
// non-zero minor unit.
export function assertReconciles(
  expected: Prisma.Decimal | string,
  actual: Prisma.Decimal | string,
): void {
  const e = expected instanceof Prisma.Decimal ? expected : new Prisma.Decimal(expected);
  const a = actual instanceof Prisma.Decimal ? actual : new Prisma.Decimal(actual);
  if (!e.eq(a)) {
    throw new Error(
      `PAY-1A: reconciliation failed — expected ${e.toFixed(2)}, actual ${a.toFixed(2)}, delta ${e.minus(a).toFixed(2)}.`,
    );
  }
}

// Refuses any post-authorization mutation to material fields.
// Callers pass the current stored row and the incoming candidate;
// this function throws on ANY difference in the frozen set.
export function assertMaterialFieldsUnchanged(
  current: PaymentInstructionMaterialFields,
  candidate: PaymentInstructionMaterialFields,
): void {
  const keys: (keyof PaymentInstructionMaterialFields)[] = [
    "clubId", "runId", "sourceType", "sourceId",
    "recipientType", "recipientId",
    "amount", "currency",
    "destinationSnapshotId",
    "requestedExecutionDate",
    "fundingBankAccountId",
  ];
  const changed: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(current[k]) !== JSON.stringify(candidate[k])) changed.push(k);
  }
  if (changed.length) {
    throw new Error(
      `PAY-1A: refusing to mutate authorized PaymentInstruction — material fields changed: ${changed.join(", ")}. ` +
        `Cancel + supersede with a new instruction and new authorization.`,
    );
  }
}
