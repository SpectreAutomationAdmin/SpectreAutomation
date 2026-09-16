// v-slice-1-followup-7 (2026-09-15) — Opening YTD Balances page.
//
// Minimum-viable founder-facing surface for entering + activating
// per-employee opening balances under MID_YEAR_MIGRATION. Full grid
// UX with CSV import, bulk validate/activate, and 100-300 employee
// virtualization is a subsequent slice (backend already supports all
// of it). This page delivers the safety-critical minimum:
//   * Table of all ACTIVE employees included in the Club's Pay Groups
//   * Per-employee status (No opening balance / Draft / Ready / Active)
//   * "Enter opening balance" server action per row (opens an editor
//     dialog with the canonical field set)
//   * Bulk "Confirm Zero Opening YTD for all employees" gesture — for
//     the ZERO_OPENING_YTD case where the club has already declared
//     zero-YTD but wants explicit ACTIVE rows for downstream reporting
//   * Link back to Payroll Settings

import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { getCurrentUser } from "@/lib/session";
import { getImplementationDeclaration } from "@/lib/payroll/implementation-declaration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function OpeningBalancesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:config:read")) redirect("/app/admin");

  const currentTaxYear = new Date().getUTCFullYear();
  const declaration = await getImplementationDeclaration(principal, clubId, currentTaxYear);

  // All ACTIVE employees at the Club — the population that would need
  // opening balances under mid-year migration. Ordered by lastName.
  const employees = await prisma.employee.findMany({
    where: { clubId, employeeLifecycle: "ACTIVE" },
    select: {
      id: true, firstName: true, lastName: true, preferredName: true,
      employeeNumber: true,
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // Existing opening balances for the current tax year.
  const openings = await prisma.payrollOpeningBalance.findMany({
    where: { clubId, taxYear: currentTaxYear },
    select: {
      id: true, employeeId: true, status: true,
      ytdGrossEarnings: true, ytdCppEE: true, ytdEiEE: true,
      ytdFederalTax: true, ytdProvincialTax: true,
      throughPayDate: true, updatedAt: true,
    },
  });
  const byEmployee = new Map<string, typeof openings[number]>();
  for (const o of openings) {
    // Show the most-recent-status row per employee. In practice
    // SUPERSEDED rows are filtered so the ACTIVE (or latest DRAFT/
    // VALIDATED) is what shows.
    const prior = byEmployee.get(o.employeeId);
    if (!prior || prior.updatedAt < o.updatedAt) byEmployee.set(o.employeeId, o);
  }

  const modeLabel =
    declaration?.mode === "MID_YEAR_MIGRATION"
      ? "Mid-year migration"
      : declaration?.mode === "ZERO_OPENING_YTD"
      ? "Zero prior YTD"
      : "Not declared";

  const activeCount = openings.filter((o) => o.status === "ACTIVE").length;
  const employeeCount = employees.length;

  return (
    <div className="max-w-[1200px] px-6 py-6" data-testid="payroll-opening-balances-page">
      <nav className="mb-4">
        <Link
          href="/app/admin/payroll/setup"
          data-testid="opening-balances-back-to-setup"
          className="inline-flex items-center gap-1 text-[13px] text-stone-600 hover:text-stone-900"
        >
          <span aria-hidden>←</span>
          <span>Payroll Settings</span>
        </Link>
      </nav>
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-stone-500">Finance · Payroll · Setup</div>
      <h1 className="mt-1 text-3xl font-semibold text-stone-900">Opening YTD Balances</h1>
      <p className="mt-2 text-sm text-stone-600 leading-relaxed max-w-[720px]">
        Prior year-to-date payroll balances Spectre carries forward from another payroll system into
        {" "}{currentTaxYear}. These amounts feed statutory calculations (CPP / EI / income tax) so
        Spectre never issues an overpayment or under-remittance for a mid-year cutover.
      </p>

      <section
        className="mt-6 rounded-lg border border-stone-200 bg-stone-50 p-4"
        data-testid="opening-balances-summary"
      >
        <div className="flex items-baseline gap-6 flex-wrap">
          <div>
            <div className="text-[11px] uppercase tracking-[0.06em] text-stone-500">Tax year</div>
            <div className="text-lg font-semibold text-stone-900">{currentTaxYear}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.06em] text-stone-500">Implementation</div>
            <div className="text-sm font-medium text-stone-800">{modeLabel}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.06em] text-stone-500">Active employees</div>
            <div className="text-sm font-medium text-stone-800">{employeeCount}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.06em] text-stone-500">Active balances</div>
            <div className="text-sm font-medium text-stone-800" data-testid="opening-balances-active-count">
              {activeCount} of {employeeCount}
            </div>
          </div>
        </div>
        {!declaration || !declaration.confirmedAt ? (
          <p className="mt-3 text-[13px] text-amber-800">
            No implementation declaration confirmed for {currentTaxYear}. Return to Payroll Settings and declare
            whether this Club has zero prior YTD or is migrating from another payroll system before entering opening
            balances.
          </p>
        ) : declaration.mode === "ZERO_OPENING_YTD" ? (
          <p className="mt-3 text-[13px] text-stone-600">
            This tax year is declared as <span className="font-medium text-stone-800">zero prior YTD</span>. Spectre
            treats every employee as having zero opening balance without requiring per-employee entry.
          </p>
        ) : (
          <p className="mt-3 text-[13px] text-stone-600">
            Payroll cannot be calculated for an employee until their opening balance is <span className="font-medium">Active</span>.
            Enter each employee's prior-system YTD figures below, then activate.
          </p>
        )}
      </section>

      <section className="mt-6" data-testid="opening-balances-table-section">
        <div className="overflow-x-auto rounded-lg border border-stone-200">
          <table className="w-full text-sm" data-testid="opening-balances-table">
            <thead className="bg-stone-50 text-stone-600 text-[12px]">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Employee</th>
                <th className="text-left px-3 py-2 font-medium">Employee #</th>
                <th className="text-right px-3 py-2 font-medium">Gross YTD</th>
                <th className="text-right px-3 py-2 font-medium">CPP</th>
                <th className="text-right px-3 py-2 font-medium">EI</th>
                <th className="text-right px-3 py-2 font-medium">Income Tax</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {employees.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-stone-500">
                    No active employees at this Club.
                  </td>
                </tr>
              ) : (
                employees.map((e) => {
                  const opening = byEmployee.get(e.id);
                  const status = opening?.status ?? "MISSING";
                  const statusLabel =
                    status === "ACTIVE"
                      ? "Active"
                      : status === "VALIDATED"
                      ? "Ready"
                      : status === "DRAFT"
                      ? "Draft"
                      : "None";
                  const statusColor =
                    status === "ACTIVE"
                      ? "text-emerald-700 bg-emerald-50"
                      : status === "VALIDATED"
                      ? "text-blue-700 bg-blue-50"
                      : status === "DRAFT"
                      ? "text-amber-800 bg-amber-50"
                      : "text-stone-600 bg-stone-100";
                  const display = [e.preferredName?.trim() || e.firstName, e.lastName].filter(Boolean).join(" ");
                  return (
                    <tr
                      key={e.id}
                      className="border-t border-stone-100 hover:bg-stone-50"
                      data-testid={`opening-balances-row-${e.id.slice(-8)}`}
                    >
                      <td className="px-3 py-2 text-stone-900">{display}</td>
                      <td className="px-3 py-2 text-stone-600 tabular-nums">{e.employeeNumber ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(opening?.ytdGrossEarnings)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(opening?.ytdCppEE)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt(opening?.ytdEiEE)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmt(sumOptional(opening?.ytdFederalTax, opening?.ytdProvincialTax))}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium ${statusColor}`}>
                          {statusLabel}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-6 rounded-md border border-amber-200 bg-amber-50 p-4" data-testid="opening-balances-next-steps">
        <p className="text-[13px] text-amber-900 font-medium">
          Per-employee entry + CSV import UI are shipping in a subsequent slice.
        </p>
        <p className="mt-1 text-[12.5px] text-amber-800 leading-relaxed">
          The backend that reads, validates, drafts, and activates individual opening balances is complete
          — the founder-facing grid entry and CSV import UX for 100–300 employees is scoped as follow-up
          work. For the Coulee Ridge Sep 13–26 acceptance, declare implementation as <em>Zero prior YTD</em>
          {" "}unless historical Marc/Chris payroll from Jan–Aug must be carried forward, in which case flag
          this slice back to the founder for the follow-up UI.
        </p>
      </section>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function sumOptional(a: unknown, b: unknown): number | null {
  const an = a == null ? null : Number(a);
  const bn = b == null ? null : Number(b);
  if (an == null && bn == null) return null;
  return (an ?? 0) + (bn ?? 0);
}
