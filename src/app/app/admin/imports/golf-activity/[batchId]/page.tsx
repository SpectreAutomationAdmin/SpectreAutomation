// GOLF-HIST-1 (2026-10-05) — per-batch preview + commit page.

import { redirect, notFound } from "next/navigation";

import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { prisma } from "@/lib/prisma";

import GolfActivityCommitForm from "./commit-form";

export const dynamic = "force-dynamic";

export default async function GolfActivityBatchPage(
  props: { params: Promise<{ batchId: string }> },
) {
  const { batchId } = await props.params;
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!hasPermission(principal, clubId, "settings:write")) redirect("/app/admin");

  const batch = await prisma.golfActivityImportBatch.findUnique({
    where: { id: batchId },
    include: {
      rows: { orderBy: { rowIndex: "asc" } },
    },
  });
  if (!batch) notFound();
  // Tenant guard — a logged-in user may only see batches on their
  // active club.
  if (batch.clubId !== clubId) notFound();

  const commitEligible =
    batch.status === "PREVIEW" &&
    batch.reconciliationStatus === "RECONCILED" &&
    batch.conflictCount === 0;

  return (
    <div className="space-y-6">
      <header data-testid="golf-batch-header">
        <div className="text-[11px] uppercase tracking-wider text-stone-500">
          Golf Activity · {batch.sourceSystem}
        </div>
        <h1 className="page-title">{batch.sourceFileName ?? "(unnamed batch)"}</h1>
        <p className="mt-1 text-sm text-stone-500">
          Reporting period{" "}
          {batch.reportingPeriodStart.toISOString().slice(0, 10)} →{" "}
          {batch.reportingPeriodEnd.toISOString().slice(0, 10)} · uploaded{" "}
          {batch.uploadedAt.toISOString().slice(0, 16).replace("T", " ")}.
        </p>
      </header>

      <section className="card" data-testid="golf-batch-summary">
        <div className="card-body space-y-3">
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <div>
              <strong>Status:</strong>{" "}
              <span
                className={
                  batch.status === "COMMITTED"
                    ? "badge badge-green"
                    : batch.status === "PREVIEW"
                    ? "badge badge-sand"
                    : "badge badge-slate"
                }
                data-testid="golf-batch-status"
              >
                {batch.status}
              </span>
            </div>
            <div>
              <strong>Reconciliation:</strong>{" "}
              <span
                className={
                  batch.reconciliationStatus === "RECONCILED"
                    ? "badge badge-green"
                    : "badge badge-amber"
                }
                data-testid="golf-batch-reconciliation"
              >
                {batch.reconciliationStatus}
              </span>
            </div>
            <div>
              <strong>Daily rows:</strong> {batch.rowCount} ({batch.activeDays} active,{" "}
              {batch.realZeroDays} zero)
            </div>
            <div>
              <strong>Conflicts:</strong>{" "}
              <span className={batch.conflictCount > 0 ? "text-rose-600" : ""} data-testid="golf-batch-conflicts">
                {batch.conflictCount}
              </span>
            </div>
            <div>
              <strong>Warnings:</strong>{" "}
              <span className={batch.warningCount > 0 ? "text-amber-700" : ""}>
                {batch.warningCount}
              </span>
            </div>
          </div>

          <table className="table-base w-full text-xs" data-testid="golf-batch-reconcile-table">
            <thead>
              <tr>
                <th className="text-left">Metric</th>
                <th className="text-right">Source footer</th>
                <th className="text-right">Parsed daily sum</th>
                <th className="text-right">Δ</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  { key: "Guests",    src: batch.sourceTotalGuests,    parsed: batch.parsedTotalGuests },
                  { key: "GreenFees", src: batch.sourceTotalGreenFees, parsed: batch.parsedTotalGreenFees },
                  { key: "Members",   src: batch.sourceTotalMembers,   parsed: batch.parsedTotalMembers },
                  { key: "Total",     src: batch.sourceTotalRounds,    parsed: batch.parsedTotalRounds },
                  { key: "Juniors",   src: batch.sourceTotalJuniors,   parsed: batch.parsedTotalJuniors },
                  { key: "Women",     src: batch.sourceTotalWomen,     parsed: batch.parsedTotalWomen },
                ] as const
              ).map((row) => {
                const delta = row.src == null ? null : row.parsed - row.src;
                return (
                  <tr key={row.key} data-testid={`golf-batch-reconcile-${row.key.toLowerCase()}`}>
                    <td className="text-left">{row.key}</td>
                    <td className="text-right tabular-nums">{row.src ?? "—"}</td>
                    <td className="text-right tabular-nums">{row.parsed}</td>
                    <td className={`text-right tabular-nums ${delta !== 0 && delta != null ? "text-rose-600" : ""}`}>
                      {delta == null ? "—" : delta === 0 ? "0" : delta > 0 ? `+${delta}` : `${delta}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" data-testid="golf-batch-rows">
        <div className="card-body">
          <h2 className="section-title text-lg">Daily rows ({batch.rows.length})</h2>
          <p className="text-xs text-stone-500">
            Every date present in the source. Zero-round rows are preserved
            — authoritative "no golf activity" days (holidays / closures) are
            NOT the same as missing data.
          </p>
        </div>
        <table className="table-base w-full text-xs" data-testid="golf-batch-rows-table">
          <thead>
            <tr>
              <th className="text-left">Date</th>
              <th className="text-right">Guests</th>
              <th className="text-right">Grn Fees</th>
              <th className="text-right">Members</th>
              <th className="text-right">Total</th>
              <th className="text-right">Juniors</th>
              <th className="text-right">Women</th>
              <th className="text-left">Weather src</th>
              <th className="text-left">Conflict?</th>
            </tr>
          </thead>
          <tbody>
            {batch.rows.map((r) => (
              <tr key={r.id} data-testid={`golf-row-${r.rowIndex}`}>
                <td className="text-left tabular-nums">
                  {r.activityDate.toISOString().slice(0, 10)}
                  <span className="ml-1 text-stone-400">({r.rawDateLabel})</span>
                </td>
                <td className="text-right tabular-nums">{r.guests}</td>
                <td className="text-right tabular-nums">{r.greenFees}</td>
                <td className="text-right tabular-nums">{r.members}</td>
                <td className="text-right tabular-nums font-semibold">{r.totalRounds}</td>
                <td className="text-right tabular-nums">{r.juniors}</td>
                <td className="text-right tabular-nums">{r.women}</td>
                <td className="text-left text-stone-500">{r.rawWeatherCode ?? "—"}</td>
                <td className="text-left">
                  {r.conflictWithCommittedDayId ? (
                    <span className="badge badge-rose">CONFLICT</span>
                  ) : (
                    <span className="text-stone-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card" data-testid="golf-batch-commit">
        <div className="card-body space-y-3">
          <h2 className="section-title text-lg">Commit</h2>
          <p className="text-xs text-stone-500">
            Committing writes {batch.rows.length} authoritative{" "}
            <code>GolfActivityDay</code> rows for{" "}
            {batch.reportingPeriodStart.toISOString().slice(0, 10)} →{" "}
            {batch.reportingPeriodEnd.toISOString().slice(0, 10)} and makes Section XI
            (Weather &amp; Utilization) consume them.
            The commit is irreversible without a dedicated correction workflow.
            Only the founder should press Commit.
          </p>
          <GolfActivityCommitForm
            batchId={batch.id}
            clubId={batch.clubId}
            disabled={!commitEligible}
            committed={batch.status === "COMMITTED"}
            reasonBlocked={
              batch.status === "COMMITTED"
                ? "Already committed."
                : batch.reconciliationStatus !== "RECONCILED"
                ? `Reconciliation ${batch.reconciliationStatus} — fix the source file.`
                : batch.conflictCount > 0
                ? `Resolve ${batch.conflictCount} date conflict(s) first.`
                : null
            }
          />
        </div>
      </section>
    </div>
  );
}
