// FPP-9C.1 (2026-09-22) — Original vs Corrected vs Change (Payroll Admin + Controller).
//
// Dedicated comparison surface for a CORRECTION batch. Renders the canonical
// buildCorrectionComparison() result — the same model the Controller Work Intake
// consumes, so PA and Controller can never see divergent numbers.

import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { buildCorrectionComparison } from "@/lib/payroll/correction-comparison";
import { returnCorrectionFromCompare } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Props { params: { batchId: string } }

function fmtMoney(v: string): string {
  const n = Number(v);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}$${abs}`;
}
function fmtChange(v: string): string {
  const n = Number(v);
  if (n === 0) return "—";
  const sign = n > 0 ? "+" : "-";
  const abs = Math.abs(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}$${abs}`;
}
function humanStatus(s: string): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export default async function CorrectionComparePage({ params }: Props) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) redirect("/app/admin");

  const correction = await prisma.payrollBatch.findFirst({
    where: { id: params.batchId, clubId },
    select: {
      id: true, status: true, transactionType: true,
      correctsPayrollBatchId: true, pairedReversalBatchId: true, correctionReason: true,
      calculationFingerprint: true, calculationVersion: true,
      calculatedAt: true, submittedAt: true, approvedAt: true, postedAt: true,
    },
  });
  if (!correction) redirect("/app/admin/payroll/process");
  if (correction.transactionType !== "CORRECTION") {
    return (
      <div className="max-w-[1100px] p-6">
        <p className="text-spectre-body" style={{ color: "var(--spectre-text-secondary)" }}>
          This batch is not a correction. Only CORRECTION batches have an Original vs Corrected view.
        </p>
        <Link href={`/app/admin/payroll/batches/${params.batchId}`} className="mt-4 inline-block underline text-sm"
              style={{ color: "var(--spectre-text-secondary)" }}>
          ← Back to batch review
        </Link>
      </div>
    );
  }

  const comparison = await buildCorrectionComparison(correction.id);
  const isReturned = correction.status === "RETURNED_FOR_CORRECTION";
  const canReturn = correction.status === "SUBMITTED_FOR_APPROVAL"
    && hasPermission(principal, clubId, "payroll:approve");

  const rr = correction.pairedReversalBatchId;
  const originalId = correction.correctsPayrollBatchId!;

  return (
    <div className="max-w-[1200px] p-6" data-testid="correction-compare-page">
      <header className="mb-8">
        <div
          className="text-[11px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: "var(--spectre-text-muted)" }}
        >
          Operations · Payroll · Correction · Original vs Corrected vs Change
        </div>
        <h1
          className="mt-1 text-spectre-h1 font-semibold"
          style={{ color: "var(--spectre-text-primary)" }}
          data-testid="correction-compare-title"
        >
          Correction comparison
        </h1>
        <p
          className="mt-2 text-spectre-body max-w-[820px]"
          style={{ color: "var(--spectre-text-secondary)" }}
        >
          Compares the replacement correction batch against the frozen original payroll it corrects.
          {correction.correctionReason ? ` Reason: ${correction.correctionReason}.` : ""}
        </p>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <MetaLine label="Correction status" value={humanStatus(correction.status)} testid="cmp-status" />
          <MetaLine label="Correction fingerprint"
                    value={correction.calculationFingerprint ? correction.calculationFingerprint.slice(0, 24) + "…" : "—"}
                    testid="cmp-fingerprint" />
          <MetaLine label="Calc version" value={String(correction.calculationVersion ?? "—")} testid="cmp-version" />
        </div>
      </header>

      {isReturned && (
        <ReturnedBanner correctionBatchId={correction.id} />
      )}

      <SummarySection comparison={comparison} />

      <EmployeesSection comparison={comparison} />

      <ComponentsSection comparison={comparison} />

      <footer className="mt-10 flex flex-wrap gap-4 text-sm items-center">
        <Link href={`/app/admin/payroll/batches/${originalId}`} className="underline"
              style={{ color: "var(--spectre-text-secondary)" }} data-testid="link-original">
          View original batch
        </Link>
        {rr && (
          <Link href={`/app/admin/payroll/batches/${rr}`} className="underline"
                style={{ color: "var(--spectre-text-secondary)" }} data-testid="link-reversal">
            View reversal batch
          </Link>
        )}
        <Link href={`/app/admin/payroll/batches/${correction.id}`} className="underline"
              style={{ color: "var(--spectre-text-secondary)" }}>
          Back to correction review
        </Link>
        {canReturn && (
          <ReturnActions correctionBatchId={correction.id} />
        )}
      </footer>
    </div>
  );
}

function MetaLine({ label, value, testid }: { label: string; value: string; testid: string }) {
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-[0.06em] font-medium"
        style={{ color: "var(--spectre-text-muted)" }}
      >
        {label}
      </div>
      <div
        className="mt-0.5 text-spectre-body tabular-nums"
        style={{ color: "var(--spectre-text-primary)" }}
        data-testid={testid}
      >
        {value}
      </div>
    </div>
  );
}

function ReturnedBanner({ correctionBatchId }: { correctionBatchId: string }) {
  return (
    <div
      className="mb-8 p-4 border rounded"
      style={{
        background: "var(--spectre-surface-elevated, #FBF7EE)",
        borderColor: "var(--spectre-border, #E1D9C6)",
      }}
      data-testid="banner-returned"
    >
      <div
        className="text-[11px] uppercase tracking-[0.06em] font-medium"
        style={{ color: "var(--spectre-text-muted)" }}
      >
        Correction returned for revision
      </div>
      <p className="mt-1 text-spectre-body" style={{ color: "var(--spectre-text-primary)" }}>
        The Controller has returned this correction. The original payroll remains reversed;
        no corrected replacement payroll is currently posted. Payroll Admin should edit the
        correction inputs, recalculate, and re-submit for approval.
      </p>
      <div className="mt-2 text-xs" style={{ color: "var(--spectre-text-secondary)" }}>
        Correction id <span className="tabular-nums">{correctionBatchId}</span>
      </div>
    </div>
  );
}

function SummarySection({ comparison }: { comparison: Awaited<ReturnType<typeof buildCorrectionComparison>> }) {
  const rows: Array<{ label: string; original: string; corrected: string; change: string }> = [
    { label: "Total gross",           original: comparison.original.totalGross, corrected: comparison.correction.totalGross, change: comparison.totals.grossChange },
    { label: "Total EE deductions",   original: "", corrected: "", change: comparison.totals.totalDeductionsChange },
    { label: "Total net",             original: comparison.original.totalNet, corrected: comparison.correction.totalNet, change: comparison.totals.netChange },
    { label: "Total employer cost",   original: "", corrected: "", change: comparison.totals.employerCostChange },
  ];
  return (
    <section className="mb-10" data-testid="section-summary">
      <h2
        className="text-spectre-h3 font-semibold mb-3"
        style={{ color: "var(--spectre-text-primary)" }}
      >
        Payroll summary
      </h2>
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr style={{ color: "var(--spectre-text-muted)" }}>
            <th className="text-left py-2 font-medium">&nbsp;</th>
            <th className="text-right py-2 font-medium">Original</th>
            <th className="text-right py-2 font-medium">Corrected</th>
            <th className="text-right py-2 font-medium">Change</th>
          </tr>
        </thead>
        <tbody style={{ color: "var(--spectre-text-primary)" }}>
          {rows.map((r) => (
            <tr key={r.label} className="border-t" style={{ borderColor: "var(--spectre-border, #E7E1D2)" }}>
              <td className="py-2 pr-6">{r.label}</td>
              <td className="text-right py-2">{r.original ? fmtMoney(r.original) : ""}</td>
              <td className="text-right py-2">{r.corrected ? fmtMoney(r.corrected) : ""}</td>
              <td className="text-right py-2">{fmtChange(r.change)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 text-xs" style={{ color: "var(--spectre-text-secondary)" }}>
        Employees changed: <span className="tabular-nums font-medium">{comparison.changedEmployeeCount}</span>
        {"  ·  "}
        Employees unchanged: <span className="tabular-nums font-medium">{comparison.unchangedEmployeeCount}</span>
      </div>
    </section>
  );
}

function EmployeesSection({ comparison }: { comparison: Awaited<ReturnType<typeof buildCorrectionComparison>> }) {
  const changed = comparison.employees.filter((e) => e.changed);
  const unchanged = comparison.employees.filter((e) => !e.changed);
  return (
    <section className="mb-10" data-testid="section-employees">
      <h2
        className="text-spectre-h3 font-semibold mb-3"
        style={{ color: "var(--spectre-text-primary)" }}
      >
        Changed employees
      </h2>
      {changed.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--spectre-text-secondary)" }}>
          No employees changed on this correction.
        </p>
      ) : (
        <div className="space-y-6">
          {changed.map((e) => (
            <EmployeeCard key={e.employeeId} row={e} />
          ))}
        </div>
      )}
      {unchanged.length > 0 && (
        <details className="mt-6 text-sm">
          <summary
            className="cursor-pointer select-none"
            style={{ color: "var(--spectre-text-secondary)" }}
          >
            {unchanged.length} unchanged employees (still included in the correction transaction)
          </summary>
          <ul className="mt-2 ml-4 list-disc">
            {unchanged.map((e) => (
              <li key={e.employeeId} className="tabular-nums">
                {e.employeeName} <span style={{ color: "var(--spectre-text-muted)" }}>({e.employeeNumber ?? "—"})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function EmployeeCard({ row }: { row: Awaited<ReturnType<typeof buildCorrectionComparison>>["employees"][number] }) {
  const changedFields = Object.entries(row.fields).filter(([, v]) => v.changed);
  return (
    <div
      className="p-4 border"
      style={{ borderColor: "var(--spectre-border, #E7E1D2)" }}
      data-testid={`employee-${row.employeeId}`}
    >
      <div className="flex items-baseline justify-between">
        <div className="text-spectre-h4 font-medium" style={{ color: "var(--spectre-text-primary)" }}>
          {row.employeeName}
        </div>
        <div className="text-xs" style={{ color: "var(--spectre-text-muted)" }}>
          {row.employeeNumber ?? "—"}
        </div>
      </div>
      <table className="w-full mt-3 text-sm tabular-nums">
        <thead>
          <tr style={{ color: "var(--spectre-text-muted)" }}>
            <th className="text-left py-1 font-medium">Field</th>
            <th className="text-right py-1 font-medium">Original</th>
            <th className="text-right py-1 font-medium">Corrected</th>
            <th className="text-right py-1 font-medium">Change</th>
          </tr>
        </thead>
        <tbody style={{ color: "var(--spectre-text-primary)" }}>
          {changedFields.map(([key, v]) => (
            <tr key={key} className="border-t" style={{ borderColor: "var(--spectre-border, #E7E1D2)" }}>
              <td className="py-1 pr-6">{humanField(key)}</td>
              <td className="text-right py-1">{fmtMoney(v.original)}</td>
              <td className="text-right py-1">{fmtMoney(v.corrected)}</td>
              <td className="text-right py-1">{fmtChange(v.change)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ComponentsSection({ comparison }: { comparison: Awaited<ReturnType<typeof buildCorrectionComparison>> }) {
  if (!comparison.components.length) return null;
  return (
    <section className="mb-10" data-testid="section-components">
      <h2
        className="text-spectre-h3 font-semibold mb-3"
        style={{ color: "var(--spectre-text-primary)" }}
      >
        Component changes
      </h2>
      <table className="w-full text-sm tabular-nums">
        <thead>
          <tr style={{ color: "var(--spectre-text-muted)" }}>
            <th className="text-left py-2 font-medium">Component</th>
            <th className="text-right py-2 font-medium">Original</th>
            <th className="text-right py-2 font-medium">Corrected</th>
            <th className="text-right py-2 font-medium">Change</th>
            <th className="text-right py-2 font-medium pl-4">Operation</th>
          </tr>
        </thead>
        <tbody style={{ color: "var(--spectre-text-primary)" }}>
          {comparison.components.map((c, i) => (
            <tr key={`${c.employeeId}-${c.componentCode}-${i}`}
                className="border-t"
                style={{ borderColor: "var(--spectre-border, #E7E1D2)" }}
                data-testid={`component-row-${c.componentCode}`}>
              <td className="py-2 pr-6">
                <div>{c.displayName}</div>
                <div className="text-xs" style={{ color: "var(--spectre-text-muted)" }}>{c.componentCode}</div>
              </td>
              <td className="text-right py-2">{fmtMoney(c.originalAmount)}</td>
              <td className="text-right py-2">{fmtMoney(c.correctedAmount)}</td>
              <td className="text-right py-2">{fmtChange(c.change)}</td>
              <td className="text-right py-2 pl-4 uppercase text-xs" style={{ color: "var(--spectre-text-muted)" }}>
                {c.operation}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function humanField(k: string): string {
  const map: Record<string, string> = {
    gross: "Gross", taxable: "Taxable", pensionable: "Pensionable", insurable: "Insurable",
    cppEE: "CPP EE", cpp2EE: "CPP2 EE", eiEE: "EI EE",
    fedTax: "Federal Tax", provTax: "Provincial Tax",
    totalEEDeds: "Total employee deductions",
    netPay: "Net Pay", cppER: "Employer CPP", eiER: "Employer EI",
  };
  return map[k] ?? k;
}

function ReturnActions({ correctionBatchId }: { correctionBatchId: string }) {
  return (
    <form action={returnCorrectionFromCompare} className="inline-flex items-center gap-2">
      <input type="hidden" name="batchId" value={correctionBatchId} />
      <input
        name="reason"
        placeholder="Reason to return"
        maxLength={500}
        className="text-sm px-2 py-1 border rounded"
        style={{ borderColor: "var(--spectre-border, #E7E1D2)" }}
        required
        data-testid="input-return-reason"
      />
      <button
        type="submit"
        className="btn btn-secondary btn-sm"
        data-testid="btn-return-correction"
      >
        Return correction
      </button>
    </form>
  );
}
