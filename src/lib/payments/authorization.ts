// PAY-1A/3 (2026-09-26) — Authorization + Work Intake integration.
//
// Flow:
//   PREPARED --submitForAuthorization()--> PENDING_AUTHORIZATION
//              creates one WorkIntakeItem (workDomain=PAYROLL, subtype=PAYMENT_AUTHORIZATION)
//   PENDING_AUTHORIZATION --authorizePaymentRun()--> AUTHORIZED
//              freezes paymentFingerprint + snapshotJson,
//              writes PaymentAuthorization row, resolves the Work Intake item.
//   PENDING_AUTHORIZATION --returnPaymentRun(reason)--> PREPARED
//              records PAYMENT_RETURNED_FOR_CHANGES; run may be re-submitted.
//   Any material mutation of run/instructions (post-authorization) MUST
//   call invalidateAuthorization().
//
// Segregation of duties:
//   • The user who called preparePayrollPayments (`run.createdByUserId`)
//     may NOT authorize the same run. Enforced independently of
//     whether the user technically holds both perms.

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/rbac";
import { assertTenantOwned } from "@/lib/services/tenant";
import type { Principal } from "@/lib/rbac";
import { assertPaymentsEnabled } from "./kill-switch";
import { transitionRunState } from "./run";
import { recordPaymentEvent } from "./events";
import { paymentFingerprint } from "./fingerprint";
import type {
  PaymentRunMaterialFields,
  PaymentSourceType,
} from "./types";

// ------------------------------------------------------------------
// Submit for authorization → PENDING_AUTHORIZATION.
// ------------------------------------------------------------------
export async function submitForAuthorization(
  principal: Principal,
  runId: string,
): Promise<{ workIntakeItemId: string }> {
  assertPaymentsEnabled();

  return prisma.$transaction(async (tx) => {
    const run = await tx.paymentRun.findUnique({
      where: { id: runId },
      select: {
        id: true, clubId: true, status: true, runNumber: true,
        sourceType: true, sourceId: true, currency: true,
        totalAmount: true, requestedExecutionDate: true, instructionCount: true,
        createdByUserId: true, workIntakeItemId: true,
      },
    });
    if (!run) throw new Error("PAY-1A: PaymentRun not found.");
    assertTenantOwned({ clubId: run.clubId }, principal);
    requirePermission(principal, run.clubId, "payment:prepare");

    if (run.status !== "PREPARED") {
      throw new Error(`PAY-1A: run must be PREPARED to submit; current=${run.status}`);
    }
    if (run.workIntakeItemId) {
      throw new Error("PAY-1A: run already has an associated Work Intake item; cannot re-submit.");
    }

    const wi = await tx.workIntakeItem.create({
      data: {
        clubId: run.clubId,
        status: "OPEN",
        judgmentRequired: true,
        displaySourceLabel: "Payments",
        displaySender: `PaymentRun ${run.runNumber}`,
        displaySubject: `Authorize payment run ${run.runNumber}`,
        displayPreview:
          `${run.instructionCount} recipients · ` +
          `${new Prisma.Decimal(run.totalAmount).toFixed(2)} ${run.currency} · ` +
          `execute ${run.requestedExecutionDate.toISOString().slice(0, 10)}`,
        displayReceivedAt: new Date(),
        workDomain: "PAYROLL",
        workIntent: "APPROVE",
        workSubtype: "PAYMENT_AUTHORIZATION",
      },
    });

    await tx.paymentRun.update({
      where: { id: runId },
      data: { workIntakeItemId: wi.id },
    });
    await transitionRunState(
      runId, "PREPARED", "PENDING_AUTHORIZATION",
      { userId: principal.id, source: "USER" },
      "PAYMENT_SUBMITTED_FOR_AUTHORIZATION",
      tx,
      { meta: { workIntakeItemId: wi.id } },
    );
    return { workIntakeItemId: wi.id };
  });
}

// ------------------------------------------------------------------
// Return-for-changes → PREPARED (from PENDING_AUTHORIZATION).
// ------------------------------------------------------------------
export async function returnPaymentRun(
  principal: Principal,
  runId: string,
  reason: string,
): Promise<void> {
  assertPaymentsEnabled();
  if (!reason || reason.trim().length === 0) {
    throw new Error("PAY-1A: return requires a reason.");
  }

  return prisma.$transaction(async (tx) => {
    const run = await tx.paymentRun.findUnique({
      where: { id: runId },
      select: { id: true, clubId: true, status: true, workIntakeItemId: true },
    });
    if (!run) throw new Error("PAY-1A: PaymentRun not found.");
    assertTenantOwned({ clubId: run.clubId }, principal);
    requirePermission(principal, run.clubId, "payment:authorize");

    if (run.status !== "PENDING_AUTHORIZATION") {
      throw new Error(`PAY-1A: run must be PENDING_AUTHORIZATION to return; current=${run.status}`);
    }

    if (run.workIntakeItemId) {
      await tx.workIntakeItem.update({
        where: { id: run.workIntakeItemId },
        data: {
          status: "OPEN",
          resolvedAt: null,
          resolvedByUserId: null,
        },
      });
    }
    // Detach the WI so the next re-submit creates a fresh one.
    await tx.paymentRun.update({
      where: { id: runId },
      data: { workIntakeItemId: null },
    });
    await transitionRunState(
      runId, "PENDING_AUTHORIZATION", "PREPARED",
      { userId: principal.id, source: "USER" },
      "PAYMENT_RETURNED_FOR_CHANGES",
      tx,
      { meta: { reason } },
    );
  });
}

// ------------------------------------------------------------------
// Authorize → AUTHORIZED.
// ------------------------------------------------------------------
export async function authorizePaymentRun(
  principal: Principal,
  runId: string,
): Promise<{ authorizationId: string; paymentFingerprint: string }> {
  assertPaymentsEnabled();

  return prisma.$transaction(async (tx) => {
    const run = await tx.paymentRun.findUnique({
      where: { id: runId },
      select: {
        id: true, clubId: true, status: true, runNumber: true,
        sourceType: true, sourceId: true,
        fundingBankAccountId: true, currency: true,
        requestedExecutionDate: true, totalAmount: true,
        createdByUserId: true, workIntakeItemId: true,
      },
    });
    if (!run) throw new Error("PAY-1A: PaymentRun not found.");
    assertTenantOwned({ clubId: run.clubId }, principal);
    requirePermission(principal, run.clubId, "payment:authorize");

    if (run.status !== "PENDING_AUTHORIZATION") {
      throw new Error(`PAY-1A: run must be PENDING_AUTHORIZATION to authorize; current=${run.status}`);
    }
    // SoD: the preparer may NOT authorize the same run, even if they
    // technically hold both permissions.
    if (run.createdByUserId === principal.id) {
      throw new Error(
        "PAY-1A: maker/checker violation — the user who prepared this run may not authorize it.",
      );
    }

    // Freeze the fingerprint from the current authorized material state.
    const instructions = await tx.paymentInstruction.findMany({
      where: { runId },
      select: {
        instructionFingerprint: true, amount: true, recipientType: true, recipientId: true,
        destinationSnapshotId: true, requestedExecutionDate: true,
      },
      orderBy: [{ recipientType: "asc" }, { recipientId: "asc" }],
    });
    const runMaterial: PaymentRunMaterialFields = {
      clubId: run.clubId,
      runNumber: run.runNumber,
      sourceType: run.sourceType as PaymentSourceType,
      sourceId: run.sourceId,
      fundingBankAccountId: run.fundingBankAccountId,
      currency: run.currency,
      requestedExecutionDate: run.requestedExecutionDate.toISOString(),
      totalAmount: new Prisma.Decimal(run.totalAmount).toFixed(2),
      instructionFingerprints: instructions.map((i) => i.instructionFingerprint),
    };
    const fp = paymentFingerprint(runMaterial);

    // Snapshot for forensic reconstruction.
    const snapshotJson = JSON.stringify({
      runMaterial,
      instructionCount: instructions.length,
      snapshotAt: new Date().toISOString(),
    });

    const auth = await tx.paymentAuthorization.create({
      data: {
        clubId: run.clubId,
        runId,
        authorizedByUserId: principal.id,
        paymentFingerprint: fp,
        snapshotJson,
        status: "ACTIVE",
      },
      select: { id: true },
    });

    // Update the run's authorization fields.
    await tx.paymentRun.update({
      where: { id: runId },
      data: {
        paymentFingerprint: fp,
        authorizedAt: new Date(),
        authorizedByUserId: principal.id,
      },
    });

    // Flip instructions to AUTHORIZED.
    await tx.paymentInstruction.updateMany({
      where: { runId, status: "PREPARED" },
      data: { status: "AUTHORIZED", authorizedAt: new Date() },
    });

    // Resolve Work Intake.
    if (run.workIntakeItemId) {
      await tx.workIntakeItem.update({
        where: { id: run.workIntakeItemId },
        data: { status: "RESOLVED", resolvedAt: new Date(), resolvedByUserId: principal.id },
      });
    }

    await transitionRunState(
      runId, "PENDING_AUTHORIZATION", "AUTHORIZED",
      { userId: principal.id, source: "USER" },
      "PAYMENT_AUTHORIZED",
      tx,
      { meta: { paymentFingerprint: fp, authorizationId: auth.id } },
    );

    return { authorizationId: auth.id, paymentFingerprint: fp };
  });
}

// ------------------------------------------------------------------
// Invalidate authorization — called whenever a material mutation
// occurs on an already-authorized run. Marks the PaymentAuthorization
// row INVALIDATED and records an AUTHORIZATION_INVALIDATED event.
// ------------------------------------------------------------------
export async function invalidateAuthorization(
  runId: string,
  reason: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const auth = await tx.paymentAuthorization.findUnique({
    where: { runId },
    select: { id: true, clubId: true, status: true },
  });
  if (!auth || auth.status !== "ACTIVE") return;
  await tx.paymentAuthorization.update({
    where: { id: auth.id },
    data: { status: "INVALIDATED", invalidatedAt: new Date(), invalidatedReason: reason },
  });
  await recordPaymentEvent(
    {
      clubId: auth.clubId,
      runId,
      eventType: "AUTHORIZATION_INVALIDATED",
      actorSource: "SYSTEM",
      meta: { reason },
    },
    tx,
  );
}

// ------------------------------------------------------------------
// Cancel a run before external submission.
// ------------------------------------------------------------------
export async function cancelPaymentRun(
  principal: Principal,
  runId: string,
  reason: string,
): Promise<void> {
  assertPaymentsEnabled();
  if (!reason || reason.trim().length === 0) {
    throw new Error("PAY-1A: cancel requires a reason.");
  }
  await prisma.$transaction(async (tx) => {
    const run = await tx.paymentRun.findUnique({
      where: { id: runId },
      select: { id: true, clubId: true, status: true, workIntakeItemId: true },
    });
    if (!run) throw new Error("PAY-1A: PaymentRun not found.");
    assertTenantOwned({ clubId: run.clubId }, principal);
    requirePermission(principal, run.clubId, "payment:cancel");

    const cancellableFrom = ["PREPARED", "PENDING_AUTHORIZATION", "AUTHORIZED", "SCHEDULED"];
    if (!cancellableFrom.includes(run.status)) {
      throw new Error(
        `PAY-1A: cannot cancel from state=${run.status}. ` +
        "After external submission cancellation depends on the provider boundary.",
      );
    }
    await transitionRunState(
      runId, run.status as never, "CANCELLED",
      { userId: principal.id, source: "USER" },
      "PAYMENT_CANCELLED",
      tx,
      { meta: { reason } },
    );
    await tx.paymentRun.update({
      where: { id: runId },
      data: { cancelledAt: new Date(), cancelledByUserId: principal.id, cancelReason: reason },
    });
    // Invalidate authorization if it was active.
    await invalidateAuthorization(runId, "cancelled", tx);
    // Cancel Work Intake if present.
    if (run.workIntakeItemId) {
      await tx.workIntakeItem.update({
        where: { id: run.workIntakeItemId },
        data: { status: "SUPPRESSED" },
      });
    }
  });
}
