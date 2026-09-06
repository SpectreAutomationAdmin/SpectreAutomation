// Payroll MVP posting (2026-09-05) — GL journal viewer for a posted
// payroll batch. Shows the balanced entry produced by postPayrollBatch.

import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { getJournal } from "@/lib/accounting/journal";
import { assertTenantOwned } from "@/lib/services/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Props { params: { batchId: string } }

export default async function PayrollBatchGlPage({ params }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId    = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) redirect("/app/admin");

  const batch = await prisma.payrollBatch.findUnique({
    where: { id: params.batchId },
    select: { id: true, clubId: true, status: true, glJournalEntryId: true },
  });
  if (!batch) notFound();
  assertTenantOwned(batch, principal);
  if (batch.clubId !== clubId) notFound();
  if (!batch.glJournalEntryId) {
    return (
      <div className="max-w-[900px]" data-testid="payroll-gl-page">
        <h1 className="text-spectre-h1 font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
          GL journal — not yet posted
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--spectre-text-secondary)" }}>
          This payroll batch is currently <strong>{batch.status}</strong>. Post the batch to
          generate its balanced GL journal entry.
        </p>
        <Link href={`/app/admin/payroll/batches/${params.batchId}`} className="mt-4 inline-block underline">
          ← Payroll review
        </Link>
      </div>
    );
  }

  const journal = await getJournal(principal, batch.glJournalEntryId);

  const totalDebits  = journal.lines.reduce<number>((a, l) => a + Number(l.debit  ?? 0), 0);
  const totalCredits = journal.lines.reduce<number>((a, l) => a + Number(l.credit ?? 0), 0);

  return (
    <div className="max-w-[900px]" data-testid="payroll-gl-page">
      <header className="mb-spectre-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em]"
             style={{ color: "var(--spectre-text-muted)" }}>
          Operations · Payroll · GL journal
        </div>
        <h1 className="mt-1 text-spectre-h1 font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
          Journal entry {journal.entryNumber ?? journal.id}
        </h1>
        <p className="mt-2 text-sm" style={{ color: "var(--spectre-text-secondary)" }}>
          {journal.description ?? "Payroll posting"} — dated{" "}
          {new Date(journal.entryDate).toLocaleDateString("en-CA")}. Status {journal.status}.
        </p>
        <Link href={`/app/admin/payroll/batches/${params.batchId}`} className="mt-3 inline-block underline text-sm"
              style={{ color: "var(--spectre-text-secondary)" }}>
          ← Payroll review
        </Link>
      </header>

      <div className="rounded-lg border" style={{ borderColor: "var(--spectre-border-muted)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b" style={{ borderColor: "var(--spectre-border-muted)" }}>
              <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: "var(--spectre-text-muted)" }}>Account</th>
              <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: "var(--spectre-text-muted)" }}>Memo</th>
              <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: "var(--spectre-text-muted)" }}>Debit</th>
              <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: "var(--spectre-text-muted)" }}>Credit</th>
            </tr>
          </thead>
          <tbody>
            {journal.lines.map((l, i) => (
              <tr key={l.id ?? i} className="border-b" style={{ borderColor: "var(--spectre-border-muted)" }}>
                <td className="px-3 py-2">
                  <div>{l.account?.accountNumber ?? "—"} · {l.account?.name ?? "—"}</div>
                </td>
                <td className="px-3 py-2 text-[color:var(--spectre-text-secondary)]">{l.description ?? ""}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.debit  ? `$${Number(l.debit).toFixed(2)}`  : ""}</td>
                <td className="px-3 py-2 text-right tabular-nums">{l.credit ? `$${Number(l.credit).toFixed(2)}` : ""}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={2} className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide"
                  style={{ color: "var(--spectre-text-muted)" }}>Totals</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums">${totalDebits.toFixed(2)}</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums">${totalCredits.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs" style={{ color: "var(--spectre-text-muted)" }}>
        Balanced: debits ${totalDebits.toFixed(2)} = credits ${totalCredits.toFixed(2)}.
      </p>
    </div>
  );
}
