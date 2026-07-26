// Production Jonas GL import workflow.
//
// Routes a real Jonas trial-balance CSV through:
//
//   parse + validate  →  account mapping coverage  →  reconciliation
//   →  duplicate-period check  →  commit to PrismaReportingLedger
//
// Functional rather than polished. The point is reliability + audit:
//   • Tenancy: clubId is resolved from the session, never trusted
//     from the client.
//   • RBAC: requires `settings:write` on the active club.
//   • Audit: every commit produces a ReportingLedgerBatch row + a
//     TrialBalanceSnapshot row, both queryable by clubId + sourceSystem.
//   • Progress: explicit text states (Validating… / Importing…) +
//     reset, no spinners-only mystery.

import { redirect } from "next/navigation";

import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { getCurrentPrincipal } from "@/lib/services/principal";

import { JonasImportForm } from "./jonas-import-form";
import { listJonasImports } from "./actions";

export const dynamic = "force-dynamic";

export default async function JonasImportPage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!hasPermission(principal, clubId, "settings:write")) redirect("/app/admin");

  const history = await listJonasImports();

  return (
    <div className="space-y-6">
      <header data-testid="jonas-import-header">
        <h1 className="page-title">Jonas GL import</h1>
        <p className="mt-1 text-sm text-stone-500">
          Upload a Jonas trial-balance CSV and persist it to the Reporting Ledger.
          Imports are batched, idempotent, and tenant-scoped to the active club.
        </p>
      </header>

      <JonasImportForm />

      <section className="card" data-testid="jonas-import-history">
        <div className="card-body">
          <h2 className="section-title text-lg">Import history</h2>
          <p className="mt-1 text-xs text-stone-500">
            Every Jonas batch this club has opened, most recent first. Rolled-back
            and duplicate batches are kept for audit.
          </p>
        </div>
        {history.length === 0 ? (
          <div
            className="border-t border-stone-200 px-4 py-6 text-sm text-stone-500"
            data-testid="jonas-import-history-empty"
          >
            No Jonas imports yet for this club.
          </div>
        ) : (
          <table className="table-base text-sm" data-testid="jonas-import-history-table">
            <thead>
              <tr>
                <th>Opened</th>
                <th>State</th>
                <th>Source file</th>
                <th>Period</th>
                <th>Snapshots</th>
                <th>Snapshot ID</th>
              </tr>
            </thead>
            <tbody>
              {history.map((b) => (
                <tr key={b.batchId} data-testid={`history-row-${b.batchId}`}>
                  <td className="text-xs">
                    {new Date(b.openedAt).toLocaleString()}
                  </td>
                  <td>
                    <span className="font-mono text-xs uppercase">{b.state}</span>
                  </td>
                  <td className="text-xs">{b.sourceFile ?? "—"}</td>
                  <td className="text-xs">
                    {b.trialBalanceSnapshot?.reportingPeriod ?? "—"}
                  </td>
                  <td className="text-xs">{b.snapshotCount}</td>
                  <td className="font-mono text-[10px] break-all">
                    {b.trialBalanceSnapshot?.snapshotId ?? "—"}
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
