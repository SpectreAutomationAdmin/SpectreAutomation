// EPW-1 hotfix (2026-09-20) — Employee-inline opening-YTD actions.
//
// These thin wrappers call the SAME canonical services as
// /app/admin/payroll/setup/opening-balances/_actions.ts
// (createDraftOpeningBalance / validateOpeningBalance /
// activateOpeningBalance) but redirect back to the EMPLOYEE profile
// so the founder never leaves the employee page for opening-YTD work.
//
// Permissions and lifecycle are unchanged. The Club-wide bulk /
// import flows still live at the Payroll Settings route; only the
// per-employee draft → validate → activate loop is provided here.

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { getCurrentUser } from "@/lib/session";
import {
  createDraftOpeningBalance,
  validateOpeningBalance,
  activateOpeningBalance,
  addOpeningComponentBalance,
  removeOpeningComponentBalance,
  type OpeningBalanceFields,
  type PriorPayrollKind,
} from "@/lib/payroll/opening-balance";
import { isAppError, ValidationError } from "@/lib/errors";

async function context() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/app/admin");
  return { principal, clubId };
}

function backToEmployee(employeeId: string, err?: string, ok?: string): never {
  const q = new URLSearchParams();
  q.set("tab", "payroll");
  if (err) q.set("obErr", err);
  if (ok) q.set("obOk", ok);
  redirect(`/app/admin/people/employees/${employeeId}?${q.toString()}`);
}

function readAmount(fd: FormData, key: string): string {
  const raw = String(fd.get(key) ?? "").trim();
  if (raw === "") return "0";
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError([{ path: key, message: `${key} must be a non-negative number.` }]);
  }
  return raw;
}

/** Save a DRAFT opening balance for a single employee. Redirects
 *  back to the employee page with the tab preserved. */
export async function saveEmployeeOpeningYtdDraftAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const employeeId = String(formData.get("employeeId") ?? "").trim();
  if (!employeeId) redirect("/app/admin");
  const taxYearRaw = String(formData.get("taxYear") ?? "").trim();
  const throughRaw = String(formData.get("throughPayDate") ?? "").trim();
  const kindRaw = String(formData.get("priorPayrollKind") ?? "PRIOR_SYSTEM_SAME_EMPLOYER").trim();
  const priorEmployerId = String(formData.get("priorEmployerId") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || undefined;

  const taxYear = Number.parseInt(taxYearRaw, 10);
  if (!Number.isInteger(taxYear)) backToEmployee(employeeId, "Tax year is required.");
  if (!throughRaw) backToEmployee(employeeId, "Through pay date is required.");
  const throughPayDate = new Date(throughRaw + "T00:00:00.000Z");
  if (Number.isNaN(throughPayDate.getTime())) backToEmployee(employeeId, "Through pay date is invalid.");
  const kind: PriorPayrollKind =
    ["PRIOR_SYSTEM_SAME_EMPLOYER", "PRIOR_EMPLOYER", "PRIOR_ADJUSTMENT"].includes(kindRaw)
      ? (kindRaw as PriorPayrollKind)
      : "PRIOR_SYSTEM_SAME_EMPLOYER";

  try {
    const values: OpeningBalanceFields = {
      ytdGrossEarnings:       readAmount(formData, "ytdGrossEarnings"),
      ytdTaxableEarnings:     readAmount(formData, "ytdTaxableEarnings"),
      ytdPensionableEarnings: readAmount(formData, "ytdPensionableEarnings"),
      ytdInsurableEarnings:   readAmount(formData, "ytdInsurableEarnings"),
      ytdCppEE_Base:          readAmount(formData, "ytdCppEE_Base"),
      ytdCppEE_FirstAdd:      readAmount(formData, "ytdCppEE_FirstAdd"),
      ytdCppEE:               readAmount(formData, "ytdCppEE"),
      ytdCpp2EE:              readAmount(formData, "ytdCpp2EE"),
      ytdEiEE:                readAmount(formData, "ytdEiEE"),
      ytdFederalTax:          readAmount(formData, "ytdFederalTax"),
      ytdProvincialTax:       readAmount(formData, "ytdProvincialTax"),
      ytdCppER_Base:          readAmount(formData, "ytdCppER_Base"),
      ytdCppER_FirstAdd:      readAmount(formData, "ytdCppER_FirstAdd"),
      ytdCppER:               readAmount(formData, "ytdCppER"),
      ytdCpp2ER:              readAmount(formData, "ytdCpp2ER"),
      ytdEiER:                readAmount(formData, "ytdEiER"),
    };
    await createDraftOpeningBalance(principal, clubId, {
      employeeId, taxYear, values, throughPayDate,
      priorPayrollKind: kind, priorEmployerId,
      notes, importSource: "MANUAL",
    });
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = isAppError(err) ? err.safeMessage : (err as Error).message;
    backToEmployee(employeeId, `Could not save draft: ${msg}`);
  }
  revalidatePath(`/app/admin/people/employees/${employeeId}`);
  backToEmployee(employeeId, undefined, "Opening YTD saved as draft.");
}

/** Validate a DRAFT → VALIDATED (aka "Ready"). */
export async function validateEmployeeOpeningYtdAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const employeeId = String(formData.get("employeeId") ?? "").trim();
  const id = String(formData.get("id") ?? "").trim();
  if (!employeeId || !id) redirect("/app/admin");
  try {
    await validateOpeningBalance(principal, clubId, id);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    backToEmployee(
      employeeId,
      `Could not validate: ${isAppError(err) ? err.safeMessage : (err as Error).message}`,
    );
  }
  revalidatePath(`/app/admin/people/employees/${employeeId}`);
  backToEmployee(employeeId, undefined, "Opening YTD marked Ready.");
}

/** FPP-1 (2026-09-19) — add a per-Component opening balance to a DRAFT
 *  opening YTD row. Redirects back to the employee page. */
export async function addEmployeeOpeningYtdComponentAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const employeeId = String(formData.get("employeeId") ?? "").trim();
  const openingBalanceId = String(formData.get("openingBalanceId") ?? "").trim();
  const componentId = String(formData.get("componentId") ?? "").trim();
  const ytdRaw = String(formData.get("ytdAmount") ?? "").trim();
  const notesRaw = String(formData.get("notes") ?? "").trim() || null;
  if (!employeeId) redirect("/app/admin");
  if (!openingBalanceId) backToEmployee(employeeId, "Missing openingBalanceId.");
  if (!componentId) backToEmployee(employeeId, "Pick a component before adding.");
  const ytdAmount = ytdRaw === "" ? "0" : ytdRaw;
  const n = Number(ytdAmount);
  if (!Number.isFinite(n) || n < 0) {
    backToEmployee(employeeId, "Component amount must be a non-negative number.");
  }
  try {
    await addOpeningComponentBalance(principal, clubId, {
      openingBalanceId,
      componentId,
      ytdAmount,
      notes: notesRaw,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = isAppError(err) ? err.safeMessage : (err as Error).message;
    backToEmployee(employeeId, `Could not add component: ${msg}`);
  }
  revalidatePath(`/app/admin/people/employees/${employeeId}`);
  backToEmployee(employeeId, undefined, "Component opening balance added.");
}

/** FPP-1 — remove a per-Component opening balance from a DRAFT opening YTD row. */
export async function removeEmployeeOpeningYtdComponentAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const employeeId = String(formData.get("employeeId") ?? "").trim();
  const openingComponentId = String(formData.get("openingComponentId") ?? "").trim();
  if (!employeeId) redirect("/app/admin");
  if (!openingComponentId) backToEmployee(employeeId, "Missing openingComponentId.");
  try {
    await removeOpeningComponentBalance(principal, clubId, openingComponentId);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = isAppError(err) ? err.safeMessage : (err as Error).message;
    backToEmployee(employeeId, `Could not remove component: ${msg}`);
  }
  revalidatePath(`/app/admin/people/employees/${employeeId}`);
  backToEmployee(employeeId, undefined, "Component opening balance removed.");
}

/** Activate a VALIDATED/DRAFT → ACTIVE. */
export async function activateEmployeeOpeningYtdAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const employeeId = String(formData.get("employeeId") ?? "").trim();
  const id = String(formData.get("id") ?? "").trim();
  if (!employeeId || !id) redirect("/app/admin");
  try {
    await activateOpeningBalance(principal, clubId, id);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    backToEmployee(
      employeeId,
      `Could not activate: ${isAppError(err) ? err.safeMessage : (err as Error).message}`,
    );
  }
  revalidatePath(`/app/admin/people/employees/${employeeId}`);
  revalidatePath(`/app/admin/payroll/setup/opening-balances`);
  backToEmployee(employeeId, undefined, "Opening YTD activated.");
}
