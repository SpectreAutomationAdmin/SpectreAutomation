// Payroll-3C-6A (2026-09-05) — GL account picker feed for Payroll Setup.
//
// GET /api/clubs/[id]/payroll/gl-picker
//   Returns the tenant's active Chart-of-Accounts filtered to just
//   the fields the Component GL-mapping UI needs. Never returns raw
//   Account IDs to the caller? — it MUST return the id (that's the
//   value the PATCH endpoint accepts), but the client displays only
//   accountNumber + name to the user.
//
// Cross-tenant safety: `listAccounts` is tenant-scoped via
// tenantWhere(principal, clubId). A user with cross-club roles
// cannot see other Clubs' accounts through this route.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { listAccounts } from "@/lib/accounting/coa";
import { requirePermission } from "@/lib/rbac";
import { ForbiddenError, NotFoundError } from "@/lib/errors";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Not authorised" }, { status: 401 });

  try {
    // Payroll:read is sufficient to browse the picker — WRITE happens
    // via the PATCH endpoint (its own requirePermission).
    requirePermission(principal, params.id, "payroll:read");
    const rows = await listAccounts(principal, params.id, { includeArchived: false });
    // Only surface what the picker renders. NEVER include memoline /
    // vendor / control-ref fields.
    return NextResponse.json({
      accounts: rows
        .filter((a) => a.isActive)
        .map((a) => ({
          id: a.id,
          accountNumber: a.accountNumber,
          name: a.name,
          type: a.type,
        })),
    });
  } catch (err) {
    if (err instanceof NotFoundError)  return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
    // eslint-disable-next-line no-console
    console.error("[payroll gl-picker]", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
