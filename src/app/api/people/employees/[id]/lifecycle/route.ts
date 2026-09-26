// HR-2B.3.6 (2026-08-19) — Employee lifecycle mutations.
// AUTH-3D.TEST-B.UNBLOCK (2026-09-26) — added `action: "terminate"` so
// there is a supported HTTP surface for the canonical `terminateEmployee`
// service (which already existed and is transactionally wired to session
// revocation by AUTH-3B). No business logic duplicated here — this
// route is a thin dispatcher onto the accepted services. Authorization
// is enforced INSIDE each service; forged action strings from principals
// without the required grant still fail closed.
//
// Three verbs on one endpoint keep the client-side simple and pin the
// eligibility invariant server-side:
//
//   POST   /api/people/employees/[id]/lifecycle  {action: "archive", reason?}
//     → hard-set employeeLifecycle=ARCHIVED. Reversible in principle
//       (no data loss); this slice ships one-way only per §2.2.
//     → authorization: hr:employee:write (service-enforced).
//
//   POST   /api/people/employees/[id]/lifecycle  {action: "terminate",
//                                                 terminationDate?, reason?}
//     → ends the employment relationship. Employee record preserved
//       (payroll / tax / documents / audit intact). AUTH-3B canonical
//       terminateEmployee transactionally revokes active EMPLOYEE
//       Sessions with reason "lifecycle:terminate".
//     → authorization: hr:employee:terminate (service-enforced).
//
//   DELETE /api/people/employees/[id]/lifecycle  {reason?}
//     → hard delete. Refuses if the canonical eligibility check fails
//       (onboarding terminal state / payroll history / timesheet
//       history / active employment period). Deletes related HR rows
//       in FK-safe order inside a transaction.
//     → authorization: hr:employee:write (service-enforced).
//
// All three require the appropriate permission via the service-layer
// requirePermission() call; tenant scope is enforced by loadEmployee.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { archiveEmployee, deleteEmployee, terminateEmployee } from "@/lib/hr/employees";
import { isAppError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LifecycleBody {
  action?: string;
  reason?: string;
  /** AUTH-3D.TEST-B.UNBLOCK — terminate action only. Optional; service
   *  defaults to the current server time when omitted. Accepts ISO date
   *  or full ISO timestamp; the service normalises via toOptionalDate. */
  terminationDate?: string;
}

async function readBody(req: NextRequest): Promise<LifecycleBody> {
  try {
    const raw = await req.json();
    if (raw && typeof raw === "object") return raw as LifecycleBody;
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

  try {
    if (body.action === "archive") {
      const updated = await archiveEmployee(principal, params.id, { reason: body.reason });
      return NextResponse.json({
        id: updated.id,
        employeeLifecycle: updated.employeeLifecycle,
      });
    }
    if (body.action === "terminate") {
      // AUTH-3D.TEST-B.UNBLOCK — dispatch to the accepted AUTH-3B service.
      // Authorization (hr:employee:terminate) + sensitive-action guard +
      // transactional revoke all live inside the service; the route is
      // purely a dispatcher.
      const updated = await terminateEmployee(principal, params.id, {
        terminationDate: body.terminationDate ?? new Date(),
        reason: body.reason,
      });
      return NextResponse.json({
        id: updated.id,
        employeeLifecycle: updated.employeeLifecycle,
        status: updated.status,
        terminationDate: updated.terminationDate,
      });
    }
    return NextResponse.json({ error: "Unknown lifecycle action" }, { status: 400 });
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
