// Founder rule 2026-06-30 v13 — Chart of Accounts maintenance actions.
//
// These wrap the lib/accounting/coa service so the COA list page can
// trigger create / update / archive / delete from a single client
// modal. Every action follows the same shape: parse FormData,
// permission-gate, delegate to coa.ts, redirect with success or error
// query params for the page to surface.
//
// The same Zod schema (createAccountSchema / updateAccountSchema)
// validates BOTH manual UI actions AND the import path — there is
// no parallel validation logic per founder constraint.

"use server";

import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import {
  createAccount,
  updateAccount,
  archiveAccount,
  deleteAccount,
  checkAccountDeletionSafety,
} from "@/lib/accounting/coa";
import {
  parseFundApplicability,
  serializeFundApplicability,
} from "@/lib/accounting/fund-applicability";
import { applyBulkFundApplicability } from "@/lib/accounting/bulk-fund-applicability";
import { isAppError } from "@/lib/errors";

function fdString(fd: FormData, key: string): string | null {
  const v = fd.get(key);
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
function fdRequired(fd: FormData, key: string): string {
  const v = fdString(fd, key);
  if (!v) throw new Error(`${key} is required`);
  return v;
}
function fdBool(fd: FormData, key: string): boolean {
  return fd.get(key) === "on" || fd.get(key) === "true";
}

/**
 * Founder rule 2026-07-02 v15.1 — Fund Applicability multi-select
 * arrives as one form-field per fund key (name="fundApplicability"
 * type="checkbox", value="OPERATING" / "CAPITAL" / ...). Collect
 * every "on" checkbox, canonicalise, and return the CSV form the
 * service layer stores. Empty selection returns null so the
 * service's derive-default path kicks in on create.
 */
function fdFundApplicability(fd: FormData): string | null {
  const tokens = fd.getAll("fundApplicability")
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
  return serializeFundApplicability(parseFundApplicability(tokens.join(",")));
}

export async function createAccountAction(formData: FormData) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    // v15.1 — Fund Applicability: if the operator explicitly
    // picked at least one fund, pass their selection through.
    // Otherwise let the service's FS-Group derive-default fire
    // (which handles balance-sheet accounts → null AND P&L
    // accounts → operating/capital per FS Group).
    const explicitFund = fdFundApplicability(formData);
    const { account, warnings } = await createAccount(p, clubId, {
      accountNumber: fdRequired(formData, "accountNumber"),
      name: fdRequired(formData, "name"),
      description: fdString(formData, "description"),
      type: fdRequired(formData, "type"),
      categoryKey: fdString(formData, "categoryKey"),
      fsGroupKey: fdString(formData, "fsGroupKey"),
      parentAccountNumber: fdString(formData, "parentAccountNumber"),
      defaultDepartmentCode: fdString(formData, "defaultDepartmentCode"),
      fundApplicability: explicitFund ?? undefined,
      isHeader: false,
      allowManualPosting: !fdBool(formData, "_allowManualPostingOff"),
      isControlAccount: fdBool(formData, "isControlAccount"),
      isBankAccount: fdBool(formData, "isBankAccount"),
      isCashAccount: fdBool(formData, "isCashAccount"),
      isTaxRelevant: fdBool(formData, "isTaxRelevant"),
    });
    if (warnings.length > 0) {
      redirect(`/app/admin/coa?ok=created&num=${account.accountNumber}&warning=${encodeURIComponent(warnings.join(" "))}`);
    }
    redirect(`/app/admin/coa?ok=created&num=${account.accountNumber}`);
  } catch (err) {
    if (isAppError(err)) redirect(`/app/admin/coa?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
}

export async function updateAccountAction(formData: FormData) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const accountId = fdRequired(formData, "accountId");
  try {
    // v15.1 — Fund Applicability on edit. Presence of the
    // hidden `_fundApplicabilityForm` sentinel means the edit
    // form is submitting fund fields; treat "no boxes ticked" as
    // an explicit null (operator wants BS-style clear). Absence
    // means the form omitted the fund control entirely — leave
    // the field untouched.
    const fundSubmitted = formData.has("_fundApplicabilityForm");
    const explicitFund = fundSubmitted ? fdFundApplicability(formData) : undefined;
    const { account, warnings } = await updateAccount(p, accountId, {
      accountNumber: fdString(formData, "accountNumber") ?? undefined,
      name: fdString(formData, "name") ?? undefined,
      description: fdString(formData, "description"),
      type: fdString(formData, "type") ?? undefined,
      categoryKey: fdString(formData, "categoryKey"),
      fsGroupKey: fdString(formData, "fsGroupKey"),
      parentAccountNumber: fdString(formData, "parentAccountNumber"),
      defaultDepartmentCode: fdString(formData, "defaultDepartmentCode"),
      fundApplicability: fundSubmitted ? explicitFund : undefined,
      isControlAccount: formData.has("isControlAccount") ? fdBool(formData, "isControlAccount") : undefined,
      isBankAccount: formData.has("isBankAccount") ? fdBool(formData, "isBankAccount") : undefined,
      isCashAccount: formData.has("isCashAccount") ? fdBool(formData, "isCashAccount") : undefined,
      isTaxRelevant: formData.has("isTaxRelevant") ? fdBool(formData, "isTaxRelevant") : undefined,
      allowManualPosting: formData.has("allowManualPosting") ? fdBool(formData, "allowManualPosting") : undefined,
    });
    if (warnings.length > 0) {
      redirect(`/app/admin/coa?ok=updated&num=${account.accountNumber}&warning=${encodeURIComponent(warnings.join(" "))}`);
    }
    redirect(`/app/admin/coa?ok=updated&num=${account.accountNumber}`);
  } catch (err) {
    if (isAppError(err)) redirect(`/app/admin/coa?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
}

export async function archiveAccountAction(formData: FormData) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const accountId = fdRequired(formData, "accountId");
  try {
    const account = await archiveAccount(p, accountId);
    redirect(`/app/admin/coa?ok=archived&num=${account.accountNumber}`);
  } catch (err) {
    if (isAppError(err)) redirect(`/app/admin/coa?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
}

export async function reactivateAccountAction(formData: FormData) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const accountId = fdRequired(formData, "accountId");
  try {
    const { account } = await updateAccount(p, accountId, { isActive: true });
    redirect(`/app/admin/coa?ok=reactivated&num=${account.accountNumber}`);
  } catch (err) {
    if (isAppError(err)) redirect(`/app/admin/coa?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
}

export async function deleteAccountAction(formData: FormData) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const accountId = fdRequired(formData, "accountId");
  try {
    const r = await deleteAccount(p, accountId);
    redirect(`/app/admin/coa?ok=deleted&num=${r.accountNumber}`);
  } catch (err) {
    if (isAppError(err)) redirect(`/app/admin/coa?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
}

// Server-side "preflight" endpoint the Delete confirmation modal
// calls to render the list of blockers BEFORE the operator confirms.
// Returns a typed blocker list so the UI can show actionable copy.
export async function getDeletionSafety(accountId: string) {
  const p = await getCurrentPrincipal();
  if (!p) throw new Error("Not authenticated");
  return checkAccountDeletionSafety(p, accountId);
}

/**
 * Bulk-update server action — thin adapter over
 * `applyBulkFundApplicability`. Parses FormData, validates the
 * "at least one fund" requirement, delegates the DB work to the
 * pure helper, and translates the result into a redirect banner.
 *
 * The pure helper lives in `@/lib/accounting/bulk-fund-applicability`
 * so a regression test can exercise the exact `findMany` +
 * `update` pair (including the `select: { fundApplicability: true }`
 * byte) without simulating FormData or the redirect plumbing.
 */
// -----------------------------------------------------------------------
// Phase B — Reload-less inspector save (2026-07-18).
//
// The Data Workspace inspector calls this action instead of the
// redirect-driven `updateAccountAction` above. It runs the SAME
// `updateAccount(...)` service call and enforces the SAME
// permission / validation / tenant / audit rules — the difference
// is that it RETURNS a discriminated result the client can render
// without a full page navigation.
//
// `updateAccountAction` (redirect-based) is preserved unchanged so
// bookmarks, deep links, and the legacy edit paths that still hit
// it (e.g. a submit fired from an external form) continue to
// resolve `?ok=updated`.
// -----------------------------------------------------------------------

export type InspectorSaveResult =
  | { status: "saved"; accountNumber: string; warnings: string[] }
  | { status: "validation-error"; message: string }
  | { status: "permission-denied"; message: string }
  | { status: "server-error"; message: string };

export async function updateAccountInspectorAction(
  formData: FormData,
): Promise<InspectorSaveResult> {
  const p = await getCurrentPrincipal();
  if (!p) return { status: "permission-denied", message: "Not authenticated" };
  const accountId = fdString(formData, "accountId");
  if (!accountId) return { status: "validation-error", message: "accountId is required" };
  // Fast-fail permission gate (the service also enforces this).
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "coa:write")) {
    return {
      status: "permission-denied",
      message: "Your role does not have permission to maintain the Chart of Accounts.",
    };
  }
  try {
    const fundSubmitted = formData.has("_fundApplicabilityForm");
    const explicitFund = fundSubmitted ? fdFundApplicability(formData) : undefined;
    const { account, warnings } = await updateAccount(p, accountId, {
      accountNumber: fdString(formData, "accountNumber") ?? undefined,
      name: fdString(formData, "name") ?? undefined,
      description: fdString(formData, "description"),
      type: fdString(formData, "type") ?? undefined,
      categoryKey: fdString(formData, "categoryKey"),
      fsGroupKey: fdString(formData, "fsGroupKey"),
      parentAccountNumber: fdString(formData, "parentAccountNumber"),
      defaultDepartmentCode: fdString(formData, "defaultDepartmentCode"),
      fundApplicability: fundSubmitted ? explicitFund : undefined,
      isControlAccount: formData.has("isControlAccount") ? fdBool(formData, "isControlAccount") : undefined,
      isBankAccount: formData.has("isBankAccount") ? fdBool(formData, "isBankAccount") : undefined,
      isCashAccount: formData.has("isCashAccount") ? fdBool(formData, "isCashAccount") : undefined,
      isTaxRelevant: formData.has("isTaxRelevant") ? fdBool(formData, "isTaxRelevant") : undefined,
      allowManualPosting: formData.has("allowManualPosting") ? fdBool(formData, "allowManualPosting") : undefined,
    });
    return {
      status: "saved",
      accountNumber: account.accountNumber,
      warnings,
    };
  } catch (err) {
    if (isAppError(err)) {
      return { status: "validation-error", message: err.safeMessage };
    }
    // Unknown error — surface a stable message; the underlying
    // exception is still thrown by the service layer for observability.
    const msg = err instanceof Error ? err.message : "Server error saving account";
    return { status: "server-error", message: msg };
  }
}

// -----------------------------------------------------------------------
// Phase B — Bulk archive from the workspace selection bar.
//
// Loops over the selected account IDs and delegates to the existing
// per-account `archiveAccount` service, which enforces permissions,
// audit, and business rules per row. Any per-row failure is reported
// in the warning banner so partial success is visible.
// -----------------------------------------------------------------------

export async function bulkArchiveAccountsAction(formData: FormData) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const ids = formData.getAll("accountIds")
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
  if (ids.length === 0) {
    redirect(`/app/admin/coa?error=${encodeURIComponent("Select at least one account before archiving.")}`);
  }
  let archived = 0;
  const failures: string[] = [];
  for (const id of ids) {
    try {
      await archiveAccount(p, id);
      archived++;
    } catch (err) {
      if (isAppError(err)) failures.push(err.safeMessage);
      else failures.push(err instanceof Error ? err.message : "unknown error");
    }
  }
  if (archived === 0) {
    redirect(`/app/admin/coa?error=${encodeURIComponent(`No accounts archived. ${failures.join(" · ")}`)}`);
  }
  const parts = [`${archived} account${archived === 1 ? "" : "s"} archived.`];
  if (failures.length > 0) parts.push(`${failures.length} skipped: ${failures.join(" · ")}`);
  redirect(`/app/admin/coa?ok=archived&num=${archived}&warning=${encodeURIComponent(parts.join(" "))}`);
}

export async function bulkSetFundApplicabilityAction(formData: FormData) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    const accountIds = formData.getAll("accountIds")
      .map((v) => String(v).trim())
      .filter((v) => v.length > 0);
    if (accountIds.length === 0) {
      redirect(`/app/admin/coa?error=${encodeURIComponent("Select at least one account before setting Fund Applicability.")}`);
    }
    const explicitFund = fdFundApplicability(formData);
    // Empty selection → treat as invalid input for BULK (a
    // deliberate clear is available via individual edit). See
    // helper contract for rationale.
    if (!explicitFund) {
      redirect(`/app/admin/coa?error=${encodeURIComponent("Tick at least one fund (Operating / Capital) before bulk-applying.")}`);
    }
    const result = await applyBulkFundApplicability(p, clubId, accountIds, explicitFund);
    const parts = [`${result.updated} account${result.updated === 1 ? "" : "s"} updated to Fund Applicability = ${result.fundApplicability}`];
    if (result.skippedBs > 0) parts.push(`${result.skippedBs} balance-sheet account${result.skippedBs === 1 ? "" : "s"} skipped (Fund Applicability is a P&L concept)`);
    redirect(`/app/admin/coa?ok=bulk-fund&num=${result.updated}&warning=${encodeURIComponent(parts.join(". "))}`);
  } catch (err) {
    if (isAppError(err)) redirect(`/app/admin/coa?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
}

