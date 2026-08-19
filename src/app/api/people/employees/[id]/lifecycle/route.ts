// HR-2B.3.6 (2026-08-19) — Employee lifecycle mutations.
//
// Two verbs on one endpoint keep the client-side simple and pin the
// eligibility invariant server-side:
//
//   POST   /api/people/employees/[id]/lifecycle  {action: "archive", reason?}
//     → hard-set employeeLifecycle=ARCHIVED. Reversible in principle
//       (no data loss); this slice ships one-way only per §2.2.
//
//   DELETE /api/people/employees/[id]/lifecycle  {reason?}
//     → hard delete. Refuses if the canonical eligibility check fails
//       (onboarding terminal state / payroll history / timesheet
//       history / active employment period). Deletes related HR rows
//       in FK-safe order inside a transaction.
//
// Both routes require `hr:employee:write` and sensitive-action guard;
// tenant scope is enforced by loadEmployee in the service.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { archiveEmployee, deleteEmployee } from "@/lib/hr/employees";
import { isAppError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readBody(req: NextRequest): Promise<{ action?: string; reason?: string }> {
  try {
    const raw = await req.json();
    if (raw && typeof raw === "object") return raw as { action?: string; reason?: string };
  } catch { /* empty body is fine */ }
  return {};
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const body = await readBody(req);
  if (body.action !== "archive") {
    return NextResponse.json({ error: "Unknown lifecycle action" }, { status: 400 });
  }

  try {
    const updated = await archiveEmployee(principal, params.id, { reason: body.reason });
    return NextResponse.json({
      id: updated.id,
      employeeLifecycle: updated.employeeLifecycle,
    });
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const body = await readBody(req);
  try {
    await deleteEmployee(principal, params.id, { reason: body.reason });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
