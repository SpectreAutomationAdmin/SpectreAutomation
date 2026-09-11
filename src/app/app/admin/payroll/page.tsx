// Payroll Admin Phase 2 (2026-09-10) — canonical Payroll Admin
// landing page. Renders the founder-approved Payroll Admin surface
// (Weekly Payroll header + 8-stage workflow + 5 KPI cards + workspace
// table + right-rail Actions/Checklist/Pay Period Info panels + footer)
// inside the real Spectre admin shell (SpectreSidebar + SpectreTopBar,
// dark-navy sidebar treatment per Phase 2 CSS override).
//
// This route replaces `/preview/payroll-admin-static` as the canonical
// destination. The preview route remains available for visual
// comparison against the approved reference PNG at:
//   docs/design/payroll/payroll-admin-desktop-1440x900-approved.png
//   SHA-256: d741321543eedbf3fa7991978132956d1f57359c4b01fce9f939c7948e72a7ce
//
// STATIC content only in this slice. No new Payroll business logic
// touched. Real data wiring is a deliberate Phase 3 slice.
// The `payroll:read` permission gate mirrors every other Payroll route.

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import PayrollAdminSurface from "@/components/payroll/PayrollAdminSurface";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PayrollAdminOverviewPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) {
    redirect("/app/admin");
  }
  return <PayrollAdminSurface />;
}
