// Monthly Reporting Package — archive page.
//
// Lists every MonthlyPackage row the club has generated, in reverse
// chronological order, with per-row actions:
//
//   • View package         (always)
//   • View recipient list  (always — shows roster + delivery state)
//   • Re-send              (PUBLISHED or SENT only)
//   • Delete               (DRAFT only)
//
// Status badges are colour-coded via the existing Badge component
// (DRAFT = stone, PUBLISHED = green, SENT = blue) so the three
// states read at a glance.
//
// Tenant + permission gating: this page is admin-only via the
// existing /app/admin layout, and the service call requires
// `reports:board` on the active club. SUPER_ADMIN bypasses.

import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge } from "@/components/Badge";
import { getActiveClubId } from "@/lib/active-club";
import { listArchivedMonthlyPackages } from "@/lib/reporting/monthly-package-archive";
import { hasPermission } from "@/lib/rbac";
import { getCurrentPrincipal } from "@/lib/services/principal";

import { ArchiveRowActions } from "./RowActions";

type ArchivePageProps = {
  /** Flash messaging via URL searchParams — the row actions
   *  (delete / resend) redirect back here with one of these set.
   *  Stale params naturally fall off on the next non-action
   *  navigation; no server-side cleanup required. The page can
   *  never mutate cookies because Server Components aren't
   *  allowed to. */
  searchParams?: { notice?: string; error?: string };
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatDateTime(d: Date | null): string {
  if (!d) return "—";
  // YYYY-MM-DD HH:mm UTC — controller-friendly, locale-free, sorts
  // correctly in tables when sorted as strings.
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function formatPeriod(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export default async function MonthlyPackageArchivePage({
  searchParams,
}: ArchivePageProps) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!hasPermission(principal, clubId, "reports:board")) redirect("/app/admin");

  const rows = await listArchivedMonthlyPackages(principal, clubId);

  // Flash messages from the row actions arrive as `?notice=` or
  // `?error=` (set via redirect in `_actions.ts`). We render them
  // verbatim; the param disappears the next time the user
  // navigates or refreshes — Next.js doesn't allow cookie mutation
  // from a Server Component, which is why we don't use the
  // cookie-flash pattern here.
  const notice = searchParams?.notice ? String(searchParams.notice) : null;
  const error = searchParams?.error ? String(searchParams.error) : null;

  return (
    <div data-testid="monthly-package-archive">
      <Link
        href="/app/admin/governance/monthly-package"
        className="text-sm text-stone-500 hover:text-club-ink"
      >
        ← Monthly Package launcher
      </Link>

      <h1 className="mt-3 page-title">Monthly Package Archive</h1>
      <p className="mt-1 text-stone-500">
        Every monthly reporting package this club has generated,
        published, or sent. Snapshots taken at publish/send time are
        immutable — board recipients always see what they were given,
        regardless of subsequent ledger changes.
      </p>

      {error && (
        <div
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          role="alert"
          data-testid="archive-error"
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
          role="status"
          data-testid="archive-notice"
        >
          {notice}
        </div>
      )}

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 flex items-baseline justify-between gap-3">
          <div>
            <div className="font-medium">
              Packages ({rows.length})
            </div>
            <div className="mt-0.5 text-xs text-stone-500">
              Sorted by reporting period — most recent first.
            </div>
          </div>
          <Link
            href="/app/admin/governance/monthly-package"
            className="btn btn-secondary text-xs"
            data-testid="archive-back-to-launcher"
          >
            Generate a new package
          </Link>
        </div>

        <table className="table-base">
          <thead>
            <tr>
              <th>Reporting period</th>
              <th>Package title</th>
              <th>Status</th>
              <th>Published</th>
              <th>Sent</th>
              <th>Sent by</th>
              <th className="text-right">Recipients</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr data-testid="archive-empty">
                <td
                  colSpan={8}
                  className="px-4 py-12 text-center text-stone-500"
                >
                  No monthly packages have been generated yet. Use the
                  launcher to generate one.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const period = periodKey(r.reportingYear, r.reportingMonth);
              return (
                <tr
                  key={r.id}
                  data-testid={`archive-row-${period}`}
                >
                  <td>
                    <div className="font-medium text-club-ink">
                      {formatPeriod(r.reportingYear, r.reportingMonth)}
                    </div>
                    <div className="text-xs text-stone-500">
                      Period end{" "}
                      {r.periodEndDate.toISOString().slice(0, 10)}
                    </div>
                  </td>
                  <td className="text-sm">{r.title}</td>
                  <td>
                    <Badge
                      status={r.status}
                      data-testid={`archive-row-${period}-status`}
                    />
                  </td>
                  <td className="text-xs">
                    <div>{formatDateTime(r.publishedAt)}</div>
                    {r.publishedByName && (
                      <div className="text-stone-500">
                        by {r.publishedByName}
                      </div>
                    )}
                  </td>
                  <td className="text-xs">{formatDateTime(r.sentAt)}</td>
                  <td className="text-xs">
                    {r.sentByName ?? <span className="text-stone-400">—</span>}
                  </td>
                  <td className="text-right text-xs">
                    {r.recipientCount === 0 ? (
                      <span className="text-stone-400">0</span>
                    ) : (
                      <span>
                        <span className="font-medium text-club-ink">
                          {r.recipientCount}
                        </span>
                        <span className="text-stone-500">
                          {" "}
                          · {r.recipientDeliveredCount} delivered
                          {r.recipientViewedCount > 0 && (
                            <> · {r.recipientViewedCount} viewed</>
                          )}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    <div className="inline-flex items-center gap-3">
                      <Link
                        href={`/app/admin/reporting/monthly?period=${period}`}
                        className="text-xs text-club-ink hover:underline"
                        data-testid={`archive-view-${period}`}
                      >
                        View package
                      </Link>
                      <Link
                        href={`/app/admin/governance/monthly-package/archive/${r.id}/recipients`}
                        className="text-xs text-club-ink hover:underline"
                        data-testid={`archive-recipients-${period}`}
                      >
                        Recipients
                      </Link>
                      <ArchiveRowActions
                        packageId={r.id}
                        status={r.status}
                        title={`${formatPeriod(r.reportingYear, r.reportingMonth)}`}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
