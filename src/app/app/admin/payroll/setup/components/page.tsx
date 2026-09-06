// Payroll-3C-6A (2026-09-05) — Payroll Components with editable GL mapping.
//
// Formerly read-only (3C-1). Now delegates to ComponentsEditor, which
// renders the same catalogue table plus an "Edit GL mapping" dialog
// per row and a top-of-page readiness banner. Server-side data comes
// from `listPayrollComponents` (with the expense/liability account
// numbers hydrated) + `listAccounts` (for the picker options).

import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { listPayrollComponents } from "@/lib/payroll/components-catalogue";
import { listAccounts } from "@/lib/accounting/coa";
import ComponentsEditor from "./ComponentsEditor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function PayrollComponentsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId    = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "payroll:read")) redirect("/app/admin");

  const canWrite = hasPermission(principal, clubId, "payroll:write");

  const [components, accounts] = await Promise.all([
    listPayrollComponents(principal, clubId, { includeInactive: true }),
    listAccounts(principal, clubId, { includeArchived: false }),
  ]);

  const initial = components.map((c) => ({
    id: c.id, code: c.code, displayName: c.displayName,
    category: c.category, side: c.side as "EMPLOYEE" | "EMPLOYER",
    cashEffect: c.cashEffect as "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
    displaySection: c.displaySection, active: c.active,
    expenseAccountId:       c.expenseAccountId,
    liabilityAccountId:     c.liabilityAccountId,
    expenseAccountNumber:   c.expenseAccountNumber,
    liabilityAccountNumber: c.liabilityAccountNumber,
  }));
  const pickerAccounts = accounts
    .filter((a) => a.isActive)
    .map((a) => ({ id: a.id, accountNumber: a.accountNumber, name: a.name, type: a.type }));

  return (
    <div className="max-w-[1200px]" data-testid="payroll-components-page">
      <header className="mb-spectre-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em]"
             style={{ color: "var(--spectre-text-muted)" }}>
          Operations · Payroll · Setup
        </div>
        <h1 className="mt-1 text-spectre-h1 font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
          Payroll components
        </h1>
        <p className="mt-2 text-spectre-body" style={{ color: "var(--spectre-text-secondary)" }}>
          Every distinct compensation, benefit, and deduction concept this Club operates. GL mappings
          drive how each component posts to your Chart of Accounts. Changes are future-only — historical
          payrolls remain immutable.
        </p>
        <nav className="mt-3 text-sm">
          <Link href="/app/admin/payroll/setup" className="underline" style={{ color: "var(--spectre-text-secondary)" }}>
            ← Payroll setup
          </Link>
        </nav>
      </header>

      {components.length === 0 ? (
        <div
          className="rounded-lg border border-dashed p-8 text-center text-sm"
          style={{ borderColor: "var(--spectre-border-muted)", color: "var(--spectre-text-secondary)" }}
        >
          No Payroll Components configured yet.
        </div>
      ) : (
        <ComponentsEditor
          clubId={clubId}
          canWrite={canWrite}
          initialComponents={initial}
          accounts={pickerAccounts}
        />
      )}
    </div>
  );
}
