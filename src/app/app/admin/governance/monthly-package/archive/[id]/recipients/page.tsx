// Monthly Package — recipients detail page.
//
// Lists every recipient of a single MonthlyPackage row with delivery
// state (PENDING / SENT / OPENED / FAILED / BOUNCED), their email,
// optional role label, optional linked Spectre user, and the
// sent/viewed timestamps. Linked from the archive's "Recipients"
// row action.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Badge } from "@/components/Badge";
import { getMonthlyPackageRecipients } from "@/lib/reporting/monthly-package-archive";
import { isAppError } from "@/lib/errors";
import { getCurrentPrincipal } from "@/lib/services/principal";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function formatDateTime(d: Date | null): string {
  if (!d) return "—";
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export default async function RecipientsPage({
  params,
}: {
  params: { id: string };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  let detail;
  try {
    detail = await getMonthlyPackageRecipients(principal, params.id);
  } catch (err) {
    if (isAppError(err)) notFound();
    throw err;
  }
  if (!detail) notFound();
  const { pkg, recipients } = detail;

  return (
    <div data-testid="monthly-package-recipients">
      <Link
        href="/app/admin/governance/monthly-package/archive"
        className="text-sm text-stone-500 hover:text-club-ink"
      >
        ← Archive
      </Link>

      <h1 className="mt-3 page-title">{pkg.title}</h1>
      <p className="mt-1 text-stone-500">
        {MONTH_NAMES[pkg.reportingMonth - 1]} {pkg.reportingYear} ·
        Period end {pkg.periodEndDate.toISOString().slice(0, 10)} ·{" "}
        <Badge status={pkg.status} />
        {pkg.sentAt && (
          <span className="ml-2 text-xs">
            Last sent {formatDateTime(pkg.sentAt)}
          </span>
        )}
      </p>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">
          Recipients ({recipients.length})
        </div>
        <table className="table-base">
          <thead>
            <tr>
              <th>Recipient</th>
              <th>Email</th>
              <th>Role</th>
              <th>Delivery</th>
              <th>Sent</th>
              <th>Viewed</th>
            </tr>
          </thead>
          <tbody>
            {recipients.length === 0 && (
              <tr data-testid="recipients-empty">
                <td
                  colSpan={6}
                  className="px-4 py-12 text-center text-stone-500"
                >
                  This package has no recipients yet.
                </td>
              </tr>
            )}
            {recipients.map((r) => (
              <tr key={r.id} data-testid={`recipient-row-${r.id}`}>
                <td className="text-sm">
                  {r.recipientUserName ?? (
                    <span className="text-stone-500">(external)</span>
                  )}
                </td>
                <td className="text-xs font-mono">{r.recipientEmail}</td>
                <td className="text-xs">
                  {r.recipientRole ?? (
                    <span className="text-stone-400">—</span>
                  )}
                </td>
                <td>
                  <Badge status={r.deliveryStatus} />
                </td>
                <td className="text-xs">{formatDateTime(r.sentAt)}</td>
                <td className="text-xs">{formatDateTime(r.viewedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
