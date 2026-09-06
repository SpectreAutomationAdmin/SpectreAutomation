// Payroll-3B-5B-3A closeout (2026-09-01) — canonical deep-link
// resolver for Payroll Work Intake cards.
//
// Any UI or automation that needs to send a Controller / Payroll
// Admin to the correct Payroll surface for a given Work Intake
// card resolves the URL through this helper — never by parsing
// display text and never by hard-coding a batchId.
//
// The batch reference always comes from the canonical
// `WorkIntakeOrigin.referenceId` (populated at materialisation
// time by the orchestrator).

export type PayrollWorkSubtype =
  | "PAYROLL_ADMIN_PROCESSING"
  | "PAYROLL_REVIEW"
  | "PAYROLL_FINAL_APPROVAL"
  // Payroll-3D-3 — manager timesheet approval scope + config-gap card.
  | "TIMESHEET_APPROVAL"
  | "TIMESHEET_APPROVAL_CONFIG_GAP";

export interface PayrollDeepLink {
  href:  string;
  label: string;
}

/**
 * Resolve the canonical review destination for a Payroll Work
 * Intake card. Returns `null` for non-Payroll subtypes so callers
 * can safely fall through to their generic handler.
 *
 * Deliberately does NOT return an approval / posting URL — the
 * Controller may REVIEW only in this slice (§22).
 */
export function resolvePayrollWorkIntakeDeepLink(
  workSubtype: string | null | undefined,
  referenceId: string | null | undefined,
): PayrollDeepLink | null {
  if (!referenceId) return null;
  switch (workSubtype) {
    case "PAYROLL_FINAL_APPROVAL":
      return {
        href:  `/app/admin/payroll/batches/${encodeURIComponent(referenceId)}`,
        label: "Review payroll",
      };
    case "PAYROLL_REVIEW":
      // PAYROLL_REVIEW originates from a materialised batch — referenceId
      // is a batchId. Pass as ?batchId so the processing page resolves
      // the batch and its pay period together.
      return {
        href:  `/app/admin/payroll/process?batchId=${encodeURIComponent(referenceId)}`,
        label: "Open payroll processing",
      };
    case "PAYROLL_ADMIN_PROCESSING":
      // PAYROLL_ADMIN_PROCESSING originates from a pay period — referenceId
      // is a payPeriodId. Pass as ?payPeriodId so the processing page
      // pre-selects the correct period (never defaults to the latest
      // period in the dropdown, which for a full 24-period calendar
      // could sit in a different tax year).
      return {
        href:  `/app/admin/payroll/process?payPeriodId=${encodeURIComponent(referenceId)}`,
        label: "Open payroll processing",
      };
    case "TIMESHEET_APPROVAL": {
      // Payroll-3D-3 — deep-link the manager to their scope's review
      // workspace. referenceId encoding: `${payPeriodId}:${departmentId}`.
      const [payPeriodId, departmentId] = referenceId.split(":");
      if (!payPeriodId || !departmentId) return null;
      const qs = new URLSearchParams({
        payPeriodId, departmentId, scope: "timesheet",
      }).toString();
      return {
        href:  `/app/admin/payroll/time?${qs}`,
        label: "Open timesheet approval",
      };
    }
    case "TIMESHEET_APPROVAL_CONFIG_GAP": {
      // Payroll-3D-3A — Configuration gap deep-links the Tenant
      // Administrator directly to the Timesheet Approver assignment
      // surface, pre-focused on the department that's missing an
      // approver. The gap card auto-resolves after a successful save.
      const [_payPeriodId, departmentId] = referenceId.split(":");
      if (!departmentId) return null;
      const qs = new URLSearchParams({ departmentId }).toString();
      return {
        href:  `/app/admin/settings/time-approvers?${qs}`,
        label: "Assign Timesheet Approver",
      };
    }
    default:
      return null;
  }
}
