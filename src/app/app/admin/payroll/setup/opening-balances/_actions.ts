// v-slice-1-followup-8 (2026-09-16) — Opening YTD Balances founder
// server actions. Wraps the canonical opening-balance service
// (draft/validate/activate/bulk-validate/bulk-activate) and the
// opening-balance-import.ts CSV importer for the Payroll Settings
// → Opening YTD Balances surface.

"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import {
  createDraftOpeningBalance,
  validateOpeningBalance,
  activateOpeningBalance,
  listOpeningBalances,
  type OpeningBalanceFields,
  type PriorPayrollKind,
} from "@/lib/payroll/opening-balance";
import {
  importOpeningBalancesFromCsv,
  OPENING_BALANCE_CSV_HEADERS,
} from "@/lib/payroll/opening-balance-import";
import { isAppError, ValidationError } from "@/lib/errors";

async function context() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/app/admin");
  return { principal, clubId };
}

function back(err?: string, ok?: string): never {
  const q = new URLSearchParams();
  if (err) q.set("obErr", err);
  if (ok) q.set("obOk", ok);
  redirect(`/app/admin/payroll/setup/opening-balances${q.toString() ? `?${q.toString()}` : ""}`);
}

// Reads a numeric field from FormData with graceful fallback to "0"
// so the founder can leave zero fields blank. Rejects non-numeric.
function readAmount(fd: FormData, key: string): string {
  const raw = String(fd.get(key) ?? "").trim();
  if (raw === "") return "0";
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError([{ path: key, message: `${key} must be a non-negative number.` }]);
  }
  // Preserve founder-supplied precision to 4 decimals (Decimal DB).
  return raw;
}

/** Save (or refresh) a DRAFT opening balance for a single employee. */
export async function saveOpeningBalanceDraftAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const employeeId = String(formData.get("employeeId") ?? "").trim();
  const taxYearRaw = String(formData.get("taxYear") ?? "").trim();
  const throughRaw = String(formData.get("throughPayDate") ?? "").trim();
  const kindRaw = String(formData.get("priorPayrollKind") ?? "PRIOR_SYSTEM_SAME_EMPLOYER").trim();
  const priorEmployerId = String(formData.get("priorEmployerId") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || undefined;

  const taxYear = Number.parseInt(taxYearRaw, 10);
  if (!Number.isInteger(taxYear)) back("Tax year is required.");
  if (!employeeId) back("Employee id is required.");
  if (!throughRaw) back("Through pay date is required.");
  const throughPayDate = new Date(throughRaw + "T00:00:00.000Z");
  if (Number.isNaN(throughPayDate.getTime())) back("Through pay date is invalid.");
  const kind: PriorPayrollKind = ["PRIOR_SYSTEM_SAME_EMPLOYER", "PRIOR_EMPLOYER", "PRIOR_ADJUSTMENT"].includes(kindRaw)
    ? (kindRaw as PriorPayrollKind)
    : "PRIOR_SYSTEM_SAME_EMPLOYER";

  try {
    const values: OpeningBalanceFields = {
      ytdGrossEarnings: readAmount(formData, "ytdGrossEarnings"),
      ytdTaxableEarnings: readAmount(formData, "ytdTaxableEarnings"),
      ytdPensionableEarnings: readAmount(formData, "ytdPensionableEarnings"),
      ytdInsurableEarnings: readAmount(formData, "ytdInsurableEarnings"),
      ytdCppEE_Base: readAmount(formData, "ytdCppEE_Base"),
      ytdCppEE_FirstAdd: readAmount(formData, "ytdCppEE_FirstAdd"),
      ytdCppEE: readAmount(formData, "ytdCppEE"),
      ytdCpp2EE: readAmount(formData, "ytdCpp2EE"),
      ytdEiEE: readAmount(formData, "ytdEiEE"),
      ytdFederalTax: readAmount(formData, "ytdFederalTax"),
      ytdProvincialTax: readAmount(formData, "ytdProvincialTax"),
      ytdCppER_Base: readAmount(formData, "ytdCppER_Base"),
      ytdCppER_FirstAdd: readAmount(formData, "ytdCppER_FirstAdd"),
      ytdCppER: readAmount(formData, "ytdCppER"),
      ytdCpp2ER: readAmount(formData, "ytdCpp2ER"),
      ytdEiER: readAmount(formData, "ytdEiER"),
    };
    await createDraftOpeningBalance(principal, clubId, {
      employeeId, taxYear, values, throughPayDate,
      priorPayrollKind: kind, priorEmployerId,
      notes, importSource: "MANUAL",
    });
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    const msg = isAppError(err) ? err.safeMessage : (err as Error).message;
    back(`Could not save draft: ${msg}`);
  }
  revalidatePath("/app/admin/payroll/setup/opening-balances");
  back(undefined, "Opening balance saved as draft.");
}

/** Validate one DRAFT → VALIDATED. */
export async function validateOpeningBalanceAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) back("Opening balance id is required.");
  try {
    await validateOpeningBalance(principal, clubId, id);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    back(`Could not validate: ${isAppError(err) ? err.safeMessage : (err as Error).message}`);
  }
  revalidatePath("/app/admin/payroll/setup/opening-balances");
  back(undefined, "Opening balance marked Ready.");
}

/** Activate one VALIDATED/DRAFT → ACTIVE. */
export async function activateOpeningBalanceAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) back("Opening balance id is required.");
  try {
    await activateOpeningBalance(principal, clubId, id);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    back(`Could not activate: ${isAppError(err) ? err.safeMessage : (err as Error).message}`);
  }
  revalidatePath("/app/admin/payroll/setup/opening-balances");
  revalidatePath("/app/admin/payroll");
  back(undefined, "Opening balance activated.");
}

/** Bulk validate every DRAFT for the given tax year. */
export async function bulkValidateOpeningBalancesAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const taxYear = Number.parseInt(String(formData.get("taxYear") ?? ""), 10);
  if (!Number.isInteger(taxYear)) back("Tax year is required.");
  try {
    const rows = await listOpeningBalances(principal, clubId, taxYear);
    const drafts = rows.filter((r) => r.status === "DRAFT");
    let ok = 0; const errors: string[] = [];
    for (const r of drafts) {
      try {
        await validateOpeningBalance(principal, clubId, r.id);
        ok += 1;
      } catch (e) {
        errors.push(`${r.employeeId.slice(-8)}: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    revalidatePath("/app/admin/payroll/setup/opening-balances");
    if (errors.length) {
      back(`Bulk validate: ${ok} succeeded, ${errors.length} failed — ${errors[0]}`);
    }
    back(undefined, `${ok} draft${ok === 1 ? "" : "s"} marked Ready.`);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    back(`Bulk validate failed: ${isAppError(err) ? err.safeMessage : (err as Error).message}`);
  }
}

/** Bulk activate every VALIDATED (and DRAFT if `alsoDrafts=1`). */
export async function bulkActivateOpeningBalancesAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const taxYear = Number.parseInt(String(formData.get("taxYear") ?? ""), 10);
  if (!Number.isInteger(taxYear)) back("Tax year is required.");
  const alsoDrafts = String(formData.get("alsoDrafts") ?? "").trim() === "1";
  try {
    const rows = await listOpeningBalances(principal, clubId, taxYear);
    const targets = rows.filter((r) => r.status === "VALIDATED" || (alsoDrafts && r.status === "DRAFT"));
    let ok = 0; const errors: string[] = [];
    for (const r of targets) {
      try {
        await activateOpeningBalance(principal, clubId, r.id);
        ok += 1;
      } catch (e) {
        errors.push(`${r.employeeId.slice(-8)}: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    revalidatePath("/app/admin/payroll/setup/opening-balances");
    revalidatePath("/app/admin/payroll");
    if (errors.length) {
      back(`Bulk activate: ${ok} succeeded, ${errors.length} failed — ${errors[0]}`);
    }
    back(undefined, `${ok} opening balance${ok === 1 ? "" : "s"} activated.`);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    back(`Bulk activate failed: ${isAppError(err) ? err.safeMessage : (err as Error).message}`);
  }
}

/** CSV import — commits every valid row as DRAFT + returns row errors. */
export async function importOpeningBalancesCsvAction(formData: FormData): Promise<void> {
  const { principal, clubId } = await context();
  const taxYear = Number.parseInt(String(formData.get("taxYear") ?? ""), 10);
  const throughRaw = String(formData.get("throughPayDate") ?? "").trim();
  const csv = String(formData.get("csvText") ?? "").trim();
  if (!Number.isInteger(taxYear)) back("Tax year is required.");
  if (!throughRaw) back("Through pay date is required.");
  if (!csv) back("CSV content is required.");
  const throughPayDate = new Date(throughRaw + "T00:00:00.000Z");
  if (Number.isNaN(throughPayDate.getTime())) back("Through pay date is invalid.");
  try {
    const result = await importOpeningBalancesFromCsv(principal, clubId, {
      csvText: csv, taxYear, throughPayDate, sourceFilename: "founder-upload.csv",
    });
    revalidatePath("/app/admin/payroll/setup/opening-balances");
    if (result.errors.length > 0) {
      const first = result.errors[0];
      back(
        `CSV imported ${result.createdOrRefreshed} drafts with ${result.errors.length} row error${
          result.errors.length === 1 ? "" : "s"
        } — row ${first.rowNumber} (${first.employeeNumber ?? "?"}): ${first.message.slice(0, 80)}`,
      );
    }
    back(undefined, `CSV imported ${result.createdOrRefreshed} draft${result.createdOrRefreshed === 1 ? "" : "s"}.`);
  } catch (err) {
    if (err instanceof Error && err.message === "NEXT_REDIRECT") throw err;
    back(`Could not import CSV: ${isAppError(err) ? err.safeMessage : (err as Error).message}`);
  }
}

/** Static CSV template download exposed as a server action so the
 *  founder gets the exact headers the importer expects. Rendered as a
 *  route in _template-route.ts (not here — routes cannot live inside
 *  server-action files). We export the header list for the download. */
export const OPENING_BALANCE_CSV_TEMPLATE_HEADERS = OPENING_BALANCE_CSV_HEADERS;
