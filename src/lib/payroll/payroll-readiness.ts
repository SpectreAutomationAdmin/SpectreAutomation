// Payroll Admin Slice 3D (2026-09-12) — canonical Calculate-readiness
// composition. This module owns the single "canCalculate" derivation
// consumed by both the Payroll Overview surface (Calculate button
// enablement + disabled-state explanatory copy) and the domain
// calculatePayrollBatch service (which internally re-runs
// prepareCalculationInput — this module composes surface-facing
// readiness only; it does NOT re-check statutory prerequisites).
//
// Composition rule (§5 of the 3D directive):
//
//   canCalculate =
//        batch.status === PREPARED
//     && readiness.allImported
//     && readiness.allDepartmentApproved
//     && readiness.awaitingFreezeScopeCount === 0
//     && blockerExceptionCount === 0
//     && oneTimeAdjustmentReviewCurrent
//     && recurringComponentReviewCurrent
//     && employeeDataReviewCurrent
//
// Empty-dataset semantics (§5) auto-complete the review dimensions:
// zero one-time adjustments ⇒ ONE_TIME_ADJUSTMENTS not required;
// zero recurring snapshots  ⇒ RECURRING_COMPONENTS  not required;
// zero batch employees      ⇒ EMPLOYEE_DATA          not required.
//
// WARNINGs are never blocking here — the domain refuses only on
// BLOCKER exceptions. Warnings that a Payroll Admin has to acknowledge
// live in the checklist detail column instead.

export type PayrollCalculateBlockerCode =
  | "BATCH_NOT_PREPARED"
  | "TIME_NOT_IMPORTED"
  | "DEPARTMENT_APPROVALS_INCOMPLETE"
  | "SCOPES_AWAITING_FREEZE"
  | "BLOCKER_EXCEPTIONS_UNRESOLVED"
  | "ONE_TIME_ADJUSTMENTS_REVIEW_REQUIRED"
  | "RECURRING_COMPONENTS_REVIEW_REQUIRED"
  | "EMPLOYEE_DATA_REVIEW_REQUIRED";

export interface PayrollCalculateBlocker {
  code: PayrollCalculateBlockerCode;
  message: string;
}

export interface PayrollCalculateReadiness {
  /** True iff every readiness dimension has cleared. */
  canCalculate: boolean;
  /** Ordered blockers — displayed to the operator as the reason
   *  Calculate is currently disabled. Empty when `canCalculate`. */
  blockers: PayrollCalculateBlocker[];
}

export interface PayrollCalculateReadinessInputs {
  batchStatus: string | null;
  allImported: boolean;
  allDepartmentApproved: boolean;
  awaitingFreezeScopeCount: number;
  blockerExceptionCount: number;
  oneTimeAdjustmentCount: number;
  oneTimeReviewed: boolean;
  recurringSnapshotCount: number;
  recurringReviewed: boolean;
  batchEmployeeCount: number;
  employeeDataReviewed: boolean;
}

export function derivePayrollCalculateReadiness(
  input: PayrollCalculateReadinessInputs,
): PayrollCalculateReadiness {
  const blockers: PayrollCalculateBlocker[] = [];
  if (input.batchStatus !== "PREPARED") {
    blockers.push({
      code: "BATCH_NOT_PREPARED",
      message: input.batchStatus == null
        ? "Prepare a payroll batch before calculating."
        : `Batch is ${input.batchStatus}; only PREPARED batches can be calculated.`,
    });
  }
  if (!input.allImported) {
    blockers.push({
      code: "TIME_NOT_IMPORTED",
      message: "Some source time has not been imported into the payroll pipeline.",
    });
  }
  if (!input.allDepartmentApproved) {
    blockers.push({
      code: "DEPARTMENT_APPROVALS_INCOMPLETE",
      message: "Every department with reviewable time must be approved by a Department Head.",
    });
  }
  if (input.awaitingFreezeScopeCount > 0) {
    blockers.push({
      code: "SCOPES_AWAITING_FREEZE",
      message: `${input.awaitingFreezeScopeCount} approved scope${
        input.awaitingFreezeScopeCount === 1 ? "" : "s"
      } awaiting freeze into payroll.`,
    });
  }
  if (input.blockerExceptionCount > 0) {
    blockers.push({
      code: "BLOCKER_EXCEPTIONS_UNRESOLVED",
      message: `${input.blockerExceptionCount} blocker exception${
        input.blockerExceptionCount === 1 ? "" : "s"
      } must be resolved first.`,
    });
  }
  if (input.oneTimeAdjustmentCount > 0 && !input.oneTimeReviewed) {
    blockers.push({
      code: "ONE_TIME_ADJUSTMENTS_REVIEW_REQUIRED",
      message: "One-time adjustments have not been reviewed since the last change.",
    });
  }
  if (input.recurringSnapshotCount > 0 && !input.recurringReviewed) {
    blockers.push({
      code: "RECURRING_COMPONENTS_REVIEW_REQUIRED",
      message: "Recurring components have not been reviewed.",
    });
  }
  if (input.batchEmployeeCount > 0 && !input.employeeDataReviewed) {
    blockers.push({
      code: "EMPLOYEE_DATA_REVIEW_REQUIRED",
      message: "Employee data has not been reviewed since the last change.",
    });
  }
  return { canCalculate: blockers.length === 0, blockers };
}
