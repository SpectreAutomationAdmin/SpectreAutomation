// MBR-FIX-2H (2026-10-10) — Operating Cost Coverage by Membership Dues.
//
// Live-tenant builder for the Chair's Dashboard "Dues Subsidy" donut.
//
// Founder authorization (2026-10-10) replaced the demo donut's
// hardcoded 15-slice policy allocation with a mathematically valid
// operating cost coverage model:
//
//   • Donut whole        = max(Operating Dues YTD, Σ Operating OpEx YTD)
//   • Donut slices       = per-fsGroupKey operating OpEx as a share
//                          of that whole
//   • Surplus slice      = Operating Dues − Σ Operating OpEx (positive
//                          case; dues cover costs)
//   • Shortfall slice    = Σ Operating OpEx − Operating Dues (negative
//                          case; costs exceed dues)
//
// EVERY amount reconciles to the canonical FS-Group projection
// (`resolveFsGroupProjection`) which itself consumes the committed
// TB via `reportingAccountBalances` + the Account→fsGroup effective-
// dated resolver.  No arbitrary departmental allocation.  No new
// COA classifications.  No hardcoded percentages.  Satisfies the
// "Financial Reporting Data Integrity" chain:
//   Accounting Records → Reporting Service → KPI → Chart.

import { prisma } from "@/lib/prisma";
import { buildReportingPeriod } from "./reporting-period";
import { resolveFsGroupProjection } from "./fs-group-projection";
import {
  buildDuesSubsidyData,
  type DuesCategoryInput,
  type DuesSubsidyData,
} from "./dues-subsidy";

export async function buildOperatingCostCoverageLive(
  clubId: string,
  periodEnd: Date,
): Promise<DuesSubsidyData> {
  const fiscalYearStart = new Date(Date.UTC(periodEnd.getUTCFullYear(), 0, 1));
  const period = buildReportingPeriod(periodEnd, { periodStart: fiscalYearStart });

  const [projection, activeMembers] = await Promise.all([
    resolveFsGroupProjection({ clubId, period }),
    prisma.member
      .count({ where: { clubId, status: "ACTIVE" } })
      .catch(() => 0),
  ]);

  // Operating Dues YTD.  Revenue rows arrive credit-normal (negative)
  // in projection.operatingRevenue — flip sign for the positive
  // display scalar.
  const duesRow = projection.operatingRevenue.find(
    (r) => r.fsGroupKey === "IS_MEMBERSHIP_DUES",
  );
  const operatingDuesYtd = duesRow ? Math.abs(duesRow.ytdActual) : 0;

  // Operating OpEx by fsGroup.  Expense rows arrive positive; drop
  // the Unassigned bucket (null fsGroupKey) because it would collapse
  // multiple unclassified accounts into one unreadable slice —
  // unclassified amounts fall through to the surplus/shortfall slice
  // via the whole-sum identity.
  type Slice = { key: string; label: string; amount: number };
  const opexSlices: Slice[] = projection.operatingExpense
    .filter((r) => r.fsGroupKey != null)
    .map((r) => ({
      key: r.fsGroupKey as string,
      label: r.fsGroupName,
      amount: Math.abs(r.ytdActual),
    }))
    .filter((s) => s.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const totalOpex = opexSlices.reduce((s, r) => s + r.amount, 0);

  // No operating dues YTD → donut cannot render a coverage model.
  // Return an empty-category donut so the React layer renders
  // "Unavailable" via its empty-state handling.  Never fabricate.
  if (operatingDuesYtd === 0) {
    return buildDuesSubsidyData(0, activeMembers, []);
  }

  // Build the final slice list.  Dues > OpEx → surplus; OpEx > Dues
  // → shortfall.  The surplus/shortfall slice is EXPLICIT so the
  // donut tells the correct story end-to-end.
  const slices: Slice[] = [...opexSlices];
  const surplus = operatingDuesYtd - totalOpex;
  if (surplus >= 0) {
    slices.push({
      key: "coverage-surplus",
      label: "Dues Coverage Surplus (NOI, Reserves, Debt Service)",
      amount: surplus,
    });
  } else {
    slices.push({
      key: "coverage-shortfall",
      label: "Operating Shortfall (Costs Exceed Dues)",
      amount: Math.abs(surplus),
    });
  }

  // Mathematical whole: the larger of (dues, opex).  Each slice is a
  // share of that whole so pcts sum cleanly to 100 %.
  const whole = surplus >= 0 ? operatingDuesYtd : totalOpex;
  const categories: DuesCategoryInput[] = slices.map((s) => ({
    key: s.key,
    label: s.label,
    pct: whole > 0 ? (s.amount / whole) * 100 : 0,
  }));

  // Renormalise so pcts sum to exactly 100 (rounding noise).
  const sumPct = categories.reduce((s, c) => s + c.pct, 0);
  if (sumPct > 0 && Math.abs(sumPct - 100) > 0.0001) {
    const scale = 100 / sumPct;
    for (const c of categories) c.pct = c.pct * scale;
  }

  const data = buildDuesSubsidyData(operatingDuesYtd, activeMembers, categories);

  // Coverage semantic — override title / subtitle / pill to be
  // explicit this is a coverage analysis, NOT an allocation of
  // dues (per founder requirement 2026-10-10 §4).  The data source
  // flips to "live" so downstream availability gates stop treating
  // the card as demo.
  return {
    ...data,
    title: "Operating Cost Coverage by Membership Dues",
    subtitle: `OPERATING EXPENSES AS A SHARE OF OPERATING DUES · ${period.periodEndShortLabel} YTD`,
    pillLabel: "COVERAGE RATIO",
    dataSource: "live",
  };
}
