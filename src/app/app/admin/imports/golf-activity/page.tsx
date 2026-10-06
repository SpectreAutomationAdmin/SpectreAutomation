// GOLF-HIST-1 (2026-10-05) — Historical Golf Activity importer.
//
// Admin page for uploading monthly GGGolf Daily Report PDFs. Preview
// is non-destructive; commit requires founder review. Mirrors the
// Jonas GL + AR aging admin patterns.
//
// Tenancy: `clubId` resolved from the session; never trusted from
//          the client.
// RBAC:    requires `settings:write` on the active club.
// Audit:   every batch records uploadedByUserId / committedByUserId
//          + uploadedAt / committedAt. No AuditLog model needed
//          because the batch row IS the audit record.

import { redirect } from "next/navigation";

import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { prisma } from "@/lib/prisma";

import GolfActivityImportForm from "./golf-activity-import-form";

export const dynamic = "force-dynamic";

export default async function GolfActivityImportPage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!hasPermission(principal, clubId, "settings:write")) redirect("/app/admin");

  const batches = await prisma.golfActivityImportBatch.findMany({
    where: { clubId },
    orderBy: { uploadedAt: "desc" },
    take: 20,
    select: {
      id: true,
      status: true,
      sourceSystem: true,
      sourceFileName: true,
      reportingPeriodStart: true,
      reportingPeriodEnd: true,
      rowCount: true,
      activeDays: true,
      realZeroDays: true,
      conflictCount: true,
      warningCount: true,
      sourceTotalRounds: true,
      parsedTotalRounds: true,
      reconciliationStatus: true,
      uploadedAt: true,
      committedAt: true,
    },
  });

  return (
    <div className="space-y-6">
      <header data-testid="golf-activity-import-header">
        <h1 className="page-title">Golf Activity import</h1>
        <p className="mt-1 text-sm text-stone-500">
          Upload a monthly Golf Activity source file (GGGolf Daily Report PDF).
          Imports are previewed non-destructively; founder commit is required
          before Section XI (Weather &amp; Utilization) consumes the data.
          Imports are batched, idempotent, and tenant-scoped to the active club.
        </p>
      </header>

      <GolfActivityImportForm clubId={clubId} />

      <section className="card" data-testid="golf-activity-import-history">
        <div className="card-body">
          <h2 className="section-title text-lg">Import history</h2>
          <p className="mt-1 text-xs text-stone-500">
            Every Golf Activity batch for this club, most recent first.
            PREVIEW batches are not yet consumed by any report;
            COMMITTED batches populate the canonical GolfActivityDay table.
          </p>
        </div>
        {batches.length === 0 ? (
          <div
            className="card-body text-sm text-stone-500"
            data-testid="golf-activity-import-history-empty"
          >
            No Golf Activity imports yet. Upload a monthly source file above to begin.
          </div>
        ) : (
          <table className="table-base w-full text-sm" data-testid="golf-activity-import-history-table">
            <thead>
              <tr>
                <th className="text-left">Source file</th>
                <th className="text-left">Period</th>
                <th className="text-right">Days</th>
                <th className="text-right">Rounds</th>
                <th className="text-left">Reconciliation</th>
                <th className="text-left">Status</th>
                <th className="text-left">Uploaded</th>
                <th className="text-left">Committed</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} data-testid={`golf-batch-row-${b.id}`}>
                  <td className="text-left">
                    <a className="link" href={`/app/admin/imports/golf-activity/${b.id}`}>
                      {b.sourceFileName ?? "(unnamed)"}
                    </a>
                    <div className="text-[11px] uppercase tracking-wider text-stone-400">
                      {b.sourceSystem}
                    </div>
                  </td>
                  <td className="text-left tabular-nums">
                    {b.reportingPeriodStart.toISOString().slice(0, 10)} → {b.reportingPeriodEnd.toISOString().slice(0, 10)}
                  </td>
                  <td className="text-right tabular-nums">
                    {b.activeDays + b.realZeroDays} ({b.realZeroDays} zero)
                  </td>
                  <td className="text-right tabular-nums">
                    {b.parsedTotalRounds}
                    {b.sourceTotalRounds != null && b.sourceTotalRounds !== b.parsedTotalRounds && (
                      <span className="text-rose-600"> (src {b.sourceTotalRounds})</span>
                    )}
                  </td>
                  <td className="text-left">
                    <span
                      className={
                        b.reconciliationStatus === "RECONCILED"
                          ? "badge badge-green"
                          : "badge badge-amber"
                      }
                    >
                      {b.reconciliationStatus}
                    </span>
                    {b.conflictCount > 0 && (
                      <span className="badge badge-rose ml-2">
                        {b.conflictCount} conflict{b.conflictCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </td>
                  <td className="text-left">
                    <span
                      className={
                        b.status === "COMMITTED"
                          ? "badge badge-green"
                          : b.status === "PREVIEW"
                          ? "badge badge-sand"
                          : "badge badge-slate"
                      }
                    >
                      {b.status}
                    </span>
                  </td>
                  <td className="text-left text-xs text-stone-500">
                    {b.uploadedAt.toISOString().slice(0, 16).replace("T", " ")}
                  </td>
                  <td className="text-left text-xs text-stone-500">
                    {b.committedAt
                      ? b.committedAt.toISOString().slice(0, 16).replace("T", " ")
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
