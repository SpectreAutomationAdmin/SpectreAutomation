// Payroll-3B-1 (2026-08-27) — PayrollClubConfig API.
//
// GET   /api/clubs/[id]/payroll/config  — read config + preconditions
// POST  /api/clubs/[id]/payroll/config  — action: "activate" | "deactivate"
// PATCH /api/clubs/[id]/payroll/config  — upsert config fields

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  getPayrollClubConfig,
  upsertPayrollClubConfig,
  activatePayrollClubConfig,
  deactivatePayrollClubConfig,
  checkPayrollActivationPreconditions,
  type UpdatePayrollClubConfigInput,
  type PayFrequency,
  type PaymentMethod,
} from "@/lib/payroll/club-config";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) return NOT_FOUND;
  const [config, preconditions] = await Promise.all([
    getPayrollClubConfig(principal, clubId),
    checkPayrollActivationPreconditions(clubId),
  ]);
  return NextResponse.json({ config, preconditions });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:write")) return NOT_FOUND;
  let body: UpdatePayrollClubConfigInput;
  try {
    body = (await req.json()) as UpdatePayrollClubConfigInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const config = await upsertPayrollClubConfig(principal, clubId, {
      country: body.country,
      provinceOfEmployment: body.provinceOfEmployment,
      defaultPayFrequency: body.defaultPayFrequency as PayFrequency | undefined,
      defaultPaymentMethod: body.defaultPaymentMethod as PaymentMethod | undefined,
      payrollAdminUserId: body.payrollAdminUserId,
      controllerUserId: body.controllerUserId,
      glAccountingProfileId: body.glAccountingProfileId,
      paystubNumberPrefix: body.paystubNumberPrefix,
    });
    return NextResponse.json({ config });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:write")) return NOT_FOUND;
  let body: { action?: "activate" | "deactivate" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    if (body.action === "activate") {
      const config = await activatePayrollClubConfig(principal, clubId);
      return NextResponse.json({ config });
    }
    if (body.action === "deactivate") {
      const config = await deactivatePayrollClubConfig(principal, clubId);
      return NextResponse.json({ config });
    }
    return NextResponse.json({ error: "action must be 'activate' or 'deactivate'" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
