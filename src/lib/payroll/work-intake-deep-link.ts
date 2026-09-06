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
    // Payroll-3D-3B Slice 6 (2026-09-06) — correction-review deep-link.
    // The card's "View Timesheet" secondary lands the manager on the
    // scope workspace already filtered to the correction's employee /
    // pay period. The exact scope query is unknown at deep-link time
    // (referenceId is a bare correctionRequestId; scope resolution
    // requires the correction row) — the target page's own loader
    // handles the correction-scope join. We forward the correction id
    // so the page can jump directly to it.
    case "TIMECLOCK_CORRECTION_REVIEW": {
      const qs = new URLSearchParams({ correctionRequestId: referenceId }).toString();
      return {
        href:  `/app/admin/payroll/time?${qs}`,
        label: "View timesheet",
      };
    }
    case "TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP": {
      // Two prefix flavours (Slice 2): MISSING_APPROVER:${deptId}:${corrId}
      // and MISSING_ASSIGNMENT:${corrId}. The remediation destination
      // differs — approver-gaps route to the Timesheet Approver
      // settings; assignment-gaps route to the general employee /
      // timesheet admin surface (the founder's brief §16 explicitly
      // said: no new settings page in this slice — use the narrowest
      // existing canonical URL).
      if (referenceId.startsWith("MISSING_APPROVER:")) {
        const parts = referenceId.split(":");
        if (parts.length < 3) return null;
        const departmentId = parts[1];
        const qs = new URLSearchParams({ departmentId }).toString();
        return {
          href:  `/app/admin/settings/time-approvers?${qs}`,
          label: "Assign Timesheet Approver",
        };
      }
      if (referenceId.startsWith("MISSING_ASSIGNMENT:")) {
        // No dedicated URL for correction-assignment repair exists;
        // send to the payroll time workspace where an admin can fix
        // the correction's assignment context.
        return {
          href:  `/app/admin/payroll/time`,
          label: "Review correction",
        };
      }
      return null;
    }
    default:
      return null;
  }
}
