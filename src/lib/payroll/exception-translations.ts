// Payroll Admin Slice 3B (2026-09-12) — customer-facing translations
// for the closed set of PayrollBatchException codes.
//
// The domain writes technical codes like MISSING_COMPENSATION into
// PayrollBatchException.code, and a technical message into .message.
// The Payroll Admin surface must:
//   1. present a short readable label (title) instead of the code,
//   2. keep the domain code queryable for tests + audit,
//   3. surface the recommendedAction inline,
//   4. offer a remediation deep-link back into the Spectre surface
//      that owns the source-of-truth data for the defect.
//
// Terminology (§34 of the 3B directive): text that mentions the
// employee's link to a payroll cadence uses "Pay Group Assignment",
// never "Membership" or "Club Member" — those belong to the Member
// domain and must not be confused with the Payroll domain.
//
// The remediation URLs below are all EXISTING Spectre routes; no
// new pages are introduced by this module.

export type ExceptionSeverity = "BLOCKER" | "WARNING" | "INFO";

export interface ExceptionTranslation {
  label: string;
  /** How to present this in a KPI / one-line row. */
  shortLabel: string;
  /** Where in Spectre to fix the underlying data. Null when the
   *  defect has no single canonical remediation surface. */
  remediation: {
    kind:
      | "employee-profile"
      | "employee-compensation"
      | "employee-banking"
      | "employee-tax-profile"
      | "pay-group-assignment"
      | "time-approvals"
      | "payroll-setup"
      | "employee-record"
      | "no-canonical-remediation";
    label: string;
    /** Function that produces the href, given the employee id (if any)
     *  and the current club/period context. Returns null when the
     *  required context isn't available (e.g., a code with no
     *  associated employee). */
    hrefFor: (ctx: { employeeId: string | null; payPeriodId: string; departmentId?: string | null }) => string | null;
  };
}

// The remediation targets are Spectre's existing surfaces. They may
// be tightened later (e.g. anchor to a specific tab within the
// employee record) without needing to change any calling site.
const EMPLOYEE_PROFILE  = (employeeId: string | null) => employeeId ? `/app/admin/people/employees/${employeeId}` : null;
const EMPLOYEE_TAX      = (employeeId: string | null) => employeeId ? `/app/admin/people/employees/${employeeId}?tab=tax` : null;
const EMPLOYEE_BANKING  = (employeeId: string | null) => employeeId ? `/app/admin/people/employees/${employeeId}?tab=banking` : null;
const EMPLOYEE_COMP     = (employeeId: string | null) => employeeId ? `/app/admin/people/employees/${employeeId}?tab=compensation` : null;
const PAYROLL_SETUP     = () => `/app/admin/payroll/setup`;
const PAYROLL_TIME      = (payPeriodId: string) => `/app/admin/payroll/time?payPeriodId=${encodeURIComponent(payPeriodId)}`;

export const EXCEPTION_TRANSLATIONS: Record<string, ExceptionTranslation> = {
  // ---- Structural / employee-record blockers ------------------------------
  MISSING_ASSIGNMENT: {
    label: "Missing employment assignment",
    shortLabel: "Missing assignment",
    remediation: {
      kind: "employee-profile",
      label: "Open employee profile",
      hrefFor: ({ employeeId }) => EMPLOYEE_PROFILE(employeeId),
    },
  },
  MISSING_COMPENSATION: {
    label: "Missing compensation record",
    shortLabel: "Missing compensation",
    remediation: {
      kind: "employee-compensation",
      label: "Set compensation",
      hrefFor: ({ employeeId }) => EMPLOYEE_COMP(employeeId),
    },
  },
  MISSING_DATE_OF_BIRTH: {
    label: "Missing date of birth",
    shortLabel: "Missing DOB",
    remediation: {
      kind: "employee-profile",
      label: "Open employee profile",
      hrefFor: ({ employeeId }) => EMPLOYEE_PROFILE(employeeId),
    },
  },

  // ---- Pay-group-assignment (§34: NEVER "Membership") ---------------------
  //
  // No current preparation code path raises this — non-assigned
  // employees are silently absent from the population rather than
  // included with a BLOCKER — but a future path (or a test fixture)
  // may raise it, and its translation MUST say "Pay Group Assignment"
  // rather than "Membership".
  MISSING_PAY_GROUP_ASSIGNMENT: {
    label: "Missing Pay Group Assignment",
    shortLabel: "Missing Pay Group Assignment",
    remediation: {
      kind: "pay-group-assignment",
      label: "Open Payroll setup",
      hrefFor: () => PAYROLL_SETUP(),
    },
  },

  // ---- Readiness warnings -------------------------------------------------
  BANKING_NOT_VERIFIED: {
    label: "Banking not verified",
    shortLabel: "Banking not verified",
    remediation: {
      kind: "employee-banking",
      label: "Verify banking",
      hrefFor: ({ employeeId }) => EMPLOYEE_BANKING(employeeId),
    },
  },
  MISSING_SIN: {
    label: "Payroll profile not activated",
    shortLabel: "Payroll profile inactive",
    remediation: {
      kind: "employee-profile",
      label: "Complete Payroll onboarding",
      hrefFor: ({ employeeId }) => EMPLOYEE_PROFILE(employeeId),
    },
  },
  MISSING_FEDERAL_TD1: {
    label: "Missing federal TD1",
    shortLabel: "No federal TD1",
    remediation: {
      kind: "employee-tax-profile",
      label: "Open tax profile",
      hrefFor: ({ employeeId }) => EMPLOYEE_TAX(employeeId),
    },
  },
  MISSING_PROVINCIAL_TD1: {
    label: "Missing provincial TD1",
    shortLabel: "No provincial TD1",
    remediation: {
      kind: "employee-tax-profile",
      label: "Open tax profile",
      hrefFor: ({ employeeId }) => EMPLOYEE_TAX(employeeId),
    },
  },
  TD1_CLAIM_RESOLUTION_FAILED: {
    label: "TD1 claim could not be resolved",
    shortLabel: "TD1 resolution failed",
    remediation: {
      kind: "employee-tax-profile",
      label: "Re-enter TD1 claim",
      hrefFor: ({ employeeId }) => EMPLOYEE_TAX(employeeId),
    },
  },

  // ---- Calculation-time blockers surfaced back into Prepare view ---------
  SALARY_PRORATION_POLICY_REQUIRED: {
    label: "Salary proration policy required",
    shortLabel: "Proration policy required",
    remediation: {
      kind: "no-canonical-remediation",
      label: "Requires founder policy decision",
      hrefFor: () => null,
    },
  },
  UNSUPPORTED_ALLOWANCE_FREQUENCY: {
    label: "Unsupported allowance frequency",
    shortLabel: "Allowance frequency unsupported",
    remediation: {
      kind: "employee-profile",
      label: "Open employee profile",
      hrefFor: ({ employeeId }) => EMPLOYEE_PROFILE(employeeId),
    },
  },
  MISSING_ALLOWANCE_CLASSIFICATION: {
    label: "Allowance is missing classification",
    shortLabel: "Allowance not classified",
    remediation: {
      kind: "employee-profile",
      label: "Open employee profile",
      hrefFor: ({ employeeId }) => EMPLOYEE_PROFILE(employeeId),
    },
  },
  UNSUPPORTED_EARNING_TYPE: {
    label: "Unsupported earning type",
    shortLabel: "Earning type unsupported",
    remediation: {
      kind: "no-canonical-remediation",
      label: "Contact Payroll operations",
      hrefFor: () => null,
    },
  },
  DRAFT_TIME_ENTRIES_PRESENT: {
    label: "Draft time entries still present",
    shortLabel: "Draft time present",
    remediation: {
      kind: "time-approvals",
      label: "Review time approvals",
      hrefFor: ({ payPeriodId }) => PAYROLL_TIME(payPeriodId),
    },
  },
  NO_APPROVED_HOURS_FOR_HOURLY: {
    label: "Hourly employee has no approved hours",
    shortLabel: "No approved hours",
    remediation: {
      kind: "time-approvals",
      label: "Review time approvals",
      hrefFor: ({ payPeriodId }) => PAYROLL_TIME(payPeriodId),
    },
  },
  STATUTORY_PACKAGE_UNRESOLVED: {
    label: "Statutory package not resolved for pay date",
    shortLabel: "Statutory package missing",
    remediation: {
      kind: "no-canonical-remediation",
      label: "Contact Payroll operations",
      hrefFor: () => null,
    },
  },
  UNSUPPORTED_RPP_DEDUCTION: {
    label: "RPP deduction not yet supported",
    shortLabel: "RPP unsupported",
    remediation: {
      kind: "no-canonical-remediation",
      label: "Contact Payroll operations",
      hrefFor: () => null,
    },
  },
  UNSUPPORTED_ALIMONY_DEDUCTION: {
    label: "Alimony deduction not yet supported",
    shortLabel: "Alimony unsupported",
    remediation: {
      kind: "no-canonical-remediation",
      label: "Contact Payroll operations",
      hrefFor: () => null,
    },
  },
  UNSUPPORTED_ANNUAL_DEDUCTION: {
    label: "Annual deduction not yet supported",
    shortLabel: "Annual deduction unsupported",
    remediation: {
      kind: "no-canonical-remediation",
      label: "Contact Payroll operations",
      hrefFor: () => null,
    },
  },
  UNSUPPORTED_UNION_DUES: {
    label: "Union dues not yet supported",
    shortLabel: "Union dues unsupported",
    remediation: {
      kind: "no-canonical-remediation",
      label: "Contact Payroll operations",
      hrefFor: () => null,
    },
  },
  UNSUPPORTED_PRESCRIBED_ZONE: {
    label: "Prescribed-zone allowance not yet supported",
    shortLabel: "Prescribed zone unsupported",
    remediation: {
      kind: "no-canonical-remediation",
      label: "Contact Payroll operations",
      hrefFor: () => null,
    },
  },
  INVALID_BATCH_LIFECYCLE: {
    label: "Batch lifecycle invalid for calculation",
    shortLabel: "Batch lifecycle invalid",
    remediation: {
      kind: "no-canonical-remediation",
      label: "Void and re-prepare",
      hrefFor: () => null,
    },
  },
};

/** Fallback: pretty-print an unknown code so unmapped codes remain
 *  readable in the UI without shipping raw SCREAMING_SNAKE_CASE. */
export function fallbackLabelForUnknownCode(code: string): string {
  return code.toLowerCase().split("_")
    .map((w) => w.length ? w[0]!.toUpperCase() + w.slice(1) : w)
    .join(" ");
}

export function translateException(code: string): ExceptionTranslation {
  const t = EXCEPTION_TRANSLATIONS[code];
  if (t) return t;
  const label = fallbackLabelForUnknownCode(code);
  return {
    label,
    shortLabel: label,
    remediation: {
      kind: "no-canonical-remediation",
      label: "Contact Payroll operations",
      hrefFor: () => null,
    },
  };
}
