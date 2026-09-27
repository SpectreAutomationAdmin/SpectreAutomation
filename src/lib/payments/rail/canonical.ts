// PAY-1C/2 (2026-09-26) — Rail-neutral canonical instruction model.
//
// PAY-1A owns the ECONOMIC PaymentInstruction (immutable authorized
// truth). PAY-1C introduces a TRANSPORT-FACING representation of that
// instruction: what an eventual real rail (AFT / ISO 20022 / RTR)
// message would need. It is derived from an authorized instruction —
// it is NEVER a second economic payment.
//
// Invariants:
//   1. A CanonicalRailInstruction is a projection of a
//      PaymentInstruction. There is exactly one economic instruction
//      per rail instruction, forever.
//   2. The endToEndId is deterministic and stable across retries and
//      technical representations. It never depends on mutable fields
//      like the recipient's display name.
//   3. Remittance information carries only what a Canadian rail
//      needs — payroll pay period, employee-safe reference. It NEVER
//      exposes SIN, unmasked bank details, or credentials.
//   4. No bank secrets leak. institutionSecretRef / transitSecretRef /
//      accountSecretRef stay on the destination snapshot. The
//      canonical projection carries only maskedIdentifier + destination
//      snapshot id for correlation.
//   5. Provider-specific batch formatting (AFT file, ISO 20022 pain.001)
//      is the concern of a FUTURE ADAPTER — this module produces
//      CanonicalRailInstruction[], never a formatted file.

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";

export type RemittancePurpose = "PAYROLL" | "AP" | "REFUND";

export interface PayrollRemittance {
  purpose: "PAYROLL";
  payGroupCode: string | null;
  payPeriodReference: string | null;
  payDate: string | null; // ISO date, no time zone
  employeeSafeReference: string; // employee.employeeNumber — NOT SIN
}

export interface ApRemittance {
  purpose: "AP";
  invoiceNumbers: string[];
  vendorSafeReference: string;
}

export interface RefundRemittance {
  purpose: "REFUND";
  reference: string;
}

export type CanonicalRemittance =
  | PayrollRemittance
  | ApRemittance
  | RefundRemittance;

// Rail-facing representation of an AUTHORIZED PaymentInstruction.
// Every field is deterministic given the instruction row.
export interface CanonicalRailInstruction {
  spectrePaymentInstructionId: string;
  spectrePaymentRunId: string;
  clubId: string;

  // Economic identity — untouched from the underlying instruction.
  amount: string; // Decimal-safe string (never number)
  currency: string;
  requestedExecutionDate: string; // ISO date

  // Debtor (funding side) — carried as reference, never with secrets.
  debtorFundingBankAccountId: string;
  debtorMaskedIdentifier: string;

  // Creditor (destination side) — carried as reference, never with secrets.
  creditorDestinationSnapshotId: string;
  creditorMaskedIdentifier: string;
  creditorRecipientType: string;
  creditorRecipientId: string;

  // Provider-visible correlation identity (stable across retries).
  endToEndId: string;

  // Rail purpose + remittance info.
  remittance: CanonicalRemittance;
}

// Deterministic endToEndId. Prefix `E2E-v1-` + SHA-256 over the
// stable economic identity components of the instruction — NOT over
// mutable columns like updatedAt. Same instruction ⇒ same endToEndId,
// forever.
export function computeEndToEndId(input: {
  clubId: string;
  paymentRunId: string;
  paymentInstructionId: string;
  destinationSnapshotId: string;
  amount: string;
  currency: string;
  requestedExecutionDate: string; // ISO date
}): string {
  const canonical = JSON.stringify([
    "E2E-v1",
    input.clubId,
    input.paymentRunId,
    input.paymentInstructionId,
    input.destinationSnapshotId,
    input.amount,
    input.currency,
    input.requestedExecutionDate,
  ]);
  const hex = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
  return `E2E-v1-${hex}`;
}

// Derive canonical rail representation for every AUTHORIZED
// instruction in a run. The run MUST be past AUTHORIZATION —
// pre-authorization requests are refused because the fingerprint
// is not yet frozen.
export async function deriveCanonicalRailInstructions(
  runId: string,
): Promise<CanonicalRailInstruction[]> {
  const run = await prisma.paymentRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      clubId: true,
      status: true,
      currency: true,
      requestedExecutionDate: true,
      fundingBankAccountId: true,
      sourceType: true,
      sourceId: true,
      sourceReference: true,
      fundingBankAccount: {
        select: { id: true, maskedIdentifier: true },
      },
      instructions: {
        select: {
          id: true,
          clubId: true,
          runId: true,
          amount: true,
          currency: true,
          requestedExecutionDate: true,
          destinationSnapshotId: true,
          recipientType: true,
          recipientId: true,
          sourceType: true,
          sourceReference: true,
          destinationSnapshot: {
            select: { id: true, maskedIdentifier: true },
          },
          status: true,
        },
      },
    },
  });
  if (!run) throw new Error(`PAY-1C: run not found ${runId}`);
  if (
    run.status === "PREPARED" ||
    run.status === "PENDING_AUTHORIZATION" ||
    run.status === "CANCELLED"
  ) {
    throw new Error(
      `PAY-1C: run ${runId} is not authorized (status=${run.status}) — cannot derive rail representation`,
    );
  }

  // Best-effort payroll enrichment. If the source is PAYROLL_BATCH, look
  // up pay group / pay period metadata WITHOUT exposing SIN or banking.
  const payrollMeta = await maybeLoadPayrollMeta(run.sourceType, run.sourceId ?? null);

  return run.instructions.map((inst): CanonicalRailInstruction => {
    const amount = inst.amount.toString();
    const requestedDate = inst.requestedExecutionDate.toISOString().slice(0, 10);
    const endToEndId = computeEndToEndId({
      clubId: inst.clubId,
      paymentRunId: run.id,
      paymentInstructionId: inst.id,
      destinationSnapshotId: inst.destinationSnapshotId,
      amount,
      currency: inst.currency,
      requestedExecutionDate: requestedDate,
    });
    return {
      spectrePaymentInstructionId: inst.id,
      spectrePaymentRunId: run.id,
      clubId: inst.clubId,
      amount,
      currency: inst.currency,
      requestedExecutionDate: requestedDate,
      debtorFundingBankAccountId: run.fundingBankAccount.id,
      debtorMaskedIdentifier: run.fundingBankAccount.maskedIdentifier,
      creditorDestinationSnapshotId: inst.destinationSnapshotId,
      creditorMaskedIdentifier: inst.destinationSnapshot.maskedIdentifier,
      creditorRecipientType: inst.recipientType,
      creditorRecipientId: inst.recipientId,
      endToEndId,
      remittance: buildRemittance(run.sourceType, inst, payrollMeta),
    };
  });
}

interface PayrollMeta {
  payGroupCode: string | null;
  payPeriodReference: string | null;
  payDate: string | null;
}

async function maybeLoadPayrollMeta(
  sourceType: string,
  sourceId: string | null,
): Promise<PayrollMeta | null> {
  if (sourceType !== "PAYROLL_BATCH" || !sourceId) return null;
  const batch = await prisma.payrollBatch.findUnique({
    where: { id: sourceId },
    select: {
      payGroup: { select: { code: true } },
      payPeriod: {
        select: {
          periodStart: true,
          periodEnd: true,
          payDate: true,
          taxYear: true,
          sequenceInYear: true,
        },
      },
    },
  });
  if (!batch) return null;
  const periodStart = batch.payPeriod.periodStart.toISOString().slice(0, 10);
  const periodEnd = batch.payPeriod.periodEnd.toISOString().slice(0, 10);
  return {
    payGroupCode: batch.payGroup.code,
    payPeriodReference: `${batch.payPeriod.taxYear}-${String(batch.payPeriod.sequenceInYear).padStart(3, "0")} ${periodStart}..${periodEnd}`,
    payDate: batch.payPeriod.payDate.toISOString().slice(0, 10),
  };
}

function buildRemittance(
  runSourceType: string,
  inst: {
    recipientType: string;
    recipientId: string;
    sourceReference: string | null;
  },
  payrollMeta: PayrollMeta | null,
): CanonicalRemittance {
  if (runSourceType === "PAYROLL_BATCH") {
    return {
      purpose: "PAYROLL",
      payGroupCode: payrollMeta?.payGroupCode ?? null,
      payPeriodReference: payrollMeta?.payPeriodReference ?? null,
      payDate: payrollMeta?.payDate ?? null,
      // employee.employeeNumber is a stable safe reference — never SIN.
      // We use recipientId here as a placeholder; a future adapter can
      // resolve it to Employee.employeeNumber. Present canonical form
      // deliberately does not embed SIN.
      employeeSafeReference: inst.sourceReference ?? inst.recipientId,
    };
  }
  return {
    purpose: "REFUND",
    reference: inst.sourceReference ?? inst.recipientId,
  };
}

// Correlation — given an external end-to-end reference on an
// acknowledgement or return, resolve deterministically back to the
// underlying PaymentInstruction/PaymentRun/PayrollBatch. Fuzzy
// matching is refused.
export interface RailCorrelation {
  endToEndId: string;
  paymentInstructionId: string;
  paymentRunId: string;
  clubId: string;
  payrollBatchId: string | null;
}

export async function correlateExternalReference(
  externalEndToEndId: string,
): Promise<RailCorrelation | null> {
  const instructions = await prisma.paymentInstruction.findMany({
    where: {
      status: { in: ["AUTHORIZED", "SCHEDULED", "SUBMITTING", "SUBMITTED", "ACCEPTED", "SETTLED", "REJECTED", "RETURNED"] },
    },
    select: {
      id: true,
      clubId: true,
      runId: true,
      amount: true,
      currency: true,
      requestedExecutionDate: true,
      destinationSnapshotId: true,
      run: { select: { id: true, sourceType: true, sourceId: true } },
    },
  });
  for (const inst of instructions) {
    const requestedDate = inst.requestedExecutionDate.toISOString().slice(0, 10);
    const candidate = computeEndToEndId({
      clubId: inst.clubId,
      paymentRunId: inst.runId,
      paymentInstructionId: inst.id,
      destinationSnapshotId: inst.destinationSnapshotId,
      amount: inst.amount.toString(),
      currency: inst.currency,
      requestedExecutionDate: requestedDate,
    });
    if (candidate === externalEndToEndId) {
      return {
        endToEndId: candidate,
        paymentInstructionId: inst.id,
        paymentRunId: inst.runId,
        clubId: inst.clubId,
        payrollBatchId:
          inst.run.sourceType === "PAYROLL_BATCH" ? inst.run.sourceId ?? null : null,
      };
    }
  }
  return null;
}

// Utility used by tests + the correlation UI.
export function assertNoBankSecretsInCanonical(x: CanonicalRailInstruction): void {
  const s = JSON.stringify(x);
  if (/institutionSecretRef|transitSecretRef|accountSecretRef/.test(s)) {
    throw new Error("PAY-1C: canonical rail projection leaked bank secret reference");
  }
}
