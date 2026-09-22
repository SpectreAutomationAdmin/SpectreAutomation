// FPP-9A (2026-09-22) — Post-posted payroll reversal service.
//
// Answers "what happens when we discover a payroll error after POSTED?"
// The answer is NEVER "edit the posted payroll." Instead, this service
// creates a SEPARATE PayrollBatch of transactionType="REVERSAL" that
// is the accounting inverse of the original, and drives it through
// the same Controller-approves / Payroll-Admin-posts governance
// lifecycle used by every other payroll.
//
// Boundaries — this service does NOT:
//   • mutate the original PayrollBatch, its employees, its
//     componentSnapshots, its JournalEntry, or its approval history;
//   • transmit money;
//   • recall EFT;
//   • trigger CRA remittance;
//   • touch bank / cash accounts;
//   • create employee-facing "you were unpaid" messaging.
//
// Boundaries — this service DOES:
//   • initiate a reversal batch from the frozen original evidence;
//   • derive per-employee amounts + componentSnapshots as the exact
//     negation of the original;
//   • materialise the Controller final-approval Work Intake item
//     (reusing the FPP-6/7 machinery);
//   • rely on `approvePayrollBatch` + `postPayrollBatch` for approval
//     + posting — those services already enforce RBAC + SoD +
//     atomicity + idempotency.
//
// The one modification to `postPayrollBatch` is journal generation:
// for REVERSAL batches, the new JournalEntry is derived by swapping
// debit ↔ credit on each line of the original journal. That branch
// lives in the posting service itself (see `postPayrollBatch`).

"use server";

import { prisma } from "../prisma";
import { Prisma } from "@prisma/client";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { audit } from "../audit";
import { ValidationError, NotFoundError, ConflictError } from "../errors";

const PAYROLL_ENTITY = "PayrollBatch";
const FINAL_APPROVAL_ORIGIN_KIND = "PAYROLL_FINAL_APPROVAL";

export interface InitiateReversalResult {
  reversalBatchId: string;
  originalBatchId: string;
  workIntakeItemId: string;
  calculationVersion: number;
  totalGrossNegatedDisplay: string;
  totalNetNegatedDisplay: string;
}

/**
 * Initiate a reversal of a POSTED payroll batch. Creates the reversal
 * PayrollBatch in status CALCULATED (amounts are frozen from the
 * original — no Prepare/Calculate cycle), submits it into the
 * Controller's approval queue, and returns the id + summary.
 *
 * The reversal batch's per-employee columns + component snapshots are
 * the EXACT negation of the original's frozen values. The Controller
 * cannot approve it if it drifts from the original (via the
 * calculationVersion CAS in approvePayrollBatch). Marc initiated,
 * Chris approves, Marc posts — the same governance chain as normal.
 */
export async function initiatePayrollReversal(
  principal: Principal,
  clubId: string,
  originalBatchId: string,
  reason: string,
): Promise<InitiateReversalResult> {
  requirePermission(principal, clubId, "payroll:submit");
  await assertPostingAllowed(principal, clubId, "payroll.reversal.initiate", PAYROLL_ENTITY, originalBatchId);

  const trimmedReason = (reason ?? "").trim();
  if (!trimmedReason) {
    throw new ValidationError([{ path: "reason", message: "Reversal reason is required." }]);
  }
  if (trimmedReason.length > 1000) {
    throw new ValidationError([{ path: "reason", message: "Reversal reason must be 1000 characters or fewer." }]);
  }

  // Load the original batch + its frozen evidence.
  const original = await prisma.payrollBatch.findFirst({
    where: { id: originalBatchId, clubId },
    include: {
      employees: true,
      componentSnapshots: true,
      exceptions: true,
      // FPP-9A — cannot re-reverse a batch that already has an
      // active or posted reversal.
      reversedBy: {
        select: { id: true, status: true, transactionType: true },
      },
    },
  });
  if (!original) throw new NotFoundError(PAYROLL_ENTITY, originalBatchId);
  if (original.transactionType !== "STANDARD") {
    throw new ConflictError(
      "Only STANDARD payrolls can be reversed. Cannot reverse a reversal batch.",
    );
  }
  if (original.status !== "POSTED") {
    throw new ConflictError(
      `Only POSTED payrolls can be reversed; original batch status is ${original.status}.`,
    );
  }
  if (!original.glJournalEntryId) {
    throw new ConflictError(
      "Original batch is POSTED but has no linked GL journal — investigate before reversing.",
    );
  }

  // Refuse a second active reversal per §20 (one full reversal per posted payroll).
  const alreadyReversedActive = original.reversedBy.find(
    (rb) => rb.status !== "VOIDED" && rb.status !== "RETURNED_FOR_CORRECTION",
  );
  if (alreadyReversedActive) {
    throw new ConflictError(
      `This payroll already has an active reversal (${alreadyReversedActive.id}, status ${alreadyReversedActive.status}). Complete or void the existing reversal before initiating another.`,
    );
  }

  // Compute the reversal batch's `sequence` — max(existing) + 1
  // within (club, payGroup, payPeriod).
  const maxSeq = await prisma.payrollBatch.aggregate({
    where: {
      clubId: original.clubId,
      payGroupId: original.payGroupId,
      payPeriodId: original.payPeriodId,
    },
    _max: { sequence: true },
  });
  const nextSequence = (maxSeq._max.sequence ?? 0) + 1;

  const now = new Date();
  const negate = (v: Prisma.Decimal | null | undefined): Prisma.Decimal | null =>
    v == null ? null : new Prisma.Decimal(0).minus(v);

  const totalGrossNeg = original.employees.reduce(
    (acc, e) => acc.plus(new Prisma.Decimal(0).minus(e.grossPay ?? 0)),
    new Prisma.Decimal(0),
  );
  const totalNetNeg = original.employees.reduce(
    (acc, e) => acc.plus(new Prisma.Decimal(0).minus(e.netPay ?? 0)),
    new Prisma.Decimal(0),
  );

  // ATOMIC creation: reversal PayrollBatch + PayrollBatchEmployee rows
  // + PayrollBatchComponentSnapshot rows + Controller WI item + WI
  // origin binding, all in one transaction. If ANY step fails, no
  // half-state remains.
  const result = await prisma.$transaction(async (tx) => {
    const reversal = await tx.payrollBatch.create({
      data: {
        clubId: original.clubId,
        payGroupId: original.payGroupId,
        payPeriodId: original.payPeriodId,
        // FPP-9A — reversal batch skips DRAFT/PREPARED. Amounts are
        // frozen from the original at initiate time, so it starts at
        // CALCULATED and immediately transitions to
        // SUBMITTED_FOR_APPROVAL via the submit-payroll-batch path.
        // For MVP we go straight to SUBMITTED_FOR_APPROVAL — the
        // Controller sees it in their queue immediately.
        status: "SUBMITTED_FOR_APPROVAL",
        sequence: nextSequence,
        transactionType: "REVERSAL",
        reversesPayrollBatchId: original.id,
        reversalReason: trimmedReason,
        preparedAt: now,
        preparedByUserId: principal.id,
        calculatedAt: now,
        submittedAt: now,
        submittedByUserId: principal.id,
        sourceSnapshotAt: original.sourceSnapshotAt,
        statutoryPackageId: original.statutoryPackageId,
        calculationVersion: 1,
        algorithmVersion: original.algorithmVersion,
        packageChecksum: original.packageChecksum,
        createdByUserId: principal.id,
        notes: `Reversal of PayrollBatch ${original.id} (JE ${original.glJournalEntryId}).`,
      },
    });

    // Copy per-employee rows with amounts negated.
    for (const e of original.employees) {
      await tx.payrollBatchEmployee.create({
        data: {
          batchId: reversal.id,
          employeeId: e.employeeId,
          clubId: e.clubId,
          jurisdictionCountry: e.jurisdictionCountry,
          jurisdictionProvince: e.jurisdictionProvince,
          employeeLifecycleAtPrep: e.employeeLifecycleAtPrep,
          status: e.status,
          salaried: e.salaried,
          sourceFactsJson: e.sourceFactsJson,
          ytdSnapshotJson: e.ytdSnapshotJson,
          approvedHoursSnapshot: negate(e.approvedHoursSnapshot),
          earningsTaxable: negate(e.earningsTaxable),
          earningsPensionable: negate(e.earningsPensionable),
          earningsInsurable: negate(e.earningsInsurable),
          grossPay: negate(e.grossPay),
          netPay: negate(e.netPay),
          totalEmployeeDeductions: negate(e.totalEmployeeDeductions),
          deductionCppEeCombined: negate(e.deductionCppEeCombined),
          deductionCpp2Ee: negate(e.deductionCpp2Ee),
          deductionEiEe: negate(e.deductionEiEe),
          deductionFederalTax: negate(e.deductionFederalTax),
          deductionProvincialTax: negate(e.deductionProvincialTax),
          additionalFederalTax: negate(e.additionalFederalTax),
          additionalProvincialTax: negate(e.additionalProvincialTax),
          employerCppCombined: negate(e.employerCppCombined),
          employerCpp2: negate(e.employerCpp2),
          employerEi: negate(e.employerEi),
          calculationExplanationJson: e.calculationExplanationJson,
        },
      });
    }

    // Copy component snapshots with resolvedAmount negated.
    // Group by original batchEmployeeId → new batchEmployeeId. Look
    // up the new BE row by employeeId (one BE per employee per
    // batch is the invariant).
    const newEmpsByEmployeeId = new Map(
      (await tx.payrollBatchEmployee.findMany({
        where: { batchId: reversal.id },
        select: { id: true, employeeId: true },
      })).map((r) => [r.employeeId, r.id]),
    );

    for (const s of original.componentSnapshots) {
      const newBeId = newEmpsByEmployeeId.get(s.employeeId) ?? null;
      if (!newBeId) continue;
      await tx.payrollBatchComponentSnapshot.create({
        data: {
          batchId: reversal.id,
          batchEmployeeId: newBeId,
          employeeId: s.employeeId,
          clubId: s.clubId,
          sourceComponentId: s.sourceComponentId,
          sourceAssignmentId: s.sourceAssignmentId,
          componentCode: s.componentCode,
          displayName: s.displayName,
          category: s.category,
          side: s.side,
          displaySection: s.displaySection,
          displayOrder: s.displayOrder,
          cashEffect: s.cashEffect,
          calculationMethod: s.calculationMethod,
          resolvedAmount: negate(s.resolvedAmount),
          sourcePercentBps: s.sourcePercentBps,
          sourceEffectiveFrom: s.sourceEffectiveFrom,
          sourceEffectiveTo: s.sourceEffectiveTo,
          eligibleEarningsBase: s.eligibleEarningsBase,
          eligibleEarningsAmount: negate(s.eligibleEarningsAmount),
          taxableEffect: s.taxableEffect,
          cppPensionableEffect: s.cppPensionableEffect,
          eiInsurableEffect: s.eiInsurableEffect,
          statutoryTreatmentSource: s.statutoryTreatmentSource,
          statutoryRuleKey: s.statutoryRuleKey,
          statutoryRuleVariant: s.statutoryRuleVariant,
          statutoryRuleVersion: s.statutoryRuleVersion,
          statutoryRuleSourceAuthority: s.statutoryRuleSourceAuthority,
          statutoryRuleSourceTitle: s.statutoryRuleSourceTitle,
          statutoryRuleSourceReference: s.statutoryRuleSourceReference,
          provenance: s.provenance,
          reason: `Reversal of ${s.componentCode} from original batch.`,
          matchBps: s.matchBps,
          matchCapBps: s.matchCapBps,
          taxFormulaDeductionType: s.taxFormulaDeductionType,
          expenseAccountIdSnapshot: s.expenseAccountIdSnapshot,
          liabilityAccountIdSnapshot: s.liabilityAccountIdSnapshot,
        },
      });
    }

    // FPP-9A.1 (2026-09-22) — Concurrency guard. Two initiations that
    // BOTH pass the pre-transaction `alreadyReversedActive` check will
    // BOTH reach create; without this post-create verification each
    // transaction would independently succeed, yielding two active
    // reversals for the same original. Re-count active reversals INSIDE
    // this transaction and throw if the invariant is broken — the throw
    // rolls back this transaction, leaving only the racer that committed
    // first. Works on both SQLite and Postgres.
    const activeReversalCount = await tx.payrollBatch.count({
      where: {
        reversesPayrollBatchId: original.id,
        status: { notIn: ["VOIDED", "RETURNED_FOR_CORRECTION"] },
      },
    });
    if (activeReversalCount > 1) {
      throw new ConflictError(
        `Concurrent reversal initiation detected for ${original.id} — another reversal already exists. Retry.`,
      );
    }

    // Materialise the Controller final-approval Work Intake item.
    const cfg = await tx.payrollClubConfig.findUnique({ where: { clubId } });
    const controllerUserId = cfg?.controllerUserId;
    if (!controllerUserId) {
      throw new ConflictError(
        "Reversal cannot be initiated because no Controller is configured for this Club.",
      );
    }
    const subject = `Payroll Reversal for Controller approval · reverses batch ${original.id}`;
    const preview = `Reversal reason: ${trimmedReason} · gross ${totalGrossNeg.toFixed(2)} · net ${totalNetNeg.toFixed(2)}`;
    const wi = await tx.workIntakeItem.create({
      data: {
        clubId,
        status: "OPEN",
        judgmentRequired: true,
        ownerUserId: controllerUserId,
        classification: FINAL_APPROVAL_ORIGIN_KIND,
        classificationReason: "Payroll reversal submitted by Payroll Admin — Controller approval required.",
        classificationMethod: "RULE",
        classificationRuleKey: "payroll-reversal.v1",
        classificationRuleVersion: 1,
        displaySourceLabel: "Spectre Payroll",
        displaySender: "Payroll orchestration",
        displaySubject: subject,
        displayPreview: preview,
        displayReceivedAt: now,
        displayHasAttachments: false,
        workDomain: "PAYROLL",
        workIntent: "APPROVE",
        workSubtype: FINAL_APPROVAL_ORIGIN_KIND,
        workDomainConfidence: 1,
        workDomainClassifiedAt: now,
        workDomainClassifierVersion: "payroll-reversal.v1",
      },
    });
    await tx.workIntakeOrigin.create({
      data: {
        clubId,
        workIntakeItemId: wi.id,
        kind: FINAL_APPROVAL_ORIGIN_KIND,
        referenceId: reversal.id,
        role: "PRIMARY",
        linkReason: `Payroll Admin initiated reversal of batch ${original.id}; reversal batch ${reversal.id} awaiting Controller approval.`,
      },
    });
    await tx.workIntakeActivity.create({
      data: {
        workIntakeItemId: wi.id,
        actorUserId: principal.id,
        action: "MATERIALISED",
        note: `Reversal task materialised — reverses batch ${original.id}, reason: ${trimmedReason}`,
      },
    });

    return {
      reversalBatchId: reversal.id,
      workIntakeItemId: wi.id,
      calculationVersion: reversal.calculationVersion,
    };
  });

  // FPP-9B.1 (2026-09-22) — compute + persist calculation fingerprint
  // for the reversal batch. Distinct from packageChecksum. Reversal has
  // its own fingerprint reflecting the frozen negated state.
  try {
    const { loadAndComputeFingerprintForBatch } = await import("./calculation-fingerprint");
    const { fingerprint } = await loadAndComputeFingerprintForBatch(result.reversalBatchId);
    await prisma.payrollBatch.update({
      where: { id: result.reversalBatchId },
      data: { calculationFingerprint: fingerprint },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[reversal.initiate] failed to persist calculationFingerprint", err);
  }

  await audit(principal, {
    clubId,
    action: "payroll.reversal.initiate",
    entityType: PAYROLL_ENTITY,
    entityId: result.reversalBatchId,
    before: { status: original.status, calculationVersion: original.calculationVersion },
    after: {
      reversalBatchId: result.reversalBatchId,
      reversesPayrollBatchId: original.id,
      reversalReason: trimmedReason,
      originalJournalEntryId: original.glJournalEntryId,
      totalGrossNegated: totalGrossNeg.toFixed(2),
      totalNetNegated: totalNetNeg.toFixed(2),
    },
  });

  return {
    reversalBatchId: result.reversalBatchId,
    originalBatchId: original.id,
    workIntakeItemId: result.workIntakeItemId,
    calculationVersion: result.calculationVersion,
    totalGrossNegatedDisplay: `$${totalGrossNeg.toFixed(2)}`,
    totalNetNegatedDisplay: `$${totalNetNeg.toFixed(2)}`,
  };
}
