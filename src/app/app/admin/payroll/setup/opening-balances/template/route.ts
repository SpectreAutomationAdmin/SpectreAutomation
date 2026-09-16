// v-slice-1-followup-8 (2026-09-16) — Opening YTD Balances CSV template.
//
// GET /app/admin/payroll/setup/opening-balances/template
// Streams the canonical CSV header row the importer expects. The
// founder can save this file, fill it with per-employee data, and
// upload it back through the Import dialog on the Opening Balances
// page. Header list is sourced from opening-balance-import.ts to
// guarantee shape parity between download and importer.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { getCurrentUser } from "@/lib/session";
import { hasPermission } from "@/lib/rbac";
import { OPENING_BALANCE_CSV_HEADERS } from "@/lib/payroll/opening-balance-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const header = OPENING_BALANCE_CSV_HEADERS.join(",") + "\n";
  return new NextResponse(header, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="opening-balances-template.csv"`,
    },
  });
}
