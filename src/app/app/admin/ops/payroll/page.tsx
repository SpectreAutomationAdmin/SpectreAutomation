// Payroll Consolidation (2026-09-14) — Legacy Ops Payroll retired.
//
// This route used to render the obsolete "Payroll (legacy)" workspace
// which called `payrollService.buildRun` / `postRun` (a flat 22% tax
// placeholder on the `PayrollRun` model). That implementation predated
// the canonical Payroll-3A–3F pipeline on the `PayrollBatch` model and
// is no longer safe for real payroll. Its sidebar entry has been removed
// and this URL now redirects to the canonical Finance → Payroll workspace.
//
// See docs/payroll/canonical-payroll-ui.md for the full architecture.
// Do NOT reinstate legacy payroll here.

import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function LegacyOpsPayrollRedirect() {
  redirect("/app/admin/payroll");
}
