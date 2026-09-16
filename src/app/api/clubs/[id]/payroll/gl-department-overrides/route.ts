// Phase 3 (2026-09-15) — Payroll GL department-override HTTP surface.
//
// PATCH /api/clubs/[id]/payroll/gl-department-overrides
//   Upsert one per-department override row. Payload accepts one
//   departmentId plus the three optional expense-account overrides.
//   Passing null for every field deletes the override row (which
//   returns this department to inheriting the global default).
//
// GET /api/clubs/[id]/payroll/gl-department-overrides
//   List every override stored for this Club.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentPrincipal } from "@/lib/services/principal";
import {
  listDepartmentOverrides,
  upsertDepartmentOverride,
} from "@/lib/payroll/gl-department-overrides";
import { ForbiddenError, NotFoundError, ConflictError, ValidationError } from "@/lib/errors";

const Body = z.object({
  departmentId:                z.string().min(1),
  salaryExpenseAccountId:      z.string().nullable(),
  employerCppExpenseAccountId: z.string().nullable(),
  employerEiExpenseAccountId:  z.string().nullable(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  try {
    const rows = await listDepartmentOverrides(principal, params.id);
    return NextResponse.json({ overrides: rows });
  } catch (err) {
    if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
    // eslint-disable-next-line no-console
    console.error("[payroll gl-department-overrides GET]", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  try {
    const parsed = Body.parse(await req.json());
    const row = await upsertDepartmentOverride(principal, params.id, parsed);
    return NextResponse.json({ override: row });
  } catch (err) {
    if (err instanceof z.ZodError)      return NextResponse.json({ error: "Invalid input", details: err.issues }, { status: 400 });
    if (err instanceof ValidationError) return NextResponse.json({ error: err.safeMessage, details: err.issues }, { status: 400 });
    if (err instanceof ConflictError)   return NextResponse.json({ error: err.safeMessage }, { status: 409 });
    if (err instanceof NotFoundError)   return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof ForbiddenError)  return NextResponse.json({ error: err.message }, { status: 403 });
    // eslint-disable-next-line no-console
    console.error("[payroll gl-department-overrides PATCH]", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
