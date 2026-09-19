// Slice E (2026-09-19) — Payroll Register PDF endpoint.
// Server-side authorization on payroll:read.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { buildPayrollRegister } from "@/lib/payroll/payroll-register";
import { renderPayrollRegisterPdf } from "@/lib/payroll/payroll-register-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx { params: { batchId: string } }

export async function GET(_req: Request, { params }: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  let reg;
  try {
    reg = await buildPayrollRegister(principal, clubId, params.batchId);
  } catch (err) {
    if (err instanceof Error && err.message.includes("available after Calculate")) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
  const pdf = await renderPayrollRegisterPdf(reg);
  const fileName = `payroll-register-${new Date(reg.payPeriod.payDateIso).toISOString().slice(0, 10)}${reg.statePosted ? "-posted" : ""}.pdf`;
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${fileName}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
