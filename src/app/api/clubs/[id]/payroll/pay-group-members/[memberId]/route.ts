// Payroll-3B-1 (2026-08-27) — Pay Group Member end.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { endMembership } from "@/lib/payroll/pay-group-members";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; memberId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:write")) return NOT_FOUND;
  let body: { action?: "end"; endAt?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.action !== "end") {
    return NextResponse.json({ error: "action must be 'end'" }, { status: 400 });
  }
  if (!body.endAt) {
    return NextResponse.json({ error: "endAt required" }, { status: 400 });
  }
  try {
    const membership = await endMembership(principal, params.id, params.memberId, new Date(body.endAt));
    return NextResponse.json({ membership });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
