// PAY-1A (2026-09-26) — PaymentRun service.

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { assertTenantOwned } from "@/lib/services/tenant";
import type { Principal } from "@/lib/rbac";
import { assertPaymentsEnabled } from "./kill-switch";
import { canTransitionRunState, type PaymentRunState, type PaymentSourceType } from "./types";
import { recordPaymentEvent } from "./events";

// Numeric sequence per (clubId, sourceType, year) - PR-YYYY-NNNNNN.
async function nextRunNumber(clubId: string, tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `PR-${year}-`;
  const latest = await tx.paymentRun.findFirst({
    where: { clubId, runNumber: { startsWith: prefix } },
    orderBy: { runNumber: "desc" },
    select: { runNumber: true },
  });
  const nextSeq = latest ? parseInt(latest.runNumber.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(nextSeq).padStart(6, "0");
}

export interface CreateRunInput {
  clubId: string;
  sourceType: PaymentSourceType;
  sourceId: string | null;
  sourceReference?: string | null;
  fundingBankAccountId: string;
  currency: string;
  requestedExecutionDate: Date;
  createdByUserId: string;
}

export async function createRun(
  principal: Principal,
  input: CreateRunInput,
  tx: Prisma.TransactionClient,
): Promise<{ id: string; runNumber: string }> {
  assertPaymentsEnabled();

  const bank = await tx.bankAccount.findFirst({
    where: { id: input.fundingBankAccountId, clubId: input.clubId },
    select: { id: true, clubId: true, status: true, currency: true },
  });
  if (!bank) throw new Error("PAY-1A: funding BankAccount not found or not owned by this tenant.");
  assertTenantOwned({ clubId: bank.clubId }, principal);
  if (bank.status !== "ACTIVE") {
    throw new Error(`PAY-1A: funding BankAccount is not ACTIVE (status=${bank.status}).`);
  }
  if (bank.currency !== input.currency) {
    throw new Error(`PAY-1A: currency mismatch — bank=${bank.currency} run=${input.currency}.`);
  }

  const runNumber = await nextRunNumber(input.clubId, tx);
  const run = await tx.paymentRun.create({
    data: {
      clubId: input.clubId,
      runNumber,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceReference: input.sourceReference ?? null,
      fundingBankAccountId: input.fundingBankAccountId,
      currency: input.currency,
      requestedExecutionDate: input.requestedExecutionDate,
      totalAmount: new Prisma.Decimal(0),
      status: "PREPARED",
      createdByUserId: input.createdByUserId,
      preparedAt: new Date(),
    },
    select: { id: true, runNumber: true },
  });
  await recordPaymentEvent(
    {
      clubId: input.clubId,
      runId: run.id,
      eventType: "PAYMENT_CREATED",
      newStatus: "PREPARED",
      actorUserId: input.createdByUserId,
      actorSource: "USER",
    },
    tx,
  );
  return run;
}

export async function transitionRunState(
  runId: string,
  from: PaymentRunState,
  to: PaymentRunState,
  actor: { userId?: string | null; source: "USER" | "PROVIDER" | "SYSTEM" },
  eventType: Parameters<typeof recordPaymentEvent>[0]["eventType"],
  tx: Prisma.TransactionClient,
  extra?: { providerReference?: string; meta?: Record<string, unknown> },
): Promise<void> {
  if (!canTransitionRunState(from, to)) {
    throw new Error(`PAY-1A: illegal PaymentRun transition ${from} → ${to}.`);
  }
  // CAS-style guard: only update if the current status is still `from`.
  const result = await tx.paymentRun.updateMany({
    where: { id: runId, status: from },
    data: { status: to, updatedAt: new Date() },
  });
  if (result.count === 0) {
    // Something else transitioned it first.
    const current = await tx.paymentRun.findUnique({ where: { id: runId }, select: { status: true, clubId: true } });
    throw new Error(`PAY-1A: race — PaymentRun ${runId} was already at ${current?.status}, expected ${from}.`);
  }
  const run = await tx.paymentRun.findUnique({ where: { id: runId }, select: { clubId: true } });
  await recordPaymentEvent(
    {
      clubId: run!.clubId,
      runId,
      eventType,
      previousStatus: from,
      newStatus: to,
      actorUserId: actor.userId ?? null,
      actorSource: actor.source,
      providerReference: extra?.providerReference,
      meta: extra?.meta,
    },
    tx,
  );
}
