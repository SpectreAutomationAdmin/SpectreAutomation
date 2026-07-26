import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { createAccount } from "@/lib/accounting/coa";
import { isAppError } from "@/lib/errors";
import {
  KNOWN_FUND_KEYS,
  parseFundApplicability,
  serializeFundApplicability,
} from "@/lib/accounting/fund-applicability";

async function createAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    // Founder spec 2026-07-08: do not create header accounts
    // via the UI. Every new account is a posting account; the
    // legacy `isHeader` flag stays off.
    // Founder rule 2026-07-02 v15.1 — Fund Applicability from
    // the multi-select. Empty selection means "let the service
    // derive from FS Group" (the safe default for imports); an
    // explicit selection is used verbatim.
    const fundTokens = formData.getAll("fundApplicability")
      .map((v) => String(v).trim()).filter((v) => v.length > 0);
    const explicitFund = serializeFundApplicability(parseFundApplicability(fundTokens.join(",")));
    const { account, warnings } = await createAccount(p, clubId, {
      accountNumber: String(formData.get("accountNumber") ?? "").trim(),
      name: String(formData.get("name") ?? "").trim(),
      description: String(formData.get("description") ?? "").trim() || null,
      type: String(formData.get("type")),
      categoryKey: String(formData.get("categoryKey") ?? "").trim() || null,
      parentAccountNumber: String(formData.get("parentAccountNumber") ?? "").trim() || null,
      fsGroupKey: String(formData.get("fsGroupKey") ?? "").trim() || null,
      defaultDepartmentCode: String(formData.get("defaultDepartmentCode") ?? "").trim() || null,
      fundApplicability: explicitFund ?? undefined,
      isHeader: false,
      allowManualPosting: formData.get("allowManualPosting") !== "off",
      isControlAccount: formData.get("isControlAccount") === "on",
      isBankAccount: formData.get("isBankAccount") === "on",
      isCashAccount: formData.get("isCashAccount") === "on",
      isTaxRelevant: formData.get("isTaxRelevant") === "on",
    });
    // Founder rule 2026-06-30 v13 — surface duplicate-name
    // warnings to the operator on the redirect target. The
    // account was created (warnings are soft), but the next
    // page shows the message so the operator can confirm.
    if (warnings.length > 0) {
      redirect(`/app/admin/coa?warning=${encodeURIComponent(warnings.join(" "))}&created=${account.accountNumber}`);
    }
  } catch (err) {
    if (isAppError(err)) redirect(`/app/admin/coa/new?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
  redirect("/app/admin/coa");
}

export default async function NewAccountPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "coa:write")) redirect("/app/admin/coa");

  const [categories, fsGroups, parents, departments] = await Promise.all([
    prisma.accountCategory.findMany({ where: { clubId }, orderBy: { sortOrder: "asc" } }),
    prisma.financialStatementGroup.findMany({ where: { clubId }, orderBy: { sortOrder: "asc" } }),
    // Parent selector — surfaces every active account so an
    // operator can nest under any existing posting account.
    // The legacy "only headers can be parents" filter is gone.
    prisma.account.findMany({ where: { clubId, isActive: true }, orderBy: { accountNumber: "asc" } }),
    prisma.department.findMany({ where: { clubId }, orderBy: { sortOrder: "asc" } }),
  ]);

  return (
    <div className="max-w-3xl">
      <Link href="/app/admin/coa" className="text-sm text-stone-500 hover:text-club-ink">← Chart of Accounts</Link>
      <h1 className="page-title mt-3">New account</h1>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <form action={createAction} className="mt-6 card card-body space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Account number *</label>
            <input className="input font-mono" name="accountNumber" required maxLength={40} placeholder="e.g. 6450" />
          </div>
          <div>
            <label className="label">Type *</label>
            <select className="select" name="type" required>
              <option value="ASSET">Asset</option>
              <option value="LIABILITY">Liability</option>
              <option value="EQUITY">Equity</option>
              <option value="REVENUE">Revenue</option>
              <option value="EXPENSE">Expense</option>
            </select>
          </div>
        </div>
        <div>
          <label className="label">Name *</label>
          <input className="input" name="name" required maxLength={200} />
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="textarea" name="description" rows={2} maxLength={2000} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Category</label>
            <select className="select" name="categoryKey" defaultValue="">
              <option value="">— None —</option>
              {categories.map((c) => <option key={c.id} value={c.key}>{c.name} ({c.type})</option>)}
            </select>
          </div>
          <div>
            <label className="label">FS group</label>
            <select className="select" name="fsGroupKey" defaultValue="">
              <option value="">— None —</option>
              {fsGroups.map((g) => <option key={g.id} value={g.key}>{g.name} ({g.statement})</option>)}
            </select>
          </div>
        </div>
        {/* Founder rule 2026-07-02 v15.1 — Fund Applicability
            multi-select. Sits directly under the FS Group
            selector per the founder spec. Empty selection lets
            the service derive from FS Group at save time. */}
        <div data-testid="coa-new-fund-applicability">
          <label className="label">
            Fund Applicability
            <span className="ml-2 text-xs text-stone-500 font-normal">
              Profit &amp; Loss accounts only
            </span>
          </label>
          <div className="flex flex-wrap gap-4 mt-1">
            {KNOWN_FUND_KEYS.map((k) => (
              <label
                key={k}
                className="flex items-center gap-2 text-sm"
                data-testid={`coa-new-fund-${k}`}
              >
                <input
                  type="checkbox"
                  name="fundApplicability"
                  value={k}
                />
                <span className="capitalize">{k.toLowerCase()}</span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-stone-500">
            Leave both unchecked to derive the default from the FS Group
            (Capital Assessments → Capital; all other P&amp;L → Operating).
            Balance-sheet accounts never carry a fund tag.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Parent account</label>
            <select className="select" name="parentAccountNumber" defaultValue="">
              <option value="">— None —</option>
              {parents.map((p) => <option key={p.id} value={p.accountNumber}>{p.accountNumber} · {p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Default department</label>
            <select className="select" name="defaultDepartmentCode" defaultValue="">
              <option value="">— None —</option>
              {departments.map((d) => <option key={d.id} value={d.code}>{d.name}</option>)}
            </select>
          </div>
        </div>
        <fieldset className="grid grid-cols-2 md:grid-cols-3 gap-2 pt-2">
          <legend className="label">Flags</legend>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isControlAccount" /> Control account</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isBankAccount" /> Bank account</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isCashAccount" /> Cash account</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isTaxRelevant" /> Tax-relevant</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="allowManualPosting" defaultChecked /> Allow manual posting</label>
        </fieldset>
        <div className="flex justify-end">
          <button type="submit" className="btn btn-primary">Create account</button>
        </div>
      </form>
    </div>
  );
}
