// Board / member-facing Monthly Package view — read-only, full
// chapter renderer.
//
// Route: /app/reports/monthly-package/[id]
//
// Reachable by:
//   • Board / director users (role with `reports:board`).
//   • Members holding an active BoardRole in Governance → Board &
//     Committees.
//   • Members who appear as a recipient on the package.
//
// Returns 404 for anyone else — the existence of the package is
// never leaked.
//
// Renders the SAME full report body the admin route renders at
// /app/admin/reporting/monthly?period=YYYY-MM, via the shared
// `MonthlyReportingPackageBody` component. The board view differs
// only in:
//
//   • NO admin publish controls (the body receives no `adminHeader`,
//     so the PublishHeaderButton portal slot stays empty — no
//     Publish, Overwrite Package, Published pill, or Archived
//     pill renders).
//   • NO admin reporting layout — the board reporting layout
//     (./layout.tsx) wraps this page in a ReportingShell whose
//     close button targets /app/member instead of the controller
//     launcher.
//   • The data source is the FROZEN snapshot stored in
//     `MonthlyPackage.packagePayloadJson` at publish time, NOT a
//     live re-render via getMonthlyReportingPackage. So a board
//     member always sees the document THEY WERE GIVEN, even if
//     the ledger has shifted since.

import { notFound, redirect } from "next/navigation";

import {
  getBoardPackageView,
  markPackageViewedByUser,
} from "@/lib/reporting/monthly-package-lifecycle";
import { getCurrentPrincipal } from "@/lib/services/principal";
import type { getMonthlyReportingPackage } from "@/lib/reporting/monthly-package";
import { MonthlyReportingPackageBody } from "@/app/app/admin/reporting/monthly/MonthlyReportingPackageBody";

type MonthlyReportingPackagePayload = Awaited<
  ReturnType<typeof getMonthlyReportingPackage>
>;

export default async function MonthlyPackageBoardViewPage({
  params,
}: {
  params: { id: string };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  const pkg = await getBoardPackageView(principal, params.id);
  if (!pkg) notFound();

  // Per-user "first-view" tracking. Once this board member has
  // opened the package, the NEW badge on their dashboard tile
  // disappears (the badge is computed from
  // `MonthlyPackageRecipient.viewedAt`). Other board members keep
  // seeing NEW until they personally open it. The function is a
  // no-op for users who reached the page via board-perm WITHOUT a
  // recipient row.
  await markPackageViewedByUser(principal, pkg.id);

  // The full reporting payload is stored verbatim in
  // `packagePayloadJson` at publish/send time — it's the exact
  // output of `getMonthlyReportingPackage`, serialized as JSON.
  // The shape uses ISO strings for dates (no Date objects), so
  // we can pass it directly to the shared body component without
  // any revival logic.
  //
  // If the snapshot is missing (legacy data created before the
  // snapshot field existed, or an aborted publish), render a
  // graceful fallback rather than crashing the page.
  if (!pkg.fullPayload) {
    return (
      <div
        data-testid="board-package-view-empty"
        className="mx-auto max-w-screen-md px-6 py-12"
      >
        <h1 className="font-serif text-2xl text-club-ink">
          {pkg.periodLabel} Monthly Reporting Package
        </h1>
        <p className="mt-3 text-sm text-stone-600">
          The detailed report snapshot is not available for this
          package. The Club administrator can re-publish this period
          to capture a fresh snapshot.
        </p>
      </div>
    );
  }

  const snapshotPayload = pkg.fullPayload as unknown as MonthlyReportingPackagePayload;

  return (
    <div data-testid="board-package-view">
      <MonthlyReportingPackageBody pkg={snapshotPayload} />
    </div>
  );
}
