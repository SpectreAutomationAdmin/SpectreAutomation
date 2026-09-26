// PAY-1A/4 (2026-09-26) — Settlement + return accounting.
//
// Rules:
//   • Authorization does NOT affect cash.
//   • Scheduling does NOT affect cash.
//   • Submission does NOT affect cash.
//   • SETTLEMENT of an instruction produces:
//       DR PayrollGlAccountingProfile.netPayPayableAccount
//       CR BankAccount.glAccount
//   • The settlement journal is created once per PaymentRun. When
//     additional instructions in the same run settle later, additional
//     lines are ADDED to the existing journal (idempotent).
//     Actually simpler: we create a single balanced journal per
//     instruction event, linked by sourceEntityType="PaymentRun",
//     sourceEntityId=runId. Multiple JEs per run are permitted.
//   • RETURN of a settled instruction produces:
//       DR BankAccount.glAccount
//       CR netPayPayableAccount
//     (restores the payable; payroll expense is untouched.)
//   • Settlement retry does NOT duplicate. Idempotency: per-instruction,
//     we refuse to create a settlement JE if the instruction already
//     has `settledAt`. Return retry refuses if `returnedAt`.

import { Prisma } from "@prisma/client";
import { recordPaymentEvent } from "./events";
import type { PaymentSourceType } from "./types";

interface ResolvedRun {
  id: string;
  clubId: string;
  currency: string;
  sourceType: PaymentSourceType;
  sourceId: string | null;
  fundingBankAccount: { id: string; glAccountId: string };
}

interface ResolvedInstruction {
  id: string;
  clubId: string;
  amount: Prisma.Decimal;
  settledAt: Date | null;
  returnedAt: Date | null;
  recipientId: string;
}

// -----------------------------------------------------------------
// Resolve the payable-side GL account for a source.
// PAY-1A supports PAYROLL only.
// -----------------------------------------------------------------
async function resolvePayableAccountId(
  tx: Prisma.TransactionClient,
  clubId: string,
  sourceType: PaymentSourceType,
): Promise<string> {
  if (sourceType === "PAYROLL") {
    const profile = await tx.payrollGlAccountingProfile.findUnique({
      where: { clubId },
      select: { netPayPayableAccountId: true },
    });
    if (!profile) throw new Error("PAY-1A: PayrollGlAccountingProfile missing for club.");
    return profile.netPayPayableAccountId;
  }
  throw new Error(`PAY-1A: payable-account resolution for source ${sourceType} not implemented.`);
}

// -----------------------------------------------------------------
// Find (or fail) an OPEN FiscalPeriod for the given date.
// -----------------------------------------------------------------
async function resolvePeriodId(
  tx: Prisma.TransactionClient,
  clubId: string,
  onDate: Date,
): Promise<string> {
  const period = await tx.fiscalPeriod.findFirst({
    where: {
      clubId,
      startDate: { lte: onDate },
      endDate: { gt: onDate },
      status: { not: "CLOSED" },
    },
    select: { id: true },
    orderBy: { startDate: "desc" },
  });
  if (!period) throw new Error("PAY-1A: no open FiscalPeriod covers the settlement date.");
  return period.id;
}

// -----------------------------------------------------------------
// Allocate the next JE number for a Club.
// -----------------------------------------------------------------
async function nextEntryNumber(tx: Prisma.TransactionClient, clubId: string, year: number): Promise<string> {
  const prefix = `JE-${year}-`;
  const latest = await tx.journalEntry.findFirst({
    where: { clubId, entryNumber: { startsWith: prefix } },
    orderBy: { entryNumber: "desc" },
    select: { entryNumber: true },
  });
  const next = latest ? parseInt(latest.entryNumber.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(next).padStart(6, "0");
}

// -----------------------------------------------------------------
// Record a settlement event: creates one balanced JE for the instruction.
// -----------------------------------------------------------------
export async function recordInstructionSettlement(
  tx: Prisma.TransactionClient,
  run: ResolvedRun,
  instruction: ResolvedInstruction,
  settledAt: Date,
): Promise<{ journalEntryId: string }> {
  if (instruction.settledAt) {
    throw new Error(`PAY-1A: instruction ${instruction.id} already settled at ${instruction.settledAt.toISOString()}.`);
  }
  const payableAccountId = await resolvePayableAccountId(tx, run.clubId, run.sourceType);
  const periodId = await resolvePeriodId(tx, run.clubId, settledAt);
  const entryNumber = await nextEntryNumber(tx, run.clubId, settledAt.getFullYear());

  const je = await tx.journalEntry.create({
    data: {
      clubId: run.clubId,
      entryNumber,
      entryDate: settledAt,
      periodId,
      description: `PAY-1A settlement · instruction ${instruction.id.slice(-8)}`,
      source: "PAYMENTS",
      sourceEntityType: "PaymentInstruction",
      sourceEntityId: instruction.id,
      status: "POSTED",
      postedAt: settledAt,
      totalDebits: instruction.amount,
      totalCredits: instruction.amount,
      lines: {
        create: [
          {
            clubId: run.clubId, accountId: payableAccountId, lineNumber: 1,
            debit: instruction.amount, credit: new Prisma.Decimal(0),
            description: `Net pay settlement`,
          },
          {
            clubId: run.clubId, accountId: run.fundingBankAccount.glAccountId, lineNumber: 2,
            debit: new Prisma.Decimal(0), credit: instruction.amount,
            description: `Cash disbursement`,
          },
        ],
      },
    },
    select: { id: true },
  });

  await tx.paymentInstruction.update({
    where: { id: instruction.id },
    data: { settledAt, status: "SETTLED" },
  });

  await recordPaymentEvent(
    {
      clubId: run.clubId,
      runId: run.id,
      instructionId: instruction.id,
      eventType: "PAYMENT_SETTLED",
      newStatus: "SETTLED",
      actorSource: "PROVIDER",
      meta: { journalEntryId: je.id, amount: instruction.amount.toFixed(2) },
    },
    tx,
  );
  return { journalEntryId: je.id };
}

// -----------------------------------------------------------------
// Record a return event: creates the reverse JE + updates instruction.
// -----------------------------------------------------------------
export async function recordInstructionReturn(
  tx: Prisma.TransactionClient,
  run: ResolvedRun,
  instruction: ResolvedInstruction,
  returnedAt: Date,
  returnCode: string,
  returnDescription: string,
): Promise<{ journalEntryId: string }> {
  if (!instruction.settledAt) {
    throw new Error("PAY-1A: cannot return an instruction that never settled.");
  }
  if (instruction.returnedAt) {
    throw new Error(`PAY-1A: instruction ${instruction.id} already returned at ${instruction.returnedAt.toISOString()}.`);
  }
  const payableAccountId = await resolvePayableAccountId(tx, run.clubId, run.sourceType);
  const periodId = await resolvePeriodId(tx, run.clubId, returnedAt);
  const entryNumber = await nextEntryNumber(tx, run.clubId, returnedAt.getFullYear());

  const je = await tx.journalEntry.create({
    data: {
      clubId: run.clubId,
      entryNumber,
      entryDate: returnedAt,
      periodId,
      description: `PAY-1A return · instruction ${instruction.id.slice(-8)} · ${returnCode}`,
      source: "PAYMENTS",
      sourceEntityType: "PaymentInstruction",
      sourceEntityId: instruction.id,
      status: "POSTED",
      postedAt: returnedAt,
      totalDebits: instruction.amount,
      totalCredits: instruction.amount,
      lines: {
        create: [
          {
            clubId: run.clubId, accountId: run.fundingBankAccount.glAccountId, lineNumber: 1,
            debit: instruction.amount, credit: new Prisma.Decimal(0),
            description: `Cash restored on payment return`,
          },
          {
            clubId: run.clubId, accountId: payableAccountId, lineNumber: 2,
            debit: new Prisma.Decimal(0), credit: instruction.amount,
            description: `Net pay payable restored`,
          },
        ],
      },
    },
    select: { id: true },
  });

  await tx.paymentInstruction.update({
    where: { id: instruction.id },
    data: {
      returnedAt, status: "RETURNED",
      returnCode, returnDescription,
    },
  });

  await recordPaymentEvent(
    {
      clubId: run.clubId,
      runId: run.id,
      instructionId: instruction.id,
      eventType: "PAYMENT_RETURNED",
      newStatus: "RETURNED",
      actorSource: "PROVIDER",
      providerReference: returnCode,
      meta: { journalEntryId: je.id, returnCode, returnDescription, amount: instruction.amount.toFixed(2) },
    },
    tx,
  );
  return { journalEntryId: je.id };
}
