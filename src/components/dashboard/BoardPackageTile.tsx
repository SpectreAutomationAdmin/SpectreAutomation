// Board / member dashboard tile — Monthly Reporting Package.
//
// Visible to board members + recipients. Renders the SAME
// "At a Glance" 2x2 KPI block as the report's Executive Opening
// cover by reusing `<AtAGlanceBlock>`. No redesign here; the
// founder's spec is explicit:
//
//   "The widget should be an exact visual copy of the 'At a
//    Glance' section from the Executive Opening page of the
//    Monthly Reporting Package."
//
// Status pills are deliberately NOT rendered. The board member
// doesn't need to know the publication state — if the tile
// appears, it's understood to be the current live package. The
// only badge that can appear is the NEW indicator (per-user).
//
// "See more" routes to /app/reports/monthly-package/[id] — the
// dedicated read-only board surface (no Publish / Update /
// Archive admin controls). The id comes from the service helper
// `getMostRecentBoardPackageForUser` which always resolves to the
// most-recent PUBLISHED/SENT package for the club, so the link
// automatically tracks newer publications.

import Link from "next/link";

import {
  AtAGlanceBlock,
  type AtAGlanceMetric,
} from "@/components/reporting/AtAGlanceBlock";
import type { BoardTilePackage } from "@/lib/reporting/monthly-package-lifecycle";

type Props = {
  pkg: BoardTilePackage;
};

/** Pluck the four canonical cover keys out of the snapshot's
 *  atAGlanceKpis array in the fixed source order the report
 *  cover renders. KPIs missing from the snapshot are skipped
 *  (graceful — the snapshot might be empty for legacy demo data). */
function pluckCoverMetrics(
  rawKpis: BoardTilePackage["atAGlanceKpis"],
): AtAGlanceMetric[] {
  const COVER_KEYS = ["ytd-revenue", "noi", "capital-income", "reserve-coverage"] as const;
  const out: AtAGlanceMetric[] = [];
  for (const key of COVER_KEYS) {
    const kpi = rawKpis.find((k) => k.key === key);
    if (!kpi) continue;
    const label = (kpi.label ?? kpi.key ?? "") as string;
    const value =
      typeof kpi.value === "number"
        ? kpi.value.toLocaleString()
        : kpi.value == null
          ? "—"
          : String(kpi.value);
    // Captured comparison.variance may live at either `variance`
    // or `comparison.variance` depending on the snapshot vintage.
    const rawKpiAny = kpi as unknown as {
      variance?: string | null;
      comparison?: { variance?: string | null };
    };
    const variance: string | null =
      rawKpiAny.variance ?? rawKpiAny.comparison?.variance ?? null;
    out.push({ key: kpi.key ?? key, label, value, variance });
  }
  return out;
}

export function BoardPackageTile({ pkg }: Props) {
  // See more → the dedicated board-facing READ-ONLY view. The
  // service resolves the most-recent PUBLISHED/SENT package per
  // user, so this id automatically tracks the latest publication
  // (older periods become ARCHIVED on republish and stop surfacing
  // on the tile).
  const seeMoreHref = `/app/reports/monthly-package/${pkg.id}`;
  const metrics = pluckCoverMetrics(pkg.atAGlanceKpis);

  return (
    <section
      className="card bg-club-cream/40 px-6 py-5 lg:px-8 lg:py-6"
      data-testid="board-package-tile"
      aria-labelledby="board-package-tile-title"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2
            id="board-package-tile-title"
            className="section-title text-lg"
          >
            Monthly Reporting Package
          </h2>
          {/* NEW badge — per-user. The ONLY status indicator that
              ever appears on the widget per the founder's spec.
              Cleared on first view for THIS user (see
              markPackageViewedByUser); other board members still
              see NEW until they personally open the package. */}
          {pkg.isNewForUser && (
            <span
              className="inline-flex items-center rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white"
              data-testid="board-package-tile-new-badge"
              aria-label="New monthly package — not yet opened by you"
            >
              New
            </span>
          )}
        </div>
        <p
          className="text-sm text-stone-600"
          data-testid="board-package-tile-period"
        >
          {pkg.periodLabel}
        </p>
      </header>

      {/* The at-a-glance block — identical to the cover. */}
      {metrics.length > 0 ? (
        <AtAGlanceBlock
          metrics={metrics}
          testIdPrefix="board-package-tile-at-a-glance"
          ariaLabel="Monthly Reporting Package — At a glance"
        />
      ) : (
        <p
          className="mt-5 border-t border-club-sand/70 pt-3 text-xs text-stone-500"
          data-testid="board-package-tile-kpis-empty"
        >
          At-a-Glance KPIs were not captured for this package. Open
          the package to see the full document.
        </p>
      )}

      <footer className="mt-5 border-t border-club-sand/40 pt-3">
        <Link
          href={seeMoreHref}
          className="text-sm font-medium text-club-green-700 hover:underline"
          data-testid="board-package-tile-see-more"
        >
          See more →
        </Link>
      </footer>
    </section>
  );
}
