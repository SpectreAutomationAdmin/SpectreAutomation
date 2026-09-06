// Payroll-3C-6A (2026-09-05) — Global Payroll GL Accounting Profile editor.
//
// PATCH /api/clubs/[id]/payroll/gl-profile
//   Upserts the 8 tenant-global statutory + clearing accounts on
//   PayrollGlAccountingProfile and links it via PayrollClubConfig.
//   Every field is validated against the tenant's Chart-of-Accounts
//   (same-club + isActive). Missing accounts are refused loudly so
//   the caller cannot silently save an incomplete profile.
//
// Snapshot behaviour: the global profile is loaded LIVE at post time
// (per §20 of the 3C-6A brief). A change here applies to the NEXT
// post — historical posted journals stay immutable because they hold
// the JournalEntryLine.accountId at the time they were posted.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { requirePermission } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

const Body = z.object({
  salaryExpenseAccountId:        z.string(),
  employerCppExpenseAccountId:   z.string(),
  employerEiExpenseAccountId:    z.string(),
  netPayPayableAccountId:        z.string(),
  cppPayableAccountId:           z.string(),
  eiPayableAccountId:            z.string(),
  federalTaxPayableAccountId:    z.string(),
  provincialTaxPayableAccountId: z.string(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  try {
    requirePermission(principal, params.id, "payroll:write");
    const raw = await req.json();
    const parsed = Body.parse(raw);

    // Validate every account id belongs to this club AND is active.
    const ids = Object.values(parsed);
    const rows = await prisma.account.findMany({
      where: { id: { in: ids }, clubId: params.id, isActive: true },
      select: { id: true, type: true },
    });
    const foundIds = new Set(rows.map((r) => r.id));
    for (const [field, id] of Object.entries(parsed)) {
      if (!foundIds.has(id)) {
        return NextResponse.json({
          error: `Account for ${field} is not in this club or is inactive.`,
        }, { status: 400 });
      }
    }
    // Type-appropriateness guard: expenses must be EXPENSE, payables must be LIABILITY.
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const typeExpectations: Record<keyof typeof parsed, "EXPENSE" | "LIABILITY"> = {
      salaryExpenseAccountId:        "EXPENSE",
      employerCppExpenseAccountId:   "EXPENSE",
      employerEiExpenseAccountId:    "EXPENSE",
      netPayPayableAccountId:        "LIABILITY",
      cppPayableAccountId:           "LIABILITY",
      eiPayableAccountId:            "LIABILITY",
      federalTaxPayableAccountId:    "LIABILITY",
      provincialTaxPayableAccountId: "LIABILITY",
    };
    for (const [field, want] of Object.entries(typeExpectations)) {
      const acct = rowById.get(parsed[field as keyof typeof parsed]);
      if (acct && acct.type !== want) {
        return NextResponse.json({
          error: `Account for ${field} must be type ${want} (got ${acct.type}).`,
        }, { status: 400 });
      }
    }

    // Load current profile for audit before/after.
    const before = await prisma.payrollGlAccountingProfile.findUnique({
      where: { clubId: params.id },
    });

    const profile = await prisma.payrollGlAccountingProfile.upsert({
      where: { clubId: params.id },
      update: parsed,
      create: { clubId: params.id, ...parsed },
    });
    // Link the club-config to the profile if not already.
    await prisma.payrollClubConfig.upsert({
      where: { clubId: params.id },
      update: { glAccountingProfileId: profile.id },
      create: { clubId: params.id, glAccountingProfileId: profile.id },
    });

    await audit(principal, {
      clubId: params.id,
      action: "payroll.gl-profile.update",
      entityType: "PayrollGlAccountingProfile",
      entityId: profile.id,
      before: before ? {
        salaryExpenseAccountId:        before.salaryExpenseAccountId,
        employerCppExpenseAccountId:   before.employerCppExpenseAccountId,
        employerEiExpenseAccountId:    before.employerEiExpenseAccountId,
        netPayPayableAccountId:        before.netPayPayableAccountId,
        cppPayableAccountId:           before.cppPayableAccountId,
        eiPayableAccountId:            before.eiPayableAccountId,
        federalTaxPayableAccountId:    before.federalTaxPayableAccountId,
        provincialTaxPayableAccountId: before.provincialTaxPayableAccountId,
      } : null,
      after: parsed,
    });

    return NextResponse.json({ id: profile.id });
  } catch (err) {
    if (err instanceof z.ZodError)      return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
    if (err instanceof ValidationError) return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
    if (err instanceof NotFoundError)   return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ForbiddenError)  return NextResponse.json({ error: err.message }, { status: 403 });
    // eslint-disable-next-line no-console
    console.error("[payroll gl-profile PATCH]", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
