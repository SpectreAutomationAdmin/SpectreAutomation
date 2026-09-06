// Payroll-3B-1 (2026-08-27) — canonical Payroll Setup admin surface.
//
// This is the founder-facing configuration page for Payroll. It is
// intentionally separate from the legacy `/app/admin/ops/payroll`
// entry point (which renders the pre-3A ops-side payroll ledger).
// The setup surface covers three concepts and nothing more:
//   1. Payroll Configuration + activation
//   2. Pay Groups
//   3. Employee ↔ Pay Group membership (effective-dated)
//
// No calculation, no periods, no batches. Those arrive in later
// Payroll-3B slices.

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { getCurrentUser } from "@/lib/session";
import {
  getPayrollClubConfig,
  checkPayrollActivationPreconditions,
  ALLOWED_PAY_FREQUENCIES,
  ALLOWED_PAYMENT_METHODS,
} from "@/lib/payroll/club-config";
import { listPayGroups } from "@/lib/payroll/pay-groups";
import { listMemberships } from "@/lib/payroll/pay-group-members";
import { listPayPeriods } from "@/lib/payroll/pay-periods";
import PayrollConfigForm from "./PayrollConfigForm";
import PayGroupsEditor from "./PayGroupsEditor";
import MembershipEditor from "./MembershipEditor";
import PayrollCalendarSection from "./PayrollCalendarSection";
import GlProfileEditor from "./GlProfileEditor";
import { listAccounts } from "@/lib/accounting/coa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PayrollSetupPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) redirect("/app/admin");

  const currentTaxYear = new Date().getUTCFullYear();
  const [config, preconditions, payGroups, memberships, club, candidateAdmins, candidateControllers, employees, currentYearPeriods, glProfile, coa] =
    await Promise.all([
      getPayrollClubConfig(principal, clubId),
      checkPayrollActivationPreconditions(clubId),
      listPayGroups(principal, clubId),
      listMemberships(principal, clubId),
      prisma.club.findFirst({ where: { id: clubId }, select: { id: true, name: true } }),
      // Candidate users for the two designated-role dropdowns —
      // filter server-side to only ACTIVE users who already hold
      // the required role at this Club.
      prisma.user.findMany({
        where: { status: "ACTIVE", clubRoles: { some: { clubId, roleKey: "PAYROLL_ADMIN" } } },
        select: { id: true, name: true, email: true },
        orderBy: [{ name: "asc" }],
      }),
      prisma.user.findMany({
        where: { status: "ACTIVE", clubRoles: { some: { clubId, roleKey: "CONTROLLER" } } },
        select: { id: true, name: true, email: true },
        orderBy: [{ name: "asc" }],
      }),
      prisma.employee.findMany({
        where: { clubId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          preferredName: true,
          employeeNumber: true,
          employeeLifecycle: true,
        },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      }),
      listPayPeriods(principal, clubId, { taxYear: currentTaxYear }),
      // Payroll-3C-6A — global Payroll GL Accounting Profile + tenant CoA.
      prisma.payrollGlAccountingProfile.findUnique({ where: { clubId } }),
      listAccounts(principal, clubId, { includeArchived: false }),
    ]);
    // Group periods by pay-group id for the calendar section.
    const initialCalendarByGroup: Record<string, ReturnType<typeof serializePeriod>[]> = {};
    for (const p of currentYearPeriods) {
      const list = initialCalendarByGroup[p.payGroupId] ?? [];
      list.push(serializePeriod(p));
      initialCalendarByGroup[p.payGroupId] = list;
    }
  if (!club) redirect("/app/admin");

  const canWrite = hasPermission(principal, clubId, "payroll:write");

  return (
    <div className="max-w-[960px]" data-testid="payroll-setup-page">
      <header className="mb-spectre-8">
        <div
          className="text-[11px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: "var(--spectre-text-muted)" }}
        >
          Operations
        </div>
        <h1 className="mt-1 text-spectre-h1 font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
          Payroll setup
        </h1>
        <p className="mt-2 text-spectre-body" style={{ color: "var(--spectre-text-secondary)" }}>
          Configure Payroll for {club.name}. Set up your jurisdiction, pay groups, and who each
          employee belongs to. This page covers configuration only — it does not run payroll.
        </p>
      </header>

      {/* Section 1 — Payroll Configuration */}
      <SectionHeader
        eyebrow="Section 1"
        title="Payroll configuration"
        subtitle="Country and province, default pay frequency and payment method, and the two people responsible for running and approving payroll at your Club."
      />
      <section
        className="rounded-spectre-panel border p-spectre-6 mb-spectre-8"
        style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-hairline)" }}
      >
        <PayrollConfigForm
          clubId={clubId}
          canWrite={canWrite}
          config={config}
          preconditions={preconditions}
          allowedPayFrequencies={[...ALLOWED_PAY_FREQUENCIES]}
          allowedPaymentMethods={[...ALLOWED_PAYMENT_METHODS]}
          candidateAdmins={candidateAdmins}
          candidateControllers={candidateControllers}
        />
      </section>

      {/* Section 2 — Pay Groups */}
      <SectionHeader
        eyebrow="Section 2"
        title="Pay Groups"
        subtitle="Group your employees by how they're paid. A typical Club has one salaried group and one or more hourly groups on different pay cycles."
      />
      <section
        className="rounded-spectre-panel border p-spectre-6 mb-spectre-8"
        style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-hairline)" }}
      >
        <PayGroupsEditor
          clubId={clubId}
          canWrite={canWrite}
          initialPayGroups={payGroups}
          allowedPayFrequencies={[...ALLOWED_PAY_FREQUENCIES]}
        />
      </section>

      {/* Section 3 — Membership */}
      <SectionHeader
        eyebrow="Section 3"
        title="Employees & Pay Groups"
        subtitle="Assign employees to a Pay Group. Assignments are effective-dated — you can schedule a future assignment or end a current one without touching history."
      />
      <section
        className="rounded-spectre-panel border p-spectre-6 mb-spectre-8"
        style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-hairline)" }}
      >
        <MembershipEditor
          clubId={clubId}
          canWrite={canWrite}
          initialMemberships={memberships.map((m) => ({
            ...m,
            effectiveFrom: m.effectiveFrom.toISOString(),
            effectiveTo: m.effectiveTo?.toISOString() ?? null,
            createdAt: m.createdAt.toISOString(),
            updatedAt: m.updatedAt.toISOString(),
          }))}
          payGroups={payGroups.map((g) => ({ id: g.id, code: g.code, name: g.name, active: g.active }))}
          employees={employees.map((e) => ({
            id: e.id,
            display: [e.preferredName?.trim() || e.firstName, e.lastName]
              .filter(Boolean)
              .join(" "),
            employeeNumber: e.employeeNumber,
            lifecycle: e.employeeLifecycle,
          }))}
        />
      </section>

      {/* Section 4 — Payroll Calendar */}
      <SectionHeader
        eyebrow="Section 4"
        title="Payroll calendar"
        subtitle="Generate the schedule of pay periods for each Pay Group. Payroll year is determined by the pay date — a period worked in December but paid in January belongs to the January year."
      />
      <section
        className="rounded-spectre-panel border p-spectre-6 mb-spectre-8"
        style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-hairline)" }}
      >
        <PayrollCalendarSection
          clubId={clubId}
          canWrite={canWrite}
          payGroups={payGroups}
          initialByGroup={initialCalendarByGroup}
          defaultTaxYear={currentTaxYear}
        />
      </section>

      {/* Section 5 — Payroll GL profile (Payroll-3C-6A, 2026-09-05) */}
      <SectionHeader
        eyebrow="Section 5"
        title="Payroll GL profile"
        subtitle="The 8 tenant-wide accounts every payroll journal debits or credits. Set these once for your Chart of Accounts; per-component mappings (Section 6) route specific earnings, benefits, and deductions to more granular accounts."
      />
      <section
        className="rounded-spectre-panel border p-spectre-6 mb-spectre-8"
        style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-hairline)" }}
        data-testid="payroll-gl-profile-section"
      >
        <GlProfileEditor
          clubId={clubId}
          canWrite={canWrite}
          accounts={coa
            .filter((a) => a.isActive)
            .map((a) => ({ id: a.id, accountNumber: a.accountNumber, name: a.name, type: a.type }))}
          initialProfile={{
            salaryExpenseAccountId:        glProfile?.salaryExpenseAccountId        ?? null,
            employerCppExpenseAccountId:   glProfile?.employerCppExpenseAccountId   ?? null,
            employerEiExpenseAccountId:    glProfile?.employerEiExpenseAccountId    ?? null,
            netPayPayableAccountId:        glProfile?.netPayPayableAccountId        ?? null,
            cppPayableAccountId:           glProfile?.cppPayableAccountId           ?? null,
            eiPayableAccountId:            glProfile?.eiPayableAccountId            ?? null,
            federalTaxPayableAccountId:    glProfile?.federalTaxPayableAccountId    ?? null,
            provincialTaxPayableAccountId: glProfile?.provincialTaxPayableAccountId ?? null,
          }}
        />
      </section>

      {/* Section 6 — Payroll Components (Payroll-3C-1, 2026-09-07; edit UI 3C-6A, 2026-09-05) */}
      <SectionHeader
        eyebrow="Section 6"
        title="Payroll components"
        subtitle="Tenant catalogue of every distinct compensation, benefit, and deduction concept your Club operates. Assign an expense and/or liability account per component so payroll can post to your Chart of Accounts."
      />
      <section
        className="rounded-spectre-panel border p-spectre-6 mb-spectre-8"
        style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-hairline)" }}
        data-testid="payroll-components-section"
      >
        <p className="mb-2 text-sm" style={{ color: "var(--spectre-text-secondary)" }}>
          View the components catalogue, including cash vs non-cash, employee vs employer side,
          and how each component participates in Canadian statutory bases (taxable / CPP-pensionable / EI-insurable).
        </p>
        <a
          href="/app/admin/payroll/setup/components"
          className="btn btn-secondary btn-sm"
          data-testid="payroll-components-link"
        >
          Open Payroll components →
        </a>
      </section>
    </div>
  );
}

function serializePeriod(p: {
  id: string;
  sequenceInYear: number;
  taxYear: number;
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
  status: string;
  payGroupId: string;
}) {
  return {
    id: p.id,
    sequenceInYear: p.sequenceInYear,
    taxYear: p.taxYear,
    periodStart: p.periodStart.toISOString(),
    periodEnd: p.periodEnd.toISOString(),
    payDate: p.payDate.toISOString(),
    status: p.status,
  };
}

function SectionHeader({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return (
    <div className="mb-spectre-3">
      <div
        className="text-[11px] font-semibold uppercase tracking-[0.06em]"
        style={{ color: "var(--spectre-text-muted)" }}
      >
        {eyebrow}
      </div>
      <h2 className="mt-1 text-spectre-h2 font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
        {title}
      </h2>
      <p className="mt-1 text-spectre-body-sm" style={{ color: "var(--spectre-text-secondary)" }}>
        {subtitle}
      </p>
    </div>
  );
}
