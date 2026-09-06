// Payroll-3C-5B (2026-09-04) — pay statement PDF download route.
//
// One endpoint serving both viewers:
//   • Employee (Employee-Portal cookie) → `buildEmployeePortalPayStatement`
//     (self only, POSTED only, returns 404 for anything else).
//   • Payroll Admin / Controller (admin cookie) → `buildPayStatement`
//     (requires payroll:read; admin can view CALCULATED / APPROVED /
//     POSTED batches, matching the /paystubs page authorization).
//
// If neither session is present → 401.
//
// The PDF renderer is a pure function of PayStatementV2, so web +
// PDF cannot drift: both surfaces read the same DTO from the same
// loader. Historical immutability follows from the DTO — a POSTED
// batch's DTO does not change when live catalogue values change.
//
// No sensitive data is embedded. The DTO carries no SIN, banking,
// TD1 secure payload, or password hash.

import { NextResponse } from "next/server";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import {
  buildEmployeePortalPayStatement,
  buildPayStatement,
  type PayStatementV2,
} from "@/lib/payroll/pay-statement";
import { renderPayStatementPdf } from "@/lib/payroll/pay-statement-pdf";
import { NotFoundError, ForbiddenError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ batchEmployeeId: string }> },
): Promise<Response> {
  const { batchEmployeeId } = await params;

  let stmt: PayStatementV2 | null = null;

  // 1) Employee Portal — self-service download.
  const employee = await getEmployeePortalPrincipal();
  if (employee) {
    try {
      stmt = await buildEmployeePortalPayStatement({
        clubId: employee.clubId,
        employeeId: employee.employeeId,
        batchEmployeeId,
      });
    } catch (err) {
      if (err instanceof NotFoundError)  return new NextResponse("Not found", { status: 404 });
      if (err instanceof ForbiddenError) return new NextResponse("Forbidden", { status: 403 });
      throw err;
    }
  } else {
    // 2) Admin viewer — needs payroll:read + a valid clubId scope.
    const admin = await getCurrentPrincipal();
    if (!admin) return new NextResponse("Unauthorized", { status: 401 });
    // Resolve clubId from the batchEmployee row itself; the admin
    // may hold clubRoles across multiple clubs, and the row's own
    // clubId is the authoritative scope for the permission check.
    const { prisma } = await import("@/lib/prisma");
    const be = await prisma.payrollBatchEmployee.findUnique({
      where: { id: batchEmployeeId },
      select: { clubId: true },
    });
    if (!be) return new NextResponse("Not found", { status: 404 });
    try {
      stmt = await buildPayStatement(admin, be.clubId, batchEmployeeId);
    } catch (err) {
      if (err instanceof NotFoundError)  return new NextResponse("Not found", { status: 404 });
      if (err instanceof ForbiddenError) return new NextResponse("Forbidden", { status: 403 });
      throw err;
    }
  }

  if (!stmt) return new NextResponse("Not found", { status: 404 });

  const pdf = await renderPayStatementPdf(stmt);
  // Copy the Node Buffer into a fresh ArrayBuffer so the Blob's
  // strict DOM type (BlobPart: BufferSource<ArrayBuffer>) is
  // satisfied without hitting the SharedArrayBuffer union.
  const ab = new ArrayBuffer(pdf.byteLength);
  new Uint8Array(ab).set(pdf);
  const body = new Blob([ab], { type: "application/pdf" });
  const fname = `pay-statement-${stmt.header.payDateIso.slice(0, 10)}-${stmt.header.employeeName.replace(/\s+/g, "-")}.pdf`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fname}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
