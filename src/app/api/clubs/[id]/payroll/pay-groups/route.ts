// Payroll-3B-1 (2026-08-27) — Pay Groups list + create.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { listPayGroups, createPayGroup, type CreatePayGroupInput } from "@/lib/payroll/pay-groups";
import type { PayFrequency } from "@/lib/payroll/club-config";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) return NOT_FOUND;
  const payGroups = await listPayGroups(principal, clubId);
  return NextResponse.json({ payGroups });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:write")) return NOT_FOUND;
  let body: CreatePayGroupInput;
  try {
    body = (await req.json()) as CreatePayGroupInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const payGroup = await createPayGroup(principal, clubId, {
      code: body.code,
      name: body.name,
      payFrequency: body.payFrequency as PayFrequency,
      payDateOffsetDays: body.payDateOffsetDays,
      notes: body.notes,
      active: body.active,
    });
    return NextResponse.json({ payGroup }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
