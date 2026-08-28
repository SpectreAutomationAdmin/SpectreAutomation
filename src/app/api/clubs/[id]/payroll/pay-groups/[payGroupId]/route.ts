// Payroll-3B-1 (2026-08-27) — Pay Group PATCH + POST activate/deactivate.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  updatePayGroup,
  setPayGroupActive,
  type UpdatePayGroupInput,
} from "@/lib/payroll/pay-groups";
import type { PayFrequency } from "@/lib/payroll/club-config";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; payGroupId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:write")) return NOT_FOUND;
  let body: UpdatePayGroupInput;
  try {
    body = (await req.json()) as UpdatePayGroupInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const payGroup = await updatePayGroup(principal, params.id, params.payGroupId, {
      name: body.name,
      payFrequency: body.payFrequency as PayFrequency | undefined,
      payDateOffsetDays: body.payDateOffsetDays,
      notes: body.notes,
      active: body.active,
    });
    return NextResponse.json({ payGroup });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; payGroupId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:write")) return NOT_FOUND;
  let body: { action?: "activate" | "deactivate" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    if (body.action === "activate" || body.action === "deactivate") {
      const payGroup = await setPayGroupActive(
        principal,
        params.id,
        params.payGroupId,
        body.action === "activate",
      );
      return NextResponse.json({ payGroup });
    }
    return NextResponse.json({ error: "action must be 'activate' or 'deactivate'" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
