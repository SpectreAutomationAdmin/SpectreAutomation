// Monthly Reporting Package — launcher.
//
// Lives at /app/admin/governance/monthly-package (under the admin
// Governance hub, OUTSIDE /app/admin/reporting/** so it inherits the
// regular admin sidebar + topbar instead of the bare board-package
// shell that wraps the document itself).
//
// Purpose: the sidebar "Monthly Package" link used to deep-link
// straight into the May 31, 2026 board document — a hardcoded route
// that pretended the controller had already chosen a period. This
// launcher is the explicit period-selection step that was missing.
//
// Surfaces (top → bottom):
//   1. Hero — title + descriptive paragraph (admin-page convention).
//   2. "Generate a package" card — Month + Year dropdowns, primary
//      "Generate Monthly Package" CTA, secondary "View Archive" link
//      pointing at the Board Packages archive.
//   3. "Recent periods" quick-launch — six rolling months, one click
//      each, for the common controller workflow of "I want last month."
//
// The board document at /app/admin/reporting/monthly is unchanged
// and still resolves directly. The launcher just sits in front of it
// so the controller picks the period explicitly.

import Link from "next/link";
import { redirect } from "next/navigation";

import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { getCurrentPrincipal } from "@/lib/services/principal";

import { LauncherForm } from "./LauncherForm";

// ---------------------------------------------------------------------------
// Period selection — month/year ranges + recent-period quick links.
//
// Render-time is held deterministic via a fixed anchor (the day the
// launcher was specced) instead of `new Date()`. The founder bumps
// the anchor when they want the launcher's recents window to roll
// forward; the previous design's call into Date.now() would have
// drifted by the time the demo was watched.
// ---------------------------------------------------------------------------

const ANCHOR_YEAR = 2026;
const ANCHOR_MONTH = 6; // June 2026

const YEAR_RANGE: ReadonlyArray<number> = (() => {
  // 5-year window — 3 years of history + the anchor year + 1 year
  // forward (for forecast/budget-period workflows).
  const start = ANCHOR_YEAR - 3;
  const end = ANCHOR_YEAR + 1;
  const ys: number[] = [];
  for (let y = end; y >= start; y--) ys.push(y);
  return ys;
})();

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

type RecentPeriod = {
  periodKey: string;       // YYYY-MM
  monthLabel: string;      // "May"
  year: number;            // 2026
  periodEndLabel: string;  // "May 31, 2026"
};

function buildRecentPeriods(count = 6): ReadonlyArray<RecentPeriod> {
  const out: RecentPeriod[] = [];
  let year = ANCHOR_YEAR;
  let month = ANCHOR_MONTH - 1; // most recently COMPLETED month
  for (let i = 0; i < count; i++) {
    if (month <= 0) {
      year -= 1;
      month += 12;
    }
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    out.push({
      periodKey: `${year}-${String(month).padStart(2, "0")}`,
      monthLabel: MONTH_NAMES[month - 1],
      year,
      periodEndLabel: `${MONTH_NAMES[month - 1]} ${lastDay}, ${year}`,
    });
    month -= 1;
  }
  return out;
}

// The View Archive button targets the dedicated Monthly Package
// archive at /archive (this route's child). The legacy generic
// Board Packages archive at /app/admin/governance/packages is
// reachable from the Governance hub for the multi-purpose packaging
// flow — it's a different surface that distributes any report bundle.
const ARCHIVE_HREF = "/app/admin/governance/monthly-package/archive";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type LauncherPageProps = {
  /** Optional `?month=X&year=Y` from the close-button on the report
   *  (or any deep-link). When valid, pre-selects the form so the
   *  operator lands back on the period they were just viewing. */
  searchParams?: { month?: string; year?: string };
};

function parseLauncherDefaults(
  searchParams: LauncherPageProps["searchParams"],
  fallback: { reportingMonth: number; reportingYear: number },
): { defaultMonth: number; defaultYear: number } {
  const m = Number(searchParams?.month);
  const y = Number(searchParams?.year);
  const monthOk = Number.isInteger(m) && m >= 1 && m <= 12;
  const yearOk = Number.isInteger(y) && y >= 1900 && y <= 9999;
  return {
    defaultMonth: monthOk ? m : fallback.reportingMonth,
    defaultYear: yearOk ? y : fallback.reportingYear,
  };
}

export default async function MonthlyPackageLauncherPage({
  searchParams,
}: LauncherPageProps) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!hasPermission(principal, clubId, "reports:board")) redirect("/app/admin");

  const recents = buildRecentPeriods();
  // Defaults: when the user landed here from the report's close
  // button, the URL carries `?month=X&year=Y` for the period they
  // were viewing — pre-select that. Otherwise the most recently
  // completed month is the controller's most-likely target.
  const fallbackDefault = {
    reportingMonth: Number(recents[0].periodKey.split("-")[1]),
    reportingYear: recents[0].year,
  };
  const { defaultMonth, defaultYear } = parseLauncherDefaults(searchParams, fallbackDefault);

  return (
    <div data-testid="monthly-package-launcher">
      {/* Hero ------------------------------------------------------------*/}
      <h1 className="page-title">Monthly Reporting Package</h1>
      <p className="mt-1 text-stone-500">
        Pick the period you want to open. The package renders the
        statements, scorecards, and commentary as they stood at month
        end for that period — no further configuration required.
      </p>

      {/* Generate a package ---------------------------------------------*/}
      <section
        className="mt-8 card card-body"
        aria-labelledby="launcher-generate-heading"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2
              id="launcher-generate-heading"
              className="section-title text-lg"
            >
              Generate a package
            </h2>
            <p className="mt-1 text-xs text-stone-600">
              Select the month and year. The package opens in the board
              reporting view.
            </p>
          </div>
          <div className="text-xs uppercase tracking-wide text-stone-400">
            Step 1 of 1
          </div>
        </div>

        <LauncherForm
          years={YEAR_RANGE}
          defaultMonth={defaultMonth}
          defaultYear={defaultYear}
          archiveHref={ARCHIVE_HREF}
        />
      </section>

      {/* Recent periods quick-launch ------------------------------------*/}
      <section
        className="mt-6 card overflow-hidden"
        aria-labelledby="launcher-recent-heading"
      >
        <div className="px-6 py-4 border-b border-stone-200 flex items-baseline justify-between gap-3">
          <h2
            id="launcher-recent-heading"
            className="section-title text-base"
          >
            Recent periods
          </h2>
          <span className="text-xs text-stone-500">
            One-click access to the last {recents.length} completed months
          </span>
        </div>
        <table className="table-base" data-testid="launcher-recent-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Period end</th>
              <th className="text-right">Open</th>
            </tr>
          </thead>
          <tbody>
            {recents.map((r) => (
              <tr key={r.periodKey} data-testid={`launcher-row-${r.periodKey}`}>
                <td className="font-medium text-club-ink">
                  {r.monthLabel} {r.year}
                </td>
                <td className="text-stone-600">{r.periodEndLabel}</td>
                <td className="text-right">
                  <Link
                    href={`/app/admin/reporting/monthly?period=${r.periodKey}`}
                    className="text-xs text-club-ink hover:underline"
                    data-testid={`launcher-open-${r.periodKey}`}
                  >
                    Open package →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
