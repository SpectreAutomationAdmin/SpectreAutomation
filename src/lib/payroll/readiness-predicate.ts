// Payroll MVP posting hotfix (2026-09-07) — readiness predicate for
// the Payroll Processing page.
//
// The time-approval prerequisite is satisfied when every department
// that requires an approval is APPROVED. A salary-only pay period
// has zero departments requiring approval, so the predicate is
// trivially satisfied — never require "at least one approval
// record". A mixed batch (salary + hourly) surfaces only the
// departments that actually have payable hourly time; salary-only
// employees do not create an approval requirement.

export type DepartmentApprovalState = "PENDING" | "APPROVED" | "REOPENED";

export interface DepartmentApprovalRow {
  departmentId: string;
  state: DepartmentApprovalState;
}

export interface ReadinessDecision {
  requiredCount: number;   // # of departments that require an approval
  approvedCount: number;   // # currently APPROVED
  salaryOnly:    boolean;  // requiredCount === 0
  ready:         boolean;  // true when every required department is APPROVED
  missing:       string[]; // departmentIds still not APPROVED (empty when ready)
}

/**
 * Pure — no I/O. `rows` is the list of departments that actually
 * have payable time in the pay period (produced by
 * getDepartmentApprovalStatus). An empty list means salary-only.
 */
export function evaluateTimeApprovalReadiness(rows: DepartmentApprovalRow[]): ReadinessDecision {
  const requiredCount = rows.length;
  const approvedCount = rows.filter((r) => r.state === "APPROVED").length;
  const salaryOnly    = requiredCount === 0;
  const ready         = rows.every((r) => r.state === "APPROVED");
  const missing       = rows.filter((r) => r.state !== "APPROVED").map((r) => r.departmentId);
  return { requiredCount, approvedCount, salaryOnly, ready, missing };
}
