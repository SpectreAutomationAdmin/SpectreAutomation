// Payroll-3C-4 (2026-09-09) — Payroll Component catalogue reader.
//
// GET /api/clubs/[id]/payroll/components
//
// Returns the *active*, non-secret slice of the club's Payroll
// Component catalogue for the pre-calculation review UI (used by
// the "add one-time adjustment" form). Requires `payroll:read`.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { listPayrollComponents } from "@/lib/payroll/components-catalogue";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Not authorised" }, { status: 403 });
  try {
    const rows = await listPayrollComponents(principal, params.id, { includeInactive: false });
    return NextResponse.json({
      components: rows.map((c) => ({
        id:                       c.id,
        code:                     c.code,
        displayName:              c.displayName,
        description:              c.description,
        category:                 c.category,
        side:                     c.side,
        cashEffect:               c.cashEffect,
        taxableEffect:            c.taxableEffect,
        cppPensionableEffect:     c.cppPensionableEffect,
        eiInsurableEffect:        c.eiInsurableEffect,
        calculationMethod:        c.calculationMethod,
        eligibleEarningsBase:     c.eligibleEarningsBase,
        statutoryTreatmentSource: c.statutoryTreatmentSource,
        displaySection:           c.displaySection,
        displayOrder:             c.displayOrder,
        active:                   c.active,
      })),
    });
  } catch (err) {
    if (err instanceof ValidationError) return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
    if (err instanceof NotFoundError)   return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ForbiddenError)  return NextResponse.json({ error: err.message }, { status: 403 });
    // eslint-disable-next-line no-console
    console.error("[payroll components list]", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
