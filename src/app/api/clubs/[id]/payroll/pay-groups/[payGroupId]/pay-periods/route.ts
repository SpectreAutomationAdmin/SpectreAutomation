// Payroll-3B-2 (2026-08-28) — Pay Period list + generate.
//
// GET  ?taxYear=YYYY  — list this pay group's periods for a year
// POST { action: "generate", taxYear }  — deterministically create
// POST { action: "preview",  taxYear }  — pure preview (no DB writes)

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  listPayPeriods,
  previewPayPeriods,
  generatePayPeriods,
} from "@/lib/payroll/pay-periods";

const NOT_FOUND = NextResponse.json({ error: "Not found" }, { status: 404 });

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; payGroupId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, params.id, "payroll:read")) return NOT_FOUND;
  const url = new URL(req.url);
  const taxYearParam = url.searchParams.get("taxYear");
  const taxYear = taxYearParam ? Number(taxYearParam) : undefined;
  const periods = await listPayPeriods(principal, params.id, {
    payGroupId: params.payGroupId,
    ...(Number.isInteger(taxYear) ? { taxYear } : {}),
  });
  return NextResponse.json({ periods });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; payGroupId: string } },
) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NOT_FOUND;
  let body: { action?: "generate" | "preview"; taxYear?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Number.isInteger(body.taxYear ?? -1)) {
    return NextResponse.json({ error: "taxYear (integer) required" }, { status: 400 });
  }
  try {
    if (body.action === "preview") {
      if (!hasPermission(principal, params.id, "payroll:read")) return NOT_FOUND;
      const periods = await previewPayPeriods(principal, params.id, params.payGroupId, body.taxYear!);
      return NextResponse.json({ preview: periods });
    }
    if (body.action === "generate") {
      if (!hasPermission(principal, params.id, "payroll:write")) return NOT_FOUND;
      const result = await generatePayPeriods(principal, params.id, params.payGroupId, body.taxYear!);
      return NextResponse.json({ result });
    }
    return NextResponse.json({ error: "action must be 'generate' or 'preview'" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
