// HR-2B.4 (2026-08-19) — Admin API — list + create onboarding requirements.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isAppError, ValidationError } from "@/lib/errors";
import {
  createOnboardingRequirement,
  listClubOnboardingRequirements,
} from "@/lib/hr/onboarding-requirements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  try {
    const rows = await listClubOnboardingRequirements(principal, clubId, { includeInactive: true });
    return NextResponse.json({
      requirements: rows.map((r) => ({
        id: r.id, code: r.code, displayName: r.displayName, explanation: r.explanation,
        kind: r.kind, documentCategory: r.documentCategory,
        appliesToAll: r.appliesToAll,
        appliesToDeptIds: (() => { try { return JSON.parse(r.appliesToDeptIds ?? "[]"); } catch { return []; } })(),
        appliesToPositionIds: (() => { try { return JSON.parse(r.appliesToPositionIds ?? "[]"); } catch { return []; } })(),
        required: r.required, requireExpiry: r.requireExpiry, active: r.active, displayOrder: r.displayOrder,
      })),
    });
  } catch (err) {
    if (isAppError(err)) return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  try {
    const created = await createOnboardingRequirement(principal, clubId, {
      code: String(body.code ?? ""),
      displayName: String(body.displayName ?? ""),
      explanation: body.explanation == null ? null : String(body.explanation),
      kind: String(body.kind ?? ""),
      documentCategory: body.documentCategory == null ? null : String(body.documentCategory),
      appliesToAll: !!body.appliesToAll,
      appliesToDeptIds: Array.isArray(body.appliesToDeptIds) ? body.appliesToDeptIds as string[] : [],
      appliesToPositionIds: Array.isArray(body.appliesToPositionIds) ? body.appliesToPositionIds as string[] : [],
      required: body.required !== false,
      requireExpiry: !!body.requireExpiry,
      active: body.active !== false,
      displayOrder: typeof body.displayOrder === "number" ? body.displayOrder : 0,
    });
    return NextResponse.json({
      requirement: {
        id: created.id, code: created.code, displayName: created.displayName,
        kind: created.kind, active: created.active, required: created.required,
        appliesToAll: created.appliesToAll,
        appliesToDeptIds: (() => { try { return JSON.parse(created.appliesToDeptIds ?? "[]"); } catch { return []; } })(),
        appliesToPositionIds: (() => { try { return JSON.parse(created.appliesToPositionIds ?? "[]"); } catch { return []; } })(),
        documentCategory: created.documentCategory, explanation: created.explanation,
        requireExpiry: created.requireExpiry, displayOrder: created.displayOrder,
      },
    }, { status: 201 });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.safeMessage, issues: err.issues }, { status: err.httpStatus });
    }
    if (isAppError(err)) return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
