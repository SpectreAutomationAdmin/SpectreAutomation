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
    // Hotfix (2026-09-13): the previous generic "Server error" hid the
    // FK constraint that was actually blocking delete (missing child-row
    // cleanup for EmployeeAvailabilityProfile / OnboardingStateTransition).
    // Log the raw error server-side; return a specific-but-safe message
    // to the client so ambiguous failures are diagnosable in the wild.
    const raw = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("[people.employees.delete] internal error", { employeeId: params.id, raw });
    if (/foreign key constraint/i.test(raw) || /RESTRICT setting/i.test(raw)) {
      return NextResponse.json({
        error: "Delete failed — this employee still has protected history that could not be cleaned up. Please report this so it can be fixed.",
      }, { status: 500 });
    }
    return NextResponse.json({ error: "Server error while deleting employee." }, { status: 500 });
  }
}
