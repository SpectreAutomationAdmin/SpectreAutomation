// REPORT-CHART-1 diagnostic — expose resolved equity series + operating months.
import { NextRequest, NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/services/principal";
import { isSuperAdmin, type Principal } from "@/lib/rbac";
import { getEquityHistory } from "@/lib/reporting/equity-history";
import { getOperatingResults } from "@/lib/reporting/operating-results";

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

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isStaging()) return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  const principal = await requirePrincipal();
  const clubId = (req.nextUrl.searchParams.get("clubId") ?? "").trim();
  if (!clubId) return NextResponse.json({ error: "clubId required" }, { status: 400 });
  if (!hasClubAccess(principal, clubId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const asOf = new Date(Date.UTC(2026, 0, 31, 0, 0, 0, 0));
  const eq = await getEquityHistory(clubId, { asOf });
  const op = await getOperatingResults(clubId, asOf);

  return NextResponse.json({
    asOfRequested: asOf.toISOString(),
    equity: {
      currentEquityCents: eq.currentEquityCents.toString(),
      seriesLength: eq.series.length,
      seriesPoints: eq.series.map((p) => ({
        fiscalYear: p.fiscalYear,
        clubEquityCents: p.clubEquityCents.toString(),
      })),
      perYearOrigin: eq.source.perYear,
    },
    operating: {
      // REPORT-CHART-1A — resolver output only. Months without an
      // authoritative monthly IS observation (e.g. a BS-only snapshot)
      // are OMITTED here, not represented as $0.
      monthsLength: op.months.length,
      months: op.months.map((m) => ({
        monthLabel: m.monthLabel,
        endDate: m.endDate.toISOString(),
        noi: m.noi,
        revenue: m.revenue,
        budgetNoi: m.budgetNoi,
      })),
      ytdNoi: op.ytdNoi,
      ytdRevenue: op.ytdRevenue,
    },
  });
}
