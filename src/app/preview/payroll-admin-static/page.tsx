// Isolated static Payroll Admin prototype.
// Reproduces docs/design/payroll/payroll-admin-desktop-1440x900-approved.png
// as closely as possible for founder review.
//
// STATIC ONLY:
//   - hardcoded fixture data
//   - no data fetching
//   - no server actions
//   - no responsive behavior beyond 1440x900
//   - no real Payroll integration
//
// Reachable at /preview/payroll-admin-static — never linked from the
// app. Delete or rewrite freely without affecting real Payroll code.

import StaticPayrollAdmin from "./StaticPayrollAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function StaticPayrollAdminPreview() {
  return <StaticPayrollAdmin />;
}
