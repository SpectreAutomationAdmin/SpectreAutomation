// FPP-9B (2026-09-22) — Reverse & Correct correction service.
//
// The founder discovered an error in an already-POSTED payroll. FPP-9A gave
// us the REVERSAL primitive. FPP-9B turns that primitive into a governed
// correction workflow that preserves the accounting chain:
//
//     ORIGINAL (STANDARD, POSTED)
//        → REVERSAL (POSTED)          — accounting inverse of ORIGINAL
//        → CORRECTION (POSTED)         — replacement payroll
//
//   Original + Reversal            = 0
//   Original + Reversal + Correction = Correction
//
// All three transactions remain immutable once POSTED. The correction is
// its own PayrollBatch (transactionType="CORRECTION") linked back to the
// ORIGINAL via `correctsPayrollBatchId` and to the paired REVERSAL via
// `pairedReversalBatchId`.
//
// -----------------------------------------------------------------------
// § Correction calculation policy (FPP-9B §3)
// -----------------------------------------------------------------------
//
// A correction is NOT a re-derivation of the original — it is a
// replacement payroll representing "what this payroll should have been".
// Spectre's calculator remains authoritative; the correction differs from
// a fresh payroll only in these controlled ways:
//
//   * pay period, pay date, jurisdiction, tax year — PRESERVED from
//     original. CRA table lookups depend on payDate, so the correction
//     must use the ORIGINAL payDate to reproduce a legally coherent
//     Canadian payroll result for the period that was mis-paid.
//   * statutoryPackageId — PRESERVED from original. This locks CRA
//     T4127 tables, CPP/EI/tax algorithms, and the frozen package
//     checksum used by the original. Reproducibility of the original
//     matters more than newer CRA revisions (the correction represents
//     what SHOULD have happened on the ORIGINAL payDate).
//   * algorithmVersion — PRESERVED from original for the same reason.
//   * Employee inputs (compensation, TD1, recurring components,
//     scheduled earnings, benefit enrolments) — SEEDED from original's
//     frozen `sourceFactsJson`, but the Payroll Admin may PATCH them
//     via the correction-inputs surface before running Calculate. This
//     is the ONLY set of correction inputs that may change.
//   * YTD context — the correction reads authoritative YTD from all
//     POSTED batches at Calculate time. Because the paired REVERSAL
//     is guaranteed to be POSTED before the correction can post
//     (post-gate below), the aggregated YTD correctly reflects
//     "original + reversal = 0" contribution, so the correction's
//     annual-maximum tracking (CPP, EI) sees the pre-original state.
//
// -----------------------------------------------------------------------
// § Boundaries — what this service does NOT do
// -----------------------------------------------------------------------
//   * Does NOT transmit money, recall EFT, or handle overpayment.
//   * Does NOT build partial reversal (FPP-9C+).
//   * Does NOT build general off-cycle payroll.
//   * Does NOT modify EmployeeCompensation, EmployeeTaxProfile, or any
//     other authoritative HR record — only the correction batch's
//     `sourceFactsJson` per-employee snapshot.

"use server";

import { prisma } from "../prisma";
import { Prisma } from "@prisma/client";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { audit } from "../audit";
import { ValidationError, NotFoundError, ConflictError } from "../errors";
import { initiatePayrollReversal } from "./reversal";

const PAYROLL_ENTITY = "PayrollBatch";

export interface InitiateReverseAndCorrectResult {
  reversalBatchId: string;
  correctionBatchId: string;
  originalBatchId: string;
  reason: string;
}

/**
 * Initiate the full Reverse & Correct workflow from a POSTED STANDARD
 * payroll. Creates BOTH the reversal (via `initiatePayrollReversal`) AND
 * a linked CORRECTION batch seeded from the original.
 *
 * The correction batch is created in PREPARED status with per-employee
 * rows deep-copied from the original (including sourceFactsJson). The
 * Payroll Admin may then patch inputs via `patchCorrectionEmployeeInputs`
 * and call the normal `calculatePayrollBatch` to recompute.
 */
export async function initiateReverseAndCorrect(
  principal: Principal,
  clubId: string,
  originalBatchId: string,
  reason: string,
): Promise<InitiateReverseAndCorrectResult> {
  requirePermission(principal, clubId, "payroll:submit");
  await assertPostingAllowed(principal, clubId, "payroll.correction.initiate", PAYROLL_ENTITY, originalBatchId);

  const trimmedReason = (reason ?? "").trim();
  if (!trimmedReason) {
    throw new ValidationError([{ path: "reason", message: "Correction reason is required." }]);
  }
  if (trimmedReason.length > 1000) {
    throw new ValidationError([{ path: "reason", message: "Correction reason must be 1000 characters or fewer." }]);
  }

  const original = await prisma.payrollBatch.findFirst({
    where: { id: originalBatchId, clubId },
    include: {
      employees: true,
      componentSnapshots: true,
      correctedBy: { select: { id: true, status: true, transactionType: true } },
    },
  });
  if (!original) throw new NotFoundError(PAYROLL_ENTITY, originalBatchId);
  if (original.transactionType !== "STANDARD") {
    throw new ConflictError("Only STANDARD payrolls can be corrected. Cannot correct a reversal or a correction.");
  }
  if (original.status !== "POSTED") {
    throw new ConflictError(`Only POSTED payrolls can be corrected; original status is ${original.status}.`);
  }

  const alreadyCorrectedActive = original.correctedBy.find(
    (cb) => cb.status !== "VOIDED" && cb.status !== "RETURNED_FOR_CORRECTION",
  );
  if (alreadyCorrectedActive) {
    throw new ConflictError(
      `This payroll already has an active correction (${alreadyCorrectedActive.id}, status ${alreadyCorrectedActive.status}). Complete or void the existing correction first.`,
    );
  }

  // Step 1: initiate the reversal via the existing FPP-9A primitive.
  // The concurrency guard + WI materialisation + snapshot negation are
  // owned by that service — we do not duplicate that work here.
  const reversal = await initiatePayrollReversal(principal, clubId, originalBatchId, trimmedReason);

  // Step 2: create the linked CORRECTION batch, seeded from original.
  const now = new Date();

  const maxSeq = await prisma.payrollBatch.aggregate({
    where: { clubId: original.clubId, payGroupId: original.payGroupId, payPeriodId: original.payPeriodId },
    _max: { sequence: true },
  });
  const nextSequence = (maxSeq._max.sequence ?? 0) + 1;

  const result = await prisma.$transaction(async (tx) => {
    const correction = await tx.payrollBatch.create({
      data: {
        clubId: original.clubId,
        payGroupId: original.payGroupId,
        payPeriodId: original.payPeriodId,
        // Correction starts in PREPARED — inputs are seeded from the
        // frozen original and are ready for Calculate. The Payroll Admin
        // may adjust inputs on the correction (via
        // patchCorrectionEmployeeInputs) before recalculating.
        status: "PREPARED",
        sequence: nextSequence,
        transactionType: "CORRECTION",
        correctsPayrollBatchId: original.id,
        pairedReversalBatchId: reversal.reversalBatchId,
        correctionReason: trimmedReason,
        preparedAt: now,
        preparedByUserId: principal.id,
        sourceSnapshotAt: original.sourceSnapshotAt ?? now,
        statutoryPackageId: original.statutoryPackageId,
        // Correction has its OWN calculation version, starting at 0.
        // Each recalculate increments this counter (per the base MVP
        // calculator semantics).
        calculationVersion: 0,
        algorithmVersion: original.algorithmVersion,
        packageChecksum: original.packageChecksum,
        createdByUserId: principal.id,
        notes: `Correction of PayrollBatch ${original.id}; paired reversal ${reversal.reversalBatchId}.`,
      },
    });

    // Copy per-employee rows verbatim from the original — including
    // sourceFactsJson, which is the SEED the Payroll Admin will edit.
    // Amounts are NOT copied — they will be produced by Calculate after
    // the PA patches inputs (or accepts the seeded state and recalculates
    // to reproduce the original — an edge case for corrections that just
    // resnapshot without changing anything).
    // FPP-9C (2026-09-22, §7) — historical seeding invariant. Component
    // snapshots must be copied from the ORIGINAL's frozen state so a
    // correction can amend "the payroll input that should have existed"
    // rather than re-resolving from the employee's current profile
    // (which may have drifted since the original was posted).
    const newBeIdByEmployeeId = new Map<string, string>();
    for (const e of original.employees) {
      const newBe = await tx.payrollBatchEmployee.create({
        data: {
          batchId: correction.id,
          employeeId: e.employeeId,
          clubId: e.clubId,
          jurisdictionCountry: e.jurisdictionCountry,
          jurisdictionProvince: e.jurisdictionProvince,
          employeeLifecycleAtPrep: e.employeeLifecycleAtPrep,
          status: e.status,
          salaried: e.salaried,
          sourceFactsJson: e.sourceFactsJson,
          ytdSnapshotJson: e.ytdSnapshotJson,
          // Reset calculated amounts — Calculate will populate them.
        },
      });
      newBeIdByEmployeeId.set(e.employeeId, newBe.id);
    }
    for (const s of original.componentSnapshots) {
      const newBeId = newBeIdByEmployeeId.get(s.employeeId);
      if (!newBeId) continue;
      await tx.payrollBatchComponentSnapshot.create({
        data: {
          batchId: correction.id,
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
          resolvedAmount: s.resolvedAmount,
          sourcePercentBps: s.sourcePercentBps,
          sourceEffectiveFrom: s.sourceEffectiveFrom,
          sourceEffectiveTo: s.sourceEffectiveTo,
          eligibleEarningsBase: s.eligibleEarningsBase,
          eligibleEarningsAmount: s.eligibleEarningsAmount,
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
          reason: `Correction seed of ${s.componentCode} from original ${originalBatchId}.`,
          matchBps: s.matchBps,
          matchCapBps: s.matchCapBps,
          taxFormulaDeductionType: s.taxFormulaDeductionType,
          expenseAccountIdSnapshot: s.expenseAccountIdSnapshot,
          liabilityAccountIdSnapshot: s.liabilityAccountIdSnapshot,
        },
      });
    }

    // Concurrency guard: verify still exactly one active correction after
    // create (a racer would produce >1). Roll back the racer.
    const activeCorrectionCount = await tx.payrollBatch.count({
      where: {
        correctsPayrollBatchId: original.id,
        status: { notIn: ["VOIDED", "RETURNED_FOR_CORRECTION"] },
      },
    });
    if (activeCorrectionCount > 1) {
      throw new ConflictError(
        `Concurrent correction initiation detected for ${original.id} — another correction already exists. Retry.`,
      );
    }

    return { correctionBatchId: correction.id };
  });

  await audit(principal, {
    action: "payroll.correction.initiate",
    entityType: PAYROLL_ENTITY,
    entityId: result.correctionBatchId,
    meta: {
      clubId,
      originalBatchId: original.id,
      reversalBatchId: reversal.reversalBatchId,
      correctionBatchId: result.correctionBatchId,
      reason: trimmedReason,
    },
  }).catch(() => { /* audit is best-effort */ });

  return {
    reversalBatchId: reversal.reversalBatchId,
    correctionBatchId: result.correctionBatchId,
    originalBatchId: original.id,
    reason: trimmedReason,
  };
}

// FPP-9C (2026-09-22) — correction-input patch shape (multi-input).
//
// Discriminated union of supported correction inputs, each with an
// explicit ADD | UPDATE | REMOVE operation where applicable. Extends
// the FPP-9B annualSalary-only MVP.
//
//   annualSalary   — UPDATE only (operation implicit). Patches the
//                     correction batch's sourceFactsJson.compensations[0].
//                     No ADD/REMOVE — an employee always has one
//                     compensation snapshot per correction employee row.
//
//   allowance      — ADD | UPDATE | REMOVE. Backed by
//                     PayrollBatchAllowanceSnapshot on the correction
//                     batch (parallel to the snapshot the original had).
//                     Identified by allowanceType string; amount is a
//                     dollar Decimal.
//
//   oneTimeEarning — ADD | UPDATE | REMOVE. Backed by a
//                     PayrollBatchComponentSnapshot with provenance =
//                     ONE_TIME_PAYROLL_ADJUSTMENT, category = EARNING,
//                     cashEffect = ADD. Identified by componentCode +
//                     employeeId.
//
//   deduction      — ADD | UPDATE | REMOVE. Backed by a
//                     PayrollBatchComponentSnapshot with provenance =
//                     ONE_TIME_PAYROLL_ADJUSTMENT, category =
//                     DEDUCTION, cashEffect = SUBTRACT. Identified by
//                     componentCode + employeeId.
//
// The correction service applies these directly to the correction
// batch's frozen state. The calculator then re-runs on the modified
// state. Nothing on the ORIGINAL is touched.

export type CorrectionInputPatch =
  | { employeeId: string; kind: "annualSalary"; annualSalary: string }
  | { employeeId: string; annualSalary: string; kind?: undefined }  // legacy shorthand
  | { employeeId: string; kind: "allowance"; operation: "ADD" | "UPDATE" | "REMOVE";
      allowanceType: string; amount?: string }
  | { employeeId: string; kind: "oneTimeEarning"; operation: "ADD" | "UPDATE" | "REMOVE";
      componentCode: string; displayName?: string; amount?: string }
  | { employeeId: string; kind: "deduction"; operation: "ADD" | "UPDATE" | "REMOVE";
      componentCode: string; displayName?: string; amount?: string };

type NormalisedPatch =
  | { employeeId: string; kind: "annualSalary"; annualSalary: string }
  | { employeeId: string; kind: "allowance"; operation: "ADD" | "UPDATE" | "REMOVE"; allowanceType: string; amount?: string }
  | { employeeId: string; kind: "oneTimeEarning"; operation: "ADD" | "UPDATE" | "REMOVE"; componentCode: string; displayName?: string; amount?: string }
  | { employeeId: string; kind: "deduction"; operation: "ADD" | "UPDATE" | "REMOVE"; componentCode: string; displayName?: string; amount?: string };

function normalisePatch(p: CorrectionInputPatch): NormalisedPatch {
  if ((p as { kind?: string }).kind == null) {
    if ("annualSalary" in p && typeof p.annualSalary === "string") {
      return { employeeId: p.employeeId, kind: "annualSalary", annualSalary: p.annualSalary };
    }
    throw new ValidationError([{ path: "kind", message: "Patch shape missing 'kind' discriminator." }]);
  }
  if (p.kind === "annualSalary") {
    return { employeeId: p.employeeId, kind: "annualSalary", annualSalary: p.annualSalary };
  }
  if (p.kind === "allowance") {
    if (!p.operation || !["ADD","UPDATE","REMOVE"].includes(p.operation)) {
      throw new ValidationError([{ path: "operation", message: `allowance patch requires operation ADD|UPDATE|REMOVE` }]);
    }
    if ((p.operation === "ADD" || p.operation === "UPDATE") && !p.amount) {
      throw new ValidationError([{ path: "amount", message: `allowance ${p.operation} requires amount` }]);
    }
    return { employeeId: p.employeeId, kind: "allowance", operation: p.operation, allowanceType: p.allowanceType, amount: p.amount };
  }
  if (p.kind === "oneTimeEarning" || p.kind === "deduction") {
    if (!p.operation || !["ADD","UPDATE","REMOVE"].includes(p.operation)) {
      throw new ValidationError([{ path: "operation", message: `${p.kind} patch requires operation ADD|UPDATE|REMOVE` }]);
    }
    if ((p.operation === "ADD" || p.operation === "UPDATE") && !p.amount) {
      throw new ValidationError([{ path: "amount", message: `${p.kind} ${p.operation} requires amount` }]);
    }
    return { employeeId: p.employeeId, kind: p.kind, operation: p.operation,
      componentCode: p.componentCode, displayName: p.displayName, amount: p.amount };
  }
  throw new ValidationError([{ path: "kind", message: `Unknown correction patch kind: ${(p as { kind?: string }).kind}` }]);
}

/**
 * Patch specific input fields on a CORRECTION batch's sourceFactsJson.
 * Only the correction batch's per-employee sourceFacts may change; the
 * ORIGINAL and REVERSAL remain immutable. Only permitted when the
 * correction is in PREPARED or CALCULATED status (i.e., before submit).
 */
export async function patchCorrectionEmployeeInputs(
  principal: Principal,
  clubId: string,
  correctionBatchId: string,
  patches: CorrectionInputPatch[],
): Promise<{ patchedCount: number }> {
  requirePermission(principal, clubId, "payroll:edit");
  await assertPostingAllowed(principal, clubId, "payroll.correction.patch", PAYROLL_ENTITY, correctionBatchId);

  const correction = await prisma.payrollBatch.findFirst({
    where: { id: correctionBatchId, clubId },
    select: { id: true, status: true, transactionType: true },
  });
  if (!correction) throw new NotFoundError(PAYROLL_ENTITY, correctionBatchId);
  if (correction.transactionType !== "CORRECTION") {
    throw new ConflictError("Only CORRECTION batches can be patched via this service.");
  }
  if (correction.status !== "PREPARED" && correction.status !== "CALCULATED") {
    throw new ConflictError(
      `Correction inputs are only editable in PREPARED or CALCULATED status; current status is ${correction.status}.`,
    );
  }

  let patchedCount = 0;
  await prisma.$transaction(async (tx) => {
    for (const rawPatch of patches) {
      const patch = normalisePatch(rawPatch);
      const be = await tx.payrollBatchEmployee.findFirst({
        where: { batchId: correctionBatchId, employeeId: patch.employeeId },
        select: { id: true, clubId: true, sourceFactsJson: true },
      });
      if (!be) {
        throw new ValidationError([{ path: "employeeId", message: `Employee ${patch.employeeId} is not on this correction batch.` }]);
      }
      const facts = typeof be.sourceFactsJson === "string" ? JSON.parse(be.sourceFactsJson) : (be.sourceFactsJson ?? {});

      if (patch.kind === "annualSalary") {
        if (!Array.isArray(facts.compensations) || facts.compensations.length === 0) {
          throw new ValidationError([{ path: "compensations", message: `Employee ${patch.employeeId} has no compensation snapshot to patch.` }]);
        }
        new Prisma.Decimal(patch.annualSalary);
        facts.compensations[0] = { ...facts.compensations[0], annualSalary: patch.annualSalary };
        await tx.payrollBatchEmployee.update({
          where: { id: be.id },
          data: { sourceFactsJson: JSON.stringify(facts) },
        });
      } else if (patch.kind === "allowance") {
        // Allowances are stored inside sourceFactsJson.allowances[]. Each
        // entry is {allowanceType, amount}. Correction seeded them from
        // original at initiate time.
        if (!Array.isArray(facts.allowances)) facts.allowances = [];
        const idx = facts.allowances.findIndex((a: { allowanceType?: string }) => a.allowanceType === patch.allowanceType);
        if (patch.operation === "REMOVE") {
          if (idx < 0) throw new ValidationError([{ path: "allowanceType", message: `Allowance ${patch.allowanceType} not present on the correction — cannot REMOVE.` }]);
          facts.allowances.splice(idx, 1);
        } else if (patch.operation === "ADD") {
          if (idx >= 0) throw new ValidationError([{ path: "allowanceType", message: `Allowance ${patch.allowanceType} already present on the correction — use UPDATE instead of ADD.` }]);
          new Prisma.Decimal(patch.amount!);
          facts.allowances.push({ allowanceType: patch.allowanceType, amount: patch.amount });
        } else if (patch.operation === "UPDATE") {
          if (idx < 0) throw new ValidationError([{ path: "allowanceType", message: `Allowance ${patch.allowanceType} not present on the correction — use ADD instead of UPDATE.` }]);
          new Prisma.Decimal(patch.amount!);
          facts.allowances[idx] = { ...facts.allowances[idx], amount: patch.amount };
        }
        await tx.payrollBatchEmployee.update({
          where: { id: be.id },
          data: { sourceFactsJson: JSON.stringify(facts) },
        });
      } else if (patch.kind === "oneTimeEarning" || patch.kind === "deduction") {
        // One-time earnings + deductions are stored as
        // PayrollBatchComponentSnapshot rows on the correction batch,
        // with provenance = ONE_TIME_PAYROLL_ADJUSTMENT.
        const isEarning = patch.kind === "oneTimeEarning";
        const category = isEarning ? "EARNING" : "DEDUCTION";
        const cashEffect = isEarning ? "ADD" : "SUBTRACT";
        const side = isEarning ? "EMPLOYER" : "EMPLOYEE";
        const existing = await tx.payrollBatchComponentSnapshot.findFirst({
          where: { batchId: correctionBatchId, batchEmployeeId: be.id, componentCode: patch.componentCode },
          select: { id: true, provenance: true },
        });
        if (patch.operation === "REMOVE") {
          if (!existing) throw new ValidationError([{ path: "componentCode", message: `Component ${patch.componentCode} not present on the correction — cannot REMOVE.` }]);
          await tx.payrollBatchComponentSnapshot.delete({ where: { id: existing.id } });
        } else if (patch.operation === "ADD") {
          if (existing) throw new ValidationError([{ path: "componentCode", message: `Component ${patch.componentCode} already present on the correction — use UPDATE instead of ADD.` }]);
          new Prisma.Decimal(patch.amount!);
          // For ADD we need a sourceComponentId. Resolve it from the club's
          // PayrollComponent registry by componentCode.
          const comp = await tx.payrollComponent.findFirst({
            where: { clubId: be.clubId, code: patch.componentCode },
            select: { id: true, displayName: true, category: true, side: true, cashEffect: true },
          });
          if (!comp) throw new ValidationError([{ path: "componentCode", message: `PayrollComponent ${patch.componentCode} not defined on this Club — define it before adding to a correction.` }]);
          await tx.payrollBatchComponentSnapshot.create({
            data: {
              batchId: correctionBatchId, batchEmployeeId: be.id, employeeId: patch.employeeId,
              clubId: be.clubId, sourceComponentId: comp.id, sourceAssignmentId: null,
              componentCode: patch.componentCode, displayName: patch.displayName ?? comp.displayName,
              category: comp.category ?? category, side: comp.side ?? side,
              displaySection: category, displayOrder: 999,
              cashEffect: comp.cashEffect ?? cashEffect, calculationMethod: "FIXED_AMOUNT",
              provenance: "ONE_TIME_PAYROLL_ADJUSTMENT", enteredByUserId: principal.id,
              reason: `Correction ${patch.operation} of ${patch.componentCode} on batch ${correctionBatchId}.`,
              resolvedAmount: new Prisma.Decimal(patch.amount!),
              sourceEffectiveFrom: new Date(),
            },
          });
        } else if (patch.operation === "UPDATE") {
          if (!existing) throw new ValidationError([{ path: "componentCode", message: `Component ${patch.componentCode} not present on the correction — use ADD instead of UPDATE.` }]);
          new Prisma.Decimal(patch.amount!);
          await tx.payrollBatchComponentSnapshot.update({
            where: { id: existing.id },
            data: { resolvedAmount: new Prisma.Decimal(patch.amount!) },
          });
        }
      }
      patchedCount++;
    }
    // Any patch invalidates the previous Calculate — flip the correction
    // back to PREPARED so recalculation is required. Also clear the
    // stale calculationFingerprint (Calculate will write a new one).
    await tx.payrollBatch.updateMany({
      where: { id: correctionBatchId, status: "CALCULATED" },
      data: { status: "PREPARED", calculatedAt: null, calculationFingerprint: null },
    });
  });

  await audit(principal, {
    action: "payroll.correction.patch",
    entityType: PAYROLL_ENTITY,
    entityId: correctionBatchId,
    meta: { clubId, patches, patchedCount },
  }).catch(() => { /* audit is best-effort */ });

  return { patchedCount };
}

/**
 * Post-gate check: a CORRECTION batch may only post AFTER its paired
 * REVERSAL is POSTED. Called from `postPayrollBatch` before the CAS
 * on APPROVED → POSTED.
 */
export async function assertCorrectionCanPost(correctionBatchId: string): Promise<void> {
  const correction = await prisma.payrollBatch.findUnique({
    where: { id: correctionBatchId },
    select: { transactionType: true, pairedReversalBatchId: true },
  });
  if (!correction || correction.transactionType !== "CORRECTION") return;
  if (!correction.pairedReversalBatchId) {
    throw new ConflictError("Correction batch is missing pairedReversalBatchId — cannot post.");
  }
  const reversal = await prisma.payrollBatch.findUnique({
    where: { id: correction.pairedReversalBatchId },
    select: { status: true, glJournalEntryId: true },
  });
  if (!reversal) throw new ConflictError("Paired reversal batch not found — cannot post correction.");
  if (reversal.status !== "POSTED" || !reversal.glJournalEntryId) {
    throw new ConflictError(
      `Cannot post correction — paired reversal is ${reversal.status} without a journal. Post the reversal first.`,
    );
  }
}
