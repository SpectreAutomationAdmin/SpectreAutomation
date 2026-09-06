// Payroll-3C-6A (2026-09-05) — Component GL mapping edit API.
//
// PATCH /api/clubs/[id]/payroll/components/[componentId]/gl-mapping
//   Updates the live component's `expenseAccountId` and/or
//   `liabilityAccountId`. Both fields are individually nullable so
//   the caller can clear a mapping (e.g. after moving a component
//   to a different account). Validation + tenant scoping happens
//   inside `upsertPayrollComponent`; this route is a thin transport.
//
// The change is FUTURE-ONLY (§7 of the 3C-6A brief) — historical
// batches already have frozen `expenseAccountIdSnapshot` /
// `liabilityAccountIdSnapshot` on every `PayrollBatchComponentSnapshot`
// row, so a mapping edit here cannot rewrite the accounting of any
// posted, approved, or calculated batch.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { prisma } from "@/lib/prisma";
import { upsertPayrollComponent } from "@/lib/payroll/components-catalogue";
import { assertTenantOwned } from "@/lib/services/tenant";
import { audit } from "@/lib/audit";
import { requirePermission } from "@/lib/rbac";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

const Body = z.object({
  expenseAccountId:   z.string().nullable().optional(),
  liabilityAccountId: z.string().nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; componentId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Not authorised" }, { status: 401 });

  try {
    requirePermission(principal, params.id, "payroll:write");

    const raw = await req.json();
    const parsed = Body.parse(raw);

    // Load the current component so we can (a) verify tenant, (b) capture
    // the before-state for audit, (c) call upsert with the FULL current
    // shape (the service does not accept partial patches — passing only
    // the changed fields would blank the rest).
    const current = await prisma.payrollComponent.findUnique({
      where: { id: params.componentId },
      select: {
        id: true, clubId: true,
        code: true, displayName: true, description: true,
        category: true, side: true, cashEffect: true,
        taxableEffect: true, cppPensionableEffect: true, eiInsurableEffect: true,
        calculationMethod: true, eligibleEarningsBase: true,
        statutoryTreatmentSource: true, statutoryRuleKey: true, statutoryRuleVariant: true,
        taxFormulaDeductionType: true, glAccountId: true,
        expenseAccountId: true, liabilityAccountId: true,
        displaySection: true, displayOrder: true,
        active: true, notes: true,
      },
    });
    if (!current) return NextResponse.json({ error: "Component not found" }, { status: 404 });
    assertTenantOwned(current, principal);
    if (current.clubId !== params.id) {
      return NextResponse.json({ error: "Component not found in this club" }, { status: 404 });
    }

    const newExpense   = parsed.expenseAccountId   ?? null;
    const newLiability = parsed.liabilityAccountId ?? null;

    // Short-circuit: nothing to change.
    if (newExpense === current.expenseAccountId && newLiability === current.liabilityAccountId) {
      return NextResponse.json({ id: current.id, changed: false });
    }

    // Delegate to canonical upsert — same-club account validation,
    // effect-flag coherence, SPECTRE_LIBRARY provenance guard.
    const result = await upsertPayrollComponent(principal, params.id, {
      code:                     current.code,
      displayName:              current.displayName,
      description:              current.description,
      category:                 current.category as never,
      side:                     current.side as never,
      cashEffect:               current.cashEffect as never,
      taxableEffect:            current.taxableEffect as never,
      cppPensionableEffect:     current.cppPensionableEffect as never,
      eiInsurableEffect:        current.eiInsurableEffect as never,
      calculationMethod:        current.calculationMethod as never,
      eligibleEarningsBase:     current.eligibleEarningsBase as never,
      statutoryTreatmentSource: current.statutoryTreatmentSource as never,
      statutoryRuleKey:         current.statutoryRuleKey,
      statutoryRuleVariant:     current.statutoryRuleVariant,
      taxFormulaDeductionType:  current.taxFormulaDeductionType,
      glAccountId:              current.glAccountId,
      expenseAccountId:         newExpense,
      liabilityAccountId:       newLiability,
      displaySection:           current.displaySection as never,
      displayOrder:             current.displayOrder,
      active:                   current.active,
      notes:                    current.notes,
    });

    // Dedicated audit trail for GL-mapping changes — the canonical
    // upsert also audits, but this row makes the before/after account
    // change explicit for finance review.
    await audit(principal, {
      clubId: params.id,
      action: "payroll.component.gl-mapping.update",
      entityType: "PayrollComponent",
      entityId: current.id,
      before: {
        expenseAccountId:   current.expenseAccountId,
        liabilityAccountId: current.liabilityAccountId,
      },
      after: {
        expenseAccountId:   newExpense,
        liabilityAccountId: newLiability,
      },
    });

    return NextResponse.json({ id: result.id, changed: true });
  } catch (err) {
    if (err instanceof z.ZodError)      return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
    if (err instanceof ValidationError) return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
    if (err instanceof NotFoundError)   return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ForbiddenError)  return NextResponse.json({ error: err.message }, { status: 403 });
    // eslint-disable-next-line no-console
    console.error("[payroll gl-mapping PATCH]", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
