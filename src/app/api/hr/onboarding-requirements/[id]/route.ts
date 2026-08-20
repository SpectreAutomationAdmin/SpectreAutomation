// HR-2B.4 (2026-08-19) — Admin API — single requirement update.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isAppError, ValidationError } from "@/lib/errors";
import { updateOnboardingRequirement } from "@/lib/hr/onboarding-requirements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  try {
    const updated = await updateOnboardingRequirement(principal, params.id, {
      displayName: typeof body.displayName === "string" ? body.displayName : undefined,
      explanation: body.explanation === null || typeof body.explanation === "string" ? (body.explanation as string | null) : undefined,
      documentCategory: body.documentCategory === null || typeof body.documentCategory === "string" ? (body.documentCategory as string | null) : undefined,
      appliesToAll: typeof body.appliesToAll === "boolean" ? body.appliesToAll : undefined,
      appliesToDeptIds: Array.isArray(body.appliesToDeptIds) ? body.appliesToDeptIds as string[] : undefined,
      appliesToPositionIds: Array.isArray(body.appliesToPositionIds) ? body.appliesToPositionIds as string[] : undefined,
      required: typeof body.required === "boolean" ? body.required : undefined,
      requireExpiry: typeof body.requireExpiry === "boolean" ? body.requireExpiry : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
      displayOrder: typeof body.displayOrder === "number" ? body.displayOrder : undefined,
    });
    return NextResponse.json({ requirement: {
      id: updated.id, active: updated.active, required: updated.required,
      appliesToAll: updated.appliesToAll,
    } });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.safeMessage, issues: err.issues }, { status: err.httpStatus });
    }
    if (isAppError(err)) return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
