// Slice C closeout (2026-09-18) — Payroll Settings → Benefits.
//
// Founder-facing configuration surface for club benefit plans (LTD,
// Health/Dental; RRSP shown as coming in Slice D). Plans link to
// PayrollComponents — the components own tax / pensionable / insurable
// / cash / GL semantics; the plan is a durable Club arrangement.

import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { listBenefitPlans } from "@/lib/payroll/benefit-plans";
import { listPayrollComponents } from "@/lib/payroll/components-catalogue";
import BenefitPlansEditor from "./BenefitPlansEditor";
import { createBenefitPlanAction, endBenefitPlanAction } from "./_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PayrollBenefitsSettingsPage({
  searchParams,
}: { searchParams?: { ok?: string; err?: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) redirect("/app/admin");

  const canWrite = hasPermission(principal, clubId, "payroll:config:write");

  const [plans, components] = await Promise.all([
    listBenefitPlans(principal, clubId, { includeInactive: true }),
    listPayrollComponents(principal, clubId, { includeInactive: false }),
  ]);

  const componentOptions = components
    .filter((c) => c.active)
    .map((c) => ({
      id: c.id,
      code: c.code,
      displayName: c.displayName,
      side: c.side as "EMPLOYEE" | "EMPLOYER",
      cashEffect: c.cashEffect as "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
      taxableEffect: (c.taxableEffect ?? "NONE") as "NONE" | "ADD" | "SUBTRACT",
      cppPensionableEffect: (c.cppPensionableEffect ?? "NONE") as "NONE" | "ADD" | "SUBTRACT",
      eiInsurableEffect: (c.eiInsurableEffect ?? "NONE") as "NONE" | "ADD" | "SUBTRACT",
      calculationMethod: c.calculationMethod,
      expenseAccountNumber: c.expenseAccountNumber ?? null,
      liabilityAccountNumber: c.liabilityAccountNumber ?? null,
    }));

  const banner: { tone: "success" | "error"; text: string } | null =
    searchParams?.ok
      ? { tone: "success", text: searchParams.ok }
      : searchParams?.err
      ? { tone: "error", text: searchParams.err }
      : null;

  return (
    <div className="max-w-[1100px]" data-testid="payroll-benefits-settings-page">
      <header className="mb-spectre-6">
        <nav className="mb-3">
          <Link
            href="/app/admin/payroll/setup"
            className="inline-flex items-center gap-1 text-[13px] text-stone-600 hover:text-stone-900"
          >
            <span aria-hidden>←</span>
            <span>Payroll setup</span>
          </Link>
        </nav>
        <div
          className="text-[11px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: "var(--spectre-text-muted)" }}
        >
          Finance · Payroll · Setup
        </div>
        <h1 className="mt-1 text-spectre-h1 font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
          Benefit plans
        </h1>
        <p className="mt-2 text-spectre-body" style={{ color: "var(--spectre-text-secondary)" }}>
          The Club-level arrangements employees can be enrolled in — Long-Term Disability,
          Health &amp; Dental. Each plan links to one or two Payroll components that
          determine tax, pensionable, insurable, and GL treatment. RRSP plans arrive in a
          later slice.
        </p>
      </header>

      {banner && (
        <div
          role="alert"
          className="mb-4 rounded px-3 py-2 text-sm"
          data-testid="benefits-banner"
          style={
            banner.tone === "success"
              ? { background: "#ecfdf5", color: "#065f46", border: "1px solid #a7f3d0" }
              : { background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca" }
          }
        >
          {banner.text}
        </div>
      )}

      <BenefitPlansEditor
        canWrite={canWrite}
        plans={plans}
        components={componentOptions}
        createAction={createBenefitPlanAction}
        endAction={endBenefitPlanAction}
      />
    </div>
  );
}
