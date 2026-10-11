// MBR-FIX-2L (2026-10-11) — AR Aging import admin page.
//
// Founder-facing UI for `POST /api/admin/ar-aging-import` (preview +
// commit). Mirrors the Golf Activity importer shape — server page
// resolves principal, clubId, permission, and loads batch history;
// the client form drives the upload / preview / commit lifecycle.
//
// Reuses the existing `previewArAgingBatch` + `commitArAgingBatch`
// services via the API endpoint. No parallel import system.
//
// Tenancy: `clubId` resolved from the session; never trusted from
//          the client.
// RBAC:    requires `settings:write` on the active club.
// Audit:   each `ArAgingImportBatch` row IS the audit record
//          (uploadedByUserId / committedByUserId + timestamps).

import { redirect } from "next/navigation";

import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { prisma } from "@/lib/prisma";

import ArAgingImportForm from "./ar-aging-import-form";

export const dynamic = "force-dynamic";

export default async function ArAgingImportPage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!hasPermission(principal, clubId, "settings:write")) redirect("/app/admin");

  const batches = await prisma.arAgingImportBatch.findMany({
    where: { clubId },
    orderBy: { uploadedAt: "desc" },
    take: 20,
    select: {
      id: true,
      status: true,
      sourceSystem: true,
      sourceFileName: true,
      sourceEffectiveDate: true,
      rowCount: true,
      totalNet: true,
      totalCurrent: true,
      matchedMembers: true,
      unmatchedMembers: true,
      glControlAccountNumber: true,
      glControlAccountName: true,
      glControlBalance: true,
      reconciliationDifference: true,
      reconciliationStatus: true,
      uploadedAt: true,
      committedAt: true,
    },
  });

  return (
    <div className="space-y-6">
      <header data-testid="ar-aging-import-header">
        <h1 className="page-title">AR Aging import</h1>
        <p className="mt-1 text-sm text-stone-500">
          Upload a month-end Jonas AR workbook (XLSX). Preview is
          non-destructive and reconciles the subledger to the Jonas GL
          control account. The founder commits only after review —
          Section VIII and the Stewardship Dashboard then populate for
          the corresponding period. Imports are batched, idempotent,
          and tenant-scoped to the active club.
        </p>
      </header>

      <ArAgingImportForm clubId={clubId} />

      <section className="card" data-testid="ar-aging-import-history">
        <div className="card-body">
          <h2 className="section-title text-lg">Import history</h2>
          <p className="mt-1 text-xs text-stone-500">
            Every AR aging batch for this club, most recent first.
            PREVIEW batches have been parsed and reconciled but are
            not yet consumed by any report; COMMITTED batches
            populate the canonical AR aging snapshot for the period
            end.
          </p>
        </div>
        {batches.length === 0 ? (
          <div
            className="card-body text-sm text-stone-500"
            data-testid="ar-aging-import-history-empty"
          >
            No AR aging imports yet. Upload a month-end workbook
            above to begin.
          </div>
        ) : (
          <table className="table-base w-full text-sm" data-testid="ar-aging-import-history-table">
            <thead>
              <tr>
                <th className="text-left">Source file</th>
                <th className="text-left">Period end</th>
                <th className="text-right">Rows</th>
                <th className="text-right">Total AR</th>
                <th className="text-right">Current</th>
                <th className="text-left">GL reconciliation</th>
                <th className="text-left">Status</th>
                <th className="text-left">Uploaded</th>
                <th className="text-left">Committed</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} data-testid={`ar-aging-batch-row-${b.id}`}>
                  <td className="text-left">
                    <span>{b.sourceFileName ?? "(unnamed)"}</span>
                    <div className="text-[11px] uppercase tracking-wider text-stone-400">
                      {b.sourceSystem}
                    </div>
                  </td>
                  <td className="text-left tabular-nums">
                    {b.sourceEffectiveDate.toISOString().slice(0, 10)}
                  </td>
                  <td className="text-right tabular-nums">{b.rowCount}</td>
                  <td className="text-right tabular-nums">
                    ${Number(b.totalNet).toLocaleString("en-US", { maximumFractionDigits: 2 })}
                  </td>
                  <td className="text-right tabular-nums">
                    ${Number(b.totalCurrent).toLocaleString("en-US", { maximumFractionDigits: 2 })}
                  </td>
                  <td className="text-left">
                    <span
                      className={
                        b.reconciliationStatus === "RECONCILED"
                          ? "badge badge-green"
                          : b.reconciliationStatus === "OUT_OF_BALANCE"
                          ? "badge badge-rose"
                          : "badge badge-amber"
                      }
                    >
                      {b.reconciliationStatus ?? "—"}
                    </span>
                    {b.reconciliationDifference != null && (
                      <div className="mt-0.5 text-[11px] text-stone-500 tabular-nums">
                        Δ ${Number(b.reconciliationDifference).toLocaleString("en-US", { maximumFractionDigits: 2 })}
                      </div>
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
