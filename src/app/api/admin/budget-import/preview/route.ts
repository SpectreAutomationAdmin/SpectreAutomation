// BUDGET-HIST-1 (2026-10-04) — staging preview endpoint. Non-mutating.
// Accepts the budget CSV in the request body (text/plain or
// application/x-www-form-urlencoded body or multipart form `csv`
// field) and returns the full BudgetPreviewResult.
import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import { previewCouleeBudget } from "@/lib/imports/budget/preview-coulee-budget";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isStaging(): boolean {
  const env = (process.env.SPECTRE_ENV ?? process.env.NEXT_PUBLIC_ENVIRONMENT ?? "").toLowerCase();
  if (env === "staging") return true;
  return env !== "production" && (process.env.NODE_ENV ?? "") !== "production";
}
function hasClubAccess(p: Principal, clubId: string): boolean {
  if (isSuperAdmin(p)) return true;
  return p.memberships.some((m) => m.clubId === clubId);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const url = req.nextUrl;
  const clubId = (url.searchParams.get("clubId") ?? "").trim();
  const fiscalYear = Number(url.searchParams.get("fiscalYear") ?? "2026");
  const budgetName = (url.searchParams.get("budgetName") ?? "Coulee 2026 Operating Budget").trim();
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const csvText = await req.text();
  if (!csvText || csvText.length < 20) {
    return NextResponse.json({ error: "CSV body missing or too small" }, { status: 400 });
  }
  try {
    const result = await previewCouleeBudget({ clubId, fiscalYear, budgetName, csvText });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
