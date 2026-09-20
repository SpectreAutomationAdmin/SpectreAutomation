// FPP-2 (2026-09-20) — Employee Opening YTD dedicated workspace page.
//
// The approved reference PNG resolves the modal-vs-page question in
// favour of a full workspace page. Entry path is
// People → Employee Directory → <employee> → Payroll → Opening YTD.
//
// The page renders inside the employee shell (photo header + status
// pill + primary tab strip) with a two-column body: the main workspace
// on the left (6-card grid + notes + bottom action bar) and a right
// guidance rail. The Payroll tab remains active in the strip and links
// back to the employee page's Payroll tab; the tab strip stays visible
// so the founder never feels lost.
//
// All persistence flows through the FPP-2 atomic action
// (saveEmployeeOpeningYtdAtomicAction) plus the direct-edit / add /
// remove component actions. Nothing about the Payroll-3B lifecycle
// (DRAFT → VALIDATED → ACTIVE → SUPERSEDED) is weakened.

export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getEmployee } from "@/lib/hr/employees";
import { isAppError } from "@/lib/errors";
import { getImplementationDeclaration } from "@/lib/payroll/implementation-declaration";
import {
  getActiveOpeningBalance,
  listOpeningComponentBalances,
} from "@/lib/payroll/opening-balance";
import OpeningYtdWorkspace from "@/components/hr/OpeningYtdWorkspace";
import {
  saveEmployeeOpeningYtdAtomicAction,
  validateEmployeeOpeningYtdAction,
  activateEmployeeOpeningYtdAction,
  addEmployeeOpeningYtdComponentAction,
  removeEmployeeOpeningYtdComponentAction,
  updateEmployeeOpeningYtdComponentAction,
} from "../_opening-ytd-actions";

const currentTaxYear = new Date().getUTCFullYear();

function initials(first: string, last: string) {
  return ((first?.[0] ?? "") + (last?.[0] ?? "")).toUpperCase();
}

function formatDate(iso: string | Date | null): string {
  if (!iso) return "Not set";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleDateString("en-CA", {
    year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
  });
}

export default async function EmployeeOpeningYtdWorkspacePage({
  params, searchParams,
}: {
  params: { id: string };
  searchParams?: Promise<{ obErr?: string; obOk?: string }>;
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  const sp = (await (searchParams ?? Promise.resolve({}))) as { obErr?: string; obOk?: string };
  const flash: { tone: "success" | "error"; text: string } | null =
    sp.obOk ? { tone: "success", text: sp.obOk }
    : sp.obErr ? { tone: "error", text: sp.obErr }
    : null;

  let profile: Awaited<ReturnType<typeof getEmployee>>;
  try {
    profile = await getEmployee(principal, params.id);
  } catch (err) {
    if (isAppError(err) && err.httpStatus === 404) notFound();
    if (isAppError(err) && err.httpStatus === 403) redirect("/app/admin");
    throw err;
  }

  const club = await prisma.club.findUnique({
    where: { id: profile.clubId },
    select: { id: true, name: true },
  });

  const canRead = hasPermission(principal, profile.clubId, "payroll:read");
  const canWrite = hasPermission(principal, profile.clubId, "payroll:run");

  if (!canRead) redirect(`/app/admin/people/employees/${profile.id}?tab=payroll`);

  const [declaration, activeOB] = await Promise.all([
    getImplementationDeclaration(principal, profile.clubId, currentTaxYear).catch(() => null),
    getActiveOpeningBalance(profile.clubId, profile.id, currentTaxYear).catch(() => null),
  ]);

  let editable: {
    id: string;
    taxYear: number;
    status: "DRAFT" | "VALIDATED" | "ACTIVE" | "SUPERSEDED";
    throughPayDate: Date | null;
    priorPayrollKind: "PRIOR_SYSTEM_SAME_EMPLOYER" | "PRIOR_EMPLOYER" | "PRIOR_ADJUSTMENT" | null;
    updatedAt: Date | null;
    values: {
      ytdGrossEarnings: string; ytdTaxableEarnings: string;
      ytdPensionableEarnings: string; ytdInsurableEarnings: string;
      ytdCppEE_Base: string; ytdCppEE_FirstAdd: string; ytdCppEE: string;
      ytdCpp2EE: string; ytdEiEE: string;
      ytdFederalTax: string; ytdProvincialTax: string;
      ytdCppER_Base: string; ytdCppER_FirstAdd: string; ytdCppER: string;
      ytdCpp2ER: string; ytdEiER: string;
    };
  } | null = activeOB
    ? {
        id: activeOB.id, taxYear: activeOB.taxYear,
        status: activeOB.status,
        throughPayDate: activeOB.throughPayDate,
        priorPayrollKind: activeOB.priorPayrollKind,
        updatedAt: activeOB.updatedAt,
        values: activeOB.values,
      }
    : null;

  if (!editable) {
    const draftRow = await prisma.payrollOpeningBalance.findFirst({
      where: {
        clubId: profile.clubId,
        employeeId: profile.id,
        taxYear: currentTaxYear,
        status: { in: ["DRAFT", "VALIDATED"] },
      },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    });
    if (draftRow) {
      editable = {
        id: draftRow.id,
        taxYear: draftRow.taxYear,
        status: draftRow.status as "DRAFT" | "VALIDATED" | "ACTIVE" | "SUPERSEDED",
        throughPayDate: draftRow.throughPayDate,
        priorPayrollKind: draftRow.priorPayrollKind as
          "PRIOR_SYSTEM_SAME_EMPLOYER" | "PRIOR_EMPLOYER" | "PRIOR_ADJUSTMENT" | null,
        updatedAt: draftRow.updatedAt,
        values: {
          ytdGrossEarnings: draftRow.ytdGrossEarnings.toString(),
          ytdTaxableEarnings: draftRow.ytdTaxableEarnings.toString(),
          ytdPensionableEarnings: draftRow.ytdPensionableEarnings.toString(),
          ytdInsurableEarnings: draftRow.ytdInsurableEarnings.toString(),
          ytdCppEE_Base: draftRow.ytdCppEE_Base.toString(),
          ytdCppEE_FirstAdd: draftRow.ytdCppEE_FirstAdd.toString(),
          ytdCppEE: draftRow.ytdCppEE.toString(),
          ytdCpp2EE: draftRow.ytdCpp2EE.toString(),
          ytdEiEE: draftRow.ytdEiEE.toString(),
          ytdFederalTax: draftRow.ytdFederalTax.toString(),
          ytdProvincialTax: draftRow.ytdProvincialTax.toString(),
          ytdCppER_Base: draftRow.ytdCppER_Base.toString(),
          ytdCppER_FirstAdd: draftRow.ytdCppER_FirstAdd.toString(),
          ytdCppER: draftRow.ytdCppER.toString(),
          ytdCpp2ER: draftRow.ytdCpp2ER.toString(),
          ytdEiER: draftRow.ytdEiER.toString(),
        },
      };
    }
  }

  const [openingComponentRows, openingComponentCatalogue] = await Promise.all([
    editable
      ? listOpeningComponentBalances(principal, profile.clubId, editable.id).catch(() => [])
      : Promise.resolve([]),
    prisma.payrollComponent.findMany({
      where: { clubId: profile.clubId },
      select: {
        id: true, code: true, displayName: true, category: true,
        side: true, cashEffect: true, active: true,
      },
      orderBy: [{ displayOrder: "asc" }, { displayName: "asc" }],
    }),
  ]);

  const displayName = profile.preferredName?.trim().length
    ? `${profile.preferredName} ${profile.lastName}`
    : `${profile.firstName} ${profile.lastName}`;

  const status = profile.employeeLifecycle.toUpperCase();
  const hireLabel = profile.hireDate ? formatDate(profile.hireDate) : "Not set";

  return (
    <div className="fpp2-page">
      {/* Reuses the employee shell chrome so the founder never feels
          teleported off the profile — matches the reference PNG's
          "People > Employee Directory > Chris Turcato > Payroll >
          Opening YTD" breadcrumb + identity header + tab strip. */}
      <nav className="fpp2-breadcrumb" aria-label="Breadcrumb">
        <Link href="/app/admin/people/employees">People</Link>
        <span className="fpp2-breadcrumb-sep">›</span>
        <Link href="/app/admin/people/employees">Employee Directory</Link>
        <span className="fpp2-breadcrumb-sep">›</span>
        <Link href={`/app/admin/people/employees/${profile.id}`}>{displayName}</Link>
        <span className="fpp2-breadcrumb-sep">›</span>
        <Link href={`/app/admin/people/employees/${profile.id}?tab=payroll`}>Payroll</Link>
        <span className="fpp2-breadcrumb-sep">›</span>
        <span className="fpp2-breadcrumb-current">Opening YTD</span>
      </nav>

      <header className="fpp2-employee-header">
        <div className="fpp2-employee-photo">
          {profile.profilePhotoDocumentId ? (
            /* eslint-disable-next-line @next/next/no-img-element -- authenticated same-origin stream */
            <img
              src={`/api/hr/employees/${profile.id}/profile-photo?v=${profile.profilePhotoDocumentId}`}
              alt={`${displayName} profile photo`}
            />
          ) : (
            <span className="fpp2-employee-initials">{initials(profile.firstName, profile.lastName)}</span>
          )}
        </div>
        <div className="fpp2-employee-body">
          <div className="fpp2-employee-name-row">
            <h1 className="fpp2-employee-name">{displayName}</h1>
            <span
              className={`fpp2-status-pill fpp2-status-pill--${profile.employeeLifecycle.toLowerCase()}`}
              data-testid="fpp2-employee-status-pill"
            >
              {status.replace(/_/g, " ")}
            </span>
          </div>
          <div className="fpp2-employee-meta">
            <span>Employee # <span className="fpp2-mono">{profile.employeeNumber}</span></span>
            <span aria-hidden="true" className="fpp2-meta-sep">|</span>
            <span>Hired {hireLabel}</span>
            {club?.name ? (
              <>
                <span aria-hidden="true" className="fpp2-meta-sep">|</span>
                <span>{club.name}</span>
              </>
            ) : null}
          </div>
        </div>
      </header>

      <nav className="fpp2-tabs" role="tablist" aria-label="Employee sections">
        {[
          { key: "overview",     label: "Overview" },
          { key: "employment",   label: "Employment" },
          { key: "payroll",      label: "Payroll", active: true },
          { key: "benefits",     label: "Benefits" },
          { key: "training",     label: "Training" },
          { key: "documents",    label: "Documents" },
          { key: "history",      label: "History" },
        ].map((t) => (
          <Link
            key={t.key}
            href={`/app/admin/people/employees/${profile.id}?tab=${t.key}`}
            className={`fpp2-tab ${t.active ? "fpp2-tab--active" : ""}`}
            role="tab"
            aria-selected={t.active ? "true" : "false"}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {flash ? (
        <div
          className={`fpp2-flash fpp2-flash--${flash.tone}`}
          role={flash.tone === "error" ? "alert" : "status"}
        >
          {flash.text}
        </div>
      ) : null}

      <OpeningYtdWorkspace
        employeeId={profile.id}
        employeeName={displayName}
        clubName={club?.name ?? ""}
        taxYear={currentTaxYear}
        firstSpectrePayDateIso={declaration?.firstSpectrePayDate?.toISOString() ?? null}
        canWrite={canWrite}
        status={(editable?.status as "MISSING" | "DRAFT" | "VALIDATED" | "ACTIVE" | "SUPERSEDED") ?? "MISSING"}
        openingBalanceId={editable?.id ?? null}
        throughPayDateIso={editable?.throughPayDate ? editable.throughPayDate.toISOString() : null}
        priorPayrollKind={(editable?.priorPayrollKind ?? null) as
          "PRIOR_SYSTEM_SAME_EMPLOYER" | "PRIOR_EMPLOYER" | "PRIOR_ADJUSTMENT" | null}
        lastSavedIso={editable?.updatedAt ? editable.updatedAt.toISOString() : null}
        values={editable?.values ?? null}
        componentOpenings={openingComponentRows.map((r) => ({
          id: r.id, componentCode: r.componentCode, displayName: r.displayName,
          category: r.category, side: r.side, cashEffect: r.cashEffect, ytdAmount: r.ytdAmount,
        }))}
        componentCatalogue={openingComponentCatalogue.map((c) => ({
          id: c.id, code: c.code, displayName: c.displayName, category: c.category,
          side: c.side as "EMPLOYEE" | "EMPLOYER",
          cashEffect: c.cashEffect as "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
          active: c.active,
        }))}
        actions={{
          saveDraft:       saveEmployeeOpeningYtdAtomicAction,
          validate:        validateEmployeeOpeningYtdAction,
          activate:        activateEmployeeOpeningYtdAction,
          addComponent:    addEmployeeOpeningYtdComponentAction,
          removeComponent: removeEmployeeOpeningYtdComponentAction,
          updateComponent: updateEmployeeOpeningYtdComponentAction,
        }}
        backHref={`/app/admin/people/employees/${profile.id}?tab=payroll`}
      />
    </div>
  );
}
