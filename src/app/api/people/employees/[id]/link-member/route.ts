// HR-2A (2026-08-16) — POST /api/people/employees/[id]/link-member.
//
// Delegates to the canonical `linkEmployeeToMember` service. The
// service enforces:
//   • `hr:employee:write` on the Employee's club.
//   • The Employee is owned by the caller's tenant (via
//     `assertTenantOwned`).
//   • The target Member's `clubId` matches the Employee's `clubId`
//     — cross-club links are refused with `TenantViolationError`
//     EVEN FOR SUPER-ADMIN.
//   • A friendly conflict if the Member is already linked to
//     another Employee.
//
// This route never touches Prisma directly.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isAppError, TenantViolationError } from "@/lib/errors";
import { linkEmployeeToMember } from "@/lib/hr/employees";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  let body: { memberId?: unknown; replace?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const memberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
  if (!memberId) {
    return NextResponse.json({ error: "memberId is required" }, { status: 400 });
  }
  const replace = body.replace === true;

  try {
    const updated = await linkEmployeeToMember(principal, params.id, memberId, { replace });
    return NextResponse.json({ employeeId: updated.id, memberId: updated.memberId });
  } catch (err) {
    if (err instanceof TenantViolationError) {
      return NextResponse.json(
        { error: "Member belongs to a different club." },
        { status: 403 },
      );
    }
    if (isAppError(err)) {
      return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
