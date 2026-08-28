// Payroll-3B-1 (2026-08-27) — Pay Group Members list + assign + transfer.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  listMemberships,
  assignMembership,
  transferMembership,
} from "@/lib/payroll/pay-group-members";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) return NOT_FOUND;
  const memberships = await listMemberships(principal, clubId);
  return NextResponse.json({ memberships });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const clubId = params.id;
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:write")) return NOT_FOUND;
  let body: {
    op?: "assign" | "transfer";
    payGroupId?: string;
    toPayGroupId?: string;
    employeeId?: string;
    effectiveFrom?: string;
    effectiveTo?: string | null;
    effectiveAt?: string;
    notes?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    if (body.op === "transfer") {
      if (!body.employeeId || !body.toPayGroupId || !body.effectiveAt) {
        return NextResponse.json(
          { error: "employeeId, toPayGroupId, and effectiveAt required" },
          { status: 400 },
        );
      }
      const result = await transferMembership(principal, clubId, {
        employeeId: body.employeeId,
        toPayGroupId: body.toPayGroupId,
        effectiveAt: new Date(body.effectiveAt),
        notes: body.notes ?? null,
      });
      return NextResponse.json({ transfer: result });
    }
    // default op === "assign"
    if (!body.payGroupId || !body.employeeId || !body.effectiveFrom) {
      return NextResponse.json(
        { error: "payGroupId, employeeId, and effectiveFrom required" },
        { status: 400 },
      );
    }
    const membership = await assignMembership(principal, clubId, {
      payGroupId: body.payGroupId,
      employeeId: body.employeeId,
      effectiveFrom: new Date(body.effectiveFrom),
      effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
      notes: body.notes ?? null,
    });
    return NextResponse.json({ membership }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
