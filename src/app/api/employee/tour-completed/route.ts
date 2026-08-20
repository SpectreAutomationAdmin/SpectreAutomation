// HR-2B.5 §39-40 (2026-08-19) — Persist Employee.portalTourCompletedAt.
//
// Called by the client-side tour component when the employee finishes
// or skips the tour. Idempotent — repeated hits update the timestamp
// without any user-visible change.

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";

export const runtime = "nodejs";

export async function POST(_req: NextRequest) {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  await prisma.employee.update({
    where: { id: principal.employeeId },
    data: { portalTourCompletedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
