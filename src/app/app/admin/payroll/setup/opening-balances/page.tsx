// v-slice-1-followup-8 (2026-09-16) — Opening YTD Balances page.
//
// Founder-facing surface for entering + activating per-employee
// opening balances under MID_YEAR_MIGRATION. Wraps the canonical
// PayrollOpeningBalance service via server actions.
//
// Layout:
//   * Summary card (tax year, mode, employee counts, active counts)
//   * Contextual banner reflecting current implementation state
//   * Table of all ACTIVE employees × YTD columns × Status × Action
//   * Editor dialog (draft / save / validate / activate) per employee
//   * Bulk validate + bulk activate + CSV import via modals
//
// v-slice-1-followup-7 stubbed this page; -followup-8 completes it.

import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { getCurrentUser } from "@/lib/session";
import { getImplementationDeclaration } from "@/lib/payroll/implementation-declaration";
import { listOpeningBalances } from "@/lib/payroll/opening-balance";
import OpeningBalancesWorkspace, { type EmployeeRow } from "./OpeningBalancesWorkspace";
import {
  saveOpeningBalanceDraftAction,
  validateOpeningBalanceAction,
  activateOpeningBalanceAction,
  bulkValidateOpeningBalancesAction,
  bulkActivateOpeningBalancesAction,
  importOpeningBalancesCsvAction,
} from "./_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function OpeningBalancesPage({
  searchParams,
}: { searchParams?: { obErr?: string; obOk?: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) redirect("/app/admin");

  const canWrite = hasPermission(principal, clubId, "payroll:run");

  const currentTaxYear = new Date().getUTCFullYear();
  const declaration = await getImplementationDeclaration(principal, clubId, currentTaxYear);

  const employees = await prisma.employee.findMany({
    where: { clubId, employeeLifecycle: "ACTIVE" },
    select: {
      id: true, firstName: true, lastName: true, preferredName: true,
      employeeNumber: true,
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // All non-superseded opening balances for the tax year.
  const openings = await listOpeningBalances(principal, clubId, currentTaxYear);
  const byEmp = new Map<string, typeof openings[number]>();
  for (const o of openings) {
    if (o.status === "SUPERSEDED") continue; // never render superseded as the primary row
    const prior = byEmp.get(o.employeeId);
    // Prefer higher-priority status: ACTIVE > VALIDATED > DRAFT.
    if (!prior) { byEmp.set(o.employeeId, o); continue; }
    const rank = (s: string) => (s === "ACTIVE" ? 3 : s === "VALIDATED" ? 2 : s === "DRAFT" ? 1 : 0);
    if (rank(o.status) > rank(prior.status)) byEmp.set(o.employeeId, o);
  }

  const rows: EmployeeRow[] = employees.map((e) => {
    const opening = byEmp.get(e.id);
    const display = [e.preferredName?.trim() || e.firstName, e.lastName].filter(Boolean).join(" ");
    return {
      employeeId: e.id,
      employeeNumber: e.employeeNumber ?? null,
      displayName: display,
      openingBalanceId: opening?.id ?? null,
      status: (opening?.status ?? "MISSING") as EmployeeRow["status"],
      values: opening
        ? {
            ytdGrossEarnings: opening.values.ytdGrossEarnings,
            ytdTaxableEarnings: opening.values.ytdTaxableEarnings,
            ytdPensionableEarnings: opening.values.ytdPensionableEarnings,
            ytdInsurableEarnings: opening.values.ytdInsurableEarnings,
            ytdCppEE_Base: opening.values.ytdCppEE_Base,
            ytdCppEE_FirstAdd: opening.values.ytdCppEE_FirstAdd,
            ytdCppEE: opening.values.ytdCppEE,
            ytdCpp2EE: opening.values.ytdCpp2EE,
            ytdEiEE: opening.values.ytdEiEE,
            ytdFederalTax: opening.values.ytdFederalTax,
            ytdProvincialTax: opening.values.ytdProvincialTax,
            ytdCppER_Base: opening.values.ytdCppER_Base,
            ytdCppER_FirstAdd: opening.values.ytdCppER_FirstAdd,
            ytdCppER: opening.values.ytdCppER,
            ytdCpp2ER: opening.values.ytdCpp2ER,
            ytdEiER: opening.values.ytdEiER,
          }
        : null,
      throughPayDate: opening?.throughPayDate?.toISOString() ?? null,
      priorPayrollKind: opening?.priorPayrollKind ?? null,
      activatedAt: opening?.activatedAt?.toISOString() ?? null,
    };
  });

  const modeLabel =
    declaration?.mode === "MID_YEAR_MIGRATION"
      ? "Mid-year migration"
      : declaration?.mode === "ZERO_OPENING_YTD"
      ? "Zero prior YTD"
      : "Not declared";

  const activeCount = rows.filter((r) => r.status === "ACTIVE").length;
  const employeeCount = employees.length;

  const banner: { tone: "error" | "success"; text: string } | null =
    searchParams?.obErr
      ? { tone: "error", text: searchParams.obErr }
      : searchParams?.obOk
      ? { tone: "success", text: searchParams.obOk }
      : null;

  return (
    <div className="max-w-[1240px] px-6 py-6" data-testid="payroll-opening-balances-page">
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
      <p className="mt-2 text-sm text-stone-600 leading-relaxed max-w-[820px]">
        Prior year-to-date payroll balances Spectre carries forward from another payroll system into
        {" "}{currentTaxYear}. These amounts feed statutory calculations (CPP / EI / income tax) so
        Spectre never issues an overpayment or under-remittance for a mid-year cutover.
      </p>

      {banner && (
        <div
          role={banner.tone === "error" ? "alert" : "status"}
          data-testid={
            banner.tone === "error"
              ? "opening-balances-error-banner"
              : "opening-balances-success-banner"
          }
          className={
            "mt-4 rounded-md px-3 py-2 text-sm " +
            (banner.tone === "error"
              ? "border border-red-200 bg-red-50 text-red-700"
              : "border border-green-200 bg-green-50 text-green-800")
          }
        >
          {banner.text}
        </div>
      )}

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
            Enter each employee&rsquo;s prior-system YTD figures below, then activate.
          </p>
        )}
      </section>

      <OpeningBalancesWorkspace
        taxYear={currentTaxYear}
        clubId={clubId}
        canWrite={canWrite}
        employees={rows}
        firstSpectrePayDate={declaration?.firstSpectrePayDate?.toISOString() ?? null}
        actions={{
          saveDraft: saveOpeningBalanceDraftAction,
          validate: validateOpeningBalanceAction,
          activate: activateOpeningBalanceAction,
          bulkValidate: bulkValidateOpeningBalancesAction,
          bulkActivate: bulkActivateOpeningBalancesAction,
          importCsv: importOpeningBalancesCsvAction,
        }}
      />
    </div>
  );
}
