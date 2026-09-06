// Payroll-3C-2 (2026-09-07) — batch component snapshotting.
//
// Freezes each active recurring PayrollComponent assignment for an
// employee into an immutable PayrollBatchComponentSnapshot row when
// a payroll batch is prepared. Later live edits to the component /
// assignment can never mutate a historical batch. The calculator +
// review consume ONLY the snapshot; the live rows are never re-read
// after prep.
//
// This module does NOT touch the calculator's grossPay / statutory
// pipeline. It only writes snapshot rows. The wiring into the
// existing preparation service happens in
// `src/lib/payroll/batch-preparation.ts`.
//
// Effective-date rule (§8): a recurring assignment is included in
// this batch when its window covers `periodEnd - 1ms` (i.e. the
// LAST INSTANT of the pay period). Rationale:
//   • Full-period active employees satisfy this trivially.
//   • Assignments that end BEFORE the period end (e.g. terminated
//     benefit) are excluded from this batch — correct.
//   • Assignments that start AFTER the period end are excluded —
//     correct.
//   • An assignment whose window ONLY partially covers the period
//     (mid-period start/end) is currently EXCLUDED with a WARNING
//     rather than silently prorated (§8 fail-closed rule). Full
//     proration is deferred to a later slice.

import { prisma } from "../prisma";
import type { Prisma as PrismaTypes } from "@prisma/client";
import { findLibraryRule, type StatutoryRuleVariant } from "./statutory-library";

// Payroll-3C-3C (2026-09-09) — resolve + freeze SPECTRE_LIBRARY
// provenance for the snapshot. Returns empty fields when the
// component is CUSTOM / CUSTOM_TEST.
function frozenRuleProvenance(
  comp: {
    statutoryTreatmentSource: string;
    statutoryRuleKey?: string | null;
    statutoryRuleVariant?: string | null;
  },
  asOf: Date,
) {
  if (comp.statutoryTreatmentSource !== "SPECTRE_LIBRARY" || !comp.statutoryRuleKey) {
    return {
      statutoryRuleKey: null, statutoryRuleVariant: null,
      statutoryRuleVersion: null,
      statutoryRuleSourceAuthority: null,
      statutoryRuleSourceTitle: null,
      statutoryRuleSourceReference: null,
    };
  }
  const rule = findLibraryRule({
    ruleKey: comp.statutoryRuleKey,
    variant: (comp.statutoryRuleVariant ?? undefined) as StatutoryRuleVariant | undefined,
    jurisdiction: { country: "CA" },
    asOf,
  });
  if (!rule) {
    // The catalogue-upsert guard prevents this state at write time,
    // but if a rule is retired between upsert and snapshot, refuse
    // rather than silently proceeding with stale provenance.
    throw new Error(
      `SPECTRE_LIBRARY rule ${comp.statutoryRuleKey} (variant ${comp.statutoryRuleVariant ?? "DEFAULT"}) ` +
      `is not effective on ${asOf.toISOString().slice(0, 10)}. Component snapshotting refused.`,
    );
  }
  return {
    statutoryRuleKey:             rule.ruleKey,
    statutoryRuleVariant:         rule.variant,
    statutoryRuleVersion:         rule.version,
    statutoryRuleSourceAuthority: rule.sourceAuthority,
    statutoryRuleSourceTitle:     rule.sourceTitle,
    statutoryRuleSourceReference: rule.sourceReference,
  };
}

export interface ComponentSnapshotInput {
  clubId:          string;
  batchId:         string;
  batchEmployeeId: string;
  employeeId:      string;
  periodStart:     Date;
  periodEnd:       Date;  // EXCLUSIVE (schema half-open)
}

export interface ComponentSnapshotResult {
  written:   number;
  warnings:  Array<{ componentCode: string; code: string; message: string }>;
}

const MID_PERIOD_WARNING = {
  code: "COMPONENT_MID_PERIOD_CHANGE",
  message:
    "This component assignment covers only part of the pay period. Mid-period proration is not yet supported. " +
    "The assignment will be excluded from this batch — Payroll Admin should review before approval.",
};

/**
 * Snapshot every active recurring component assignment for the
 * employee into PayrollBatchComponentSnapshot. Idempotent on
 * (batchEmployeeId, sourceAssignmentId) — safe to call from a
 * re-preparation flow.
 *
 * Returns per-component warnings so preparation can surface them
 * as PayrollBatchException rows.
 */
export async function snapshotEmployeeComponentsForBatch(
  input: ComponentSnapshotInput,
  tx?: PrismaTypes.TransactionClient,
): Promise<ComponentSnapshotResult> {
  const c = tx ?? prisma;
  // The "as-of" moment for effective-date resolution is the last
  // instant OF the period. §8 documented above.
  const asOf = new Date(input.periodEnd.getTime() - 1);

  const assignments = await c.employeeRecurringPayrollComponent.findMany({
    where: {
      clubId: input.clubId,
      employeeId: input.employeeId,
      active: true,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
      component: { active: true },
    },
    include: { component: true },
    orderBy: [{ effectiveFrom: "asc" }],
  });

  const warnings: ComponentSnapshotResult["warnings"] = [];
  let written = 0;

  for (const a of assignments) {
    const comp = a.component;

    // Determine resolvedAmount + any warning up front.
    let resolvedAmount: PrismaTypes.Decimal | null = null;
    let warningCode: string | null = null;
    let warningMessage: string | null = null;

    // Mid-period start/end guard (§8 fail-closed).
    const startsInside = a.effectiveFrom > input.periodStart;
    const endsInside   = a.effectiveTo != null && a.effectiveTo < input.periodEnd;
    if (startsInside || endsInside) {
      warningCode = MID_PERIOD_WARNING.code;
      warningMessage = MID_PERIOD_WARNING.message;
      warnings.push({ componentCode: comp.code, ...MID_PERIOD_WARNING });
    } else if (comp.calculationMethod === "FIXED_AMOUNT") {
      if (a.amount == null) {
        warningCode = "COMPONENT_MISSING_AMOUNT";
        warningMessage = "Fixed-amount component has no dollar amount configured.";
        warnings.push({ componentCode: comp.code, code: warningCode, message: warningMessage });
      } else {
        resolvedAmount = a.amount;
      }
    } else if (comp.calculationMethod === "PERCENT_OF_ELIGIBLE_EARNINGS") {
      // Payroll-3C-3 (2026-09-08) — percent is now supported. Prep
      // leaves resolvedAmount NULL; the calculator computes it as
      // `percentBps × eligibleEarnings / 10000` and updates the row.
      if (a.percentBps == null) {
        warningCode = "COMPONENT_MISSING_PERCENT";
        warningMessage = "Percentage component has no percentBps configured.";
        warnings.push({ componentCode: comp.code, code: warningCode, message: warningMessage });
      } else if (!comp.eligibleEarningsBase) {
        warningCode = "COMPONENT_MISSING_ELIGIBLE_BASE";
        warningMessage = "Percentage component has no eligibleEarningsBase configured.";
        warnings.push({ componentCode: comp.code, code: warningCode, message: warningMessage });
      }
      // resolvedAmount stays null here — computed at calculation time.
    } else {
      warningCode = "COMPONENT_UNKNOWN_METHOD";
      warningMessage = `Unknown calculation method: ${comp.calculationMethod}`;
      warnings.push({ componentCode: comp.code, code: warningCode, message: warningMessage });
    }

    const frozen = {
      componentCode: comp.code, displayName: comp.displayName,
      category: comp.category, side: comp.side,
      displaySection: comp.displaySection, displayOrder: comp.displayOrder,
      cashEffect: comp.cashEffect,
      // Payroll-3C-3 — directional statutory effects, frozen.
      taxableEffect:        comp.taxableEffect,
      cppPensionableEffect: comp.cppPensionableEffect,
      eiInsurableEffect:    comp.eiInsurableEffect,
      calculationMethod: comp.calculationMethod,
      // Payroll-3C-3 — eligible-earnings basis frozen (nullable).
      eligibleEarningsBase: comp.eligibleEarningsBase,
      // eligibleEarningsAmount is computed by the calculator, not
      // known at snapshot time. Prep writes null; the calculator
      // updates it in-place on the snapshot row.
      eligibleEarningsAmount: null,
      statutoryTreatmentSource: comp.statutoryTreatmentSource,
      // Payroll-3C-3C (2026-09-09) — freeze SPECTRE_LIBRARY provenance
      // when the component claims a rule. This lets snapshots answer
      // "why was this taxable?" without re-reading live library code.
      ...frozenRuleProvenance(comp, asOf),
      // Payroll-3C-3D (2026-09-09) — freeze the T4127 tax-formula
      // deduction stamp so historical batches retain the input the
      // calculator saw at CALCULATE time.
      taxFormulaDeductionType: comp.taxFormulaDeductionType ?? null,
      resolvedAmount, sourcePercentBps: a.percentBps ?? null,
      sourceEffectiveFrom: a.effectiveFrom, sourceEffectiveTo: a.effectiveTo,
      warningCode, warningMessage,
      // Payroll-3C-4 — provenance stamped so review/audit + calc can
      // distinguish recurring rows from one-time adjustments.
      provenance: "RECURRING_EMPLOYEE_SETUP" as const,
      // Payroll-3C-6 (2026-09-05) — freeze the live component's GL
      // mapping. Historical journals debit / credit these snapshotted
      // accounts, never the live component values, so mapping
      // changes made after this moment cannot rewrite history.
      expenseAccountIdSnapshot:   comp.expenseAccountId   ?? null,
      liabilityAccountIdSnapshot: comp.liabilityAccountId ?? null,
    };
    // Idempotency for recurring rows — findFirst by (batchEmployeeId, sourceAssignmentId)
    // then update in place. The strict unique constraint was dropped in
    // 3C-4 to accommodate one-time snapshots (sourceAssignmentId = NULL).
    const existing = await c.payrollBatchComponentSnapshot.findFirst({
      where: {
        batchEmployeeId: input.batchEmployeeId,
        sourceAssignmentId: a.id,
      },
      select: { id: true },
    });
    if (existing) {
      await c.payrollBatchComponentSnapshot.update({ where: { id: existing.id }, data: frozen });
    } else {
      await c.payrollBatchComponentSnapshot.create({
        data: {
          clubId: input.clubId,
          batchId: input.batchId,
          batchEmployeeId: input.batchEmployeeId,
          employeeId: input.employeeId,
          sourceComponentId: comp.id,
          sourceAssignmentId: a.id,
          ...frozen,
        },
      });
    }
    written += 1;
  }

  return { written, warnings };
}

/**
 * Convenience: does a batch have ANY component snapshots?
 * Used by the GL post-safety gate (§37) — the current GL adapter
 * cannot post component amounts, so a batch with component
 * snapshots must be blocked from posting until 3C-6.
 */
export async function batchHasComponentSnapshots(batchId: string): Promise<boolean> {
  const one = await prisma.payrollBatchComponentSnapshot.findFirst({
    where: { batchId }, select: { id: true },
  });
  return one != null;
}
