// TB-HIST-10 (2026-10-02) — staging-only read-only diagnostic for
// snapshot-dimensional Department P&L.
//
// GET /api/admin/dept-pl-reconciliation?clubId=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Calls `incomeStatementByDepartmentFromSnapshot(clubId, from, to)`
// and returns the resolver's full output + the reconciliation struct:
//
//   consolidated         { revenue, cogs, opex, netIncome }
//   departmentAssigned   same shape, sum of non-null dept rows
//   nondepartmental      same shape, sum of null-dept rows
//   difference           consolidated - (assigned + nondept) — must
//                        be ≤ $0.01 per field (directive §5)
//   isBalanced           true when every difference is ≤ tolerance
//
// Rejected in production. Requires authenticated principal + tenant
// membership (or SUPER_ADMIN). Zero writes.

import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import { incomeStatementByDepartmentFromSnapshot } from "@/lib/accounting/dept-pl-from-snapshot";

// Force dynamic — this handler reads req.nextUrl + authenticated
// principal; Next.js would otherwise prerender it to a static 404.
export const dynamic = "force-dynamic";

function isStaging(): boolean {
  const env = (process.env.SPECTRE_ENV ?? process.env.NEXT_PUBLIC_ENVIRONMENT ?? "").toLowerCase();
  if (env === "staging") return true;
  return env !== "production" && (process.env.NODE_ENV ?? "") !== "production";
}

function hasClubAccess(p: Principal, clubId: string): boolean {
  if (isSuperAdmin(p)) return true;
  return p.memberships.some((m) => m.clubId === clubId);
}

function parseIsoDate(s: string | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const clubId = (req.nextUrl.searchParams.get("clubId") ?? "").trim();
  if (!clubId) return NextResponse.json({ error: "clubId is required." }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const toRaw = parseIsoDate(req.nextUrl.searchParams.get("to"));
  const fromRaw = parseIsoDate(req.nextUrl.searchParams.get("from"));
  if (!toRaw) return NextResponse.json({ error: "to (YYYY-MM-DD) is required." }, { status: 400 });
  if (!fromRaw) return NextResponse.json({ error: "from (YYYY-MM-DD) is required." }, { status: 400 });
  const from = startOfDay(fromRaw);
  const to = toRaw;

  const result = await incomeStatementByDepartmentFromSnapshot(clubId, from, to);

  // Serialize Decimal → string for JSON transport.
  const asMoney = (n: { toString: () => string }) => n.toString();
  return NextResponse.json({
    clubId,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    source: result.source,
    rows: result.rows.map((r) => ({
      departmentId: r.departmentId,
      departmentCode: r.departmentCode,
      departmentName: r.departmentName,
      revenue: asMoney(r.revenue),
      cogs: asMoney(r.cogs),
      opex: asMoney(r.opex),
      netIncome: asMoney(r.netIncome),
    })),
    totals: {
      revenue: asMoney(result.totals.revenue),
      cogs: asMoney(result.totals.cogs),
      opex: asMoney(result.totals.opex),
      netIncome: asMoney(result.totals.netIncome),
    },
    reconciliation: {
      consolidated: {
        revenue: asMoney(result.reconciliation.consolidated.revenue),
        cogs: asMoney(result.reconciliation.consolidated.cogs),
        opex: asMoney(result.reconciliation.consolidated.opex),
        netIncome: asMoney(result.reconciliation.consolidated.netIncome),
      },
      departmentAssigned: {
        revenue: asMoney(result.reconciliation.departmentAssigned.revenue),
        cogs: asMoney(result.reconciliation.departmentAssigned.cogs),
        opex: asMoney(result.reconciliation.departmentAssigned.opex),
        netIncome: asMoney(result.reconciliation.departmentAssigned.netIncome),
      },
      nondepartmental: {
        revenue: asMoney(result.reconciliation.nondepartmental.revenue),
        cogs: asMoney(result.reconciliation.nondepartmental.cogs),
        opex: asMoney(result.reconciliation.nondepartmental.opex),
        netIncome: asMoney(result.reconciliation.nondepartmental.netIncome),
      },
      difference: {
        revenue: asMoney(result.reconciliation.difference.revenue),
        cogs: asMoney(result.reconciliation.difference.cogs),
        opex: asMoney(result.reconciliation.difference.opex),
        netIncome: asMoney(result.reconciliation.difference.netIncome),
      },
      isBalanced: result.reconciliation.isBalanced,
    },
  });
}
