// HR-2C Anonymous Feedback — employee submit endpoint (2026-08-27).
//
// Reads the Employee Portal session to resolve `clubId`, then
// discards the employee identity and calls the canonical service
// with clubId + message + optional category only. No employee
// identifier reaches prisma. No employee identifier reaches audit.
// See src/lib/anonymous-feedback.ts for the storage contract.

import { NextRequest, NextResponse } from "next/server";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { submitAnonymousFeedback } from "@/lib/anonymous-feedback";

export async function POST(req: NextRequest) {
  const employee = await getEmployeePortalPrincipal();
  // Neutral 404 for unauthenticated callers — never expose whether
  // an employee session exists.
  if (!employee) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { message?: string; category?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    // Only clubId (derived from the employee session) is threaded
    // through. `employee.employeeId` is DELIBERATELY NOT PASSED.
    const feedback = await submitAnonymousFeedback(employee.clubId, {
      message: body.message ?? "",
      category: body.category ?? null,
    });
    // Return only the neutral confirmation — never echo the record
    // back with identifying fields the client didn't already know.
    return NextResponse.json({ ok: true, id: feedback.id }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
