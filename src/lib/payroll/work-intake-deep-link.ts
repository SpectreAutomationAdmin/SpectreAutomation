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
  | "PAYROLL_FINAL_APPROVAL";

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
    case "PAYROLL_ADMIN_PROCESSING":
      return {
        // Batch context lives on the processing surface. The
        // process page already accepts `?batchId=` and `?payPeriodId=`
        // deep-link params.
        href:  `/app/admin/payroll/process?batchId=${encodeURIComponent(referenceId)}`,
        label: "Open payroll processing",
      };
    default:
      return null;
  }
}
