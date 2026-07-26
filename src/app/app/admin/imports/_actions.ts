"use server";

// Server action for the New Batch form on /app/admin/imports.
//
// Accepts EITHER pasted CSV text OR an uploaded CSV file — but not
// both at the same time. The client form enforces mutual exclusion
// in the UI; this server action enforces it again as the authoritative
// gate (a hand-crafted POST that submits both should still be
// rejected).
//
// Errors are surfaced via the `spectre_import_error` cookie + a
// `revalidatePath` so the page re-renders with the error banner.
// This matches the existing pattern on the page and avoids dragging
// useFormState through the client component just for one error
// channel.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { getActiveClubId } from "@/lib/active-club";
import { isAppError } from "@/lib/errors";
import { createBatch, deleteDraftBatch, validateBatch, applyCoaAutoMapping } from "@/lib/imports";
import { ensureStandardAccountingConfiguration } from "@/lib/accounting/ensure-standard-configuration";
import { parseCsvRows, parseTrialBalanceCsv } from "@/lib/imports/csv-parse";
import { parseXlsxRows, parseTrialBalanceXlsx, looksLikeXlsx, isLikelyTextual } from "@/lib/imports/xlsx-parse";
import { IMPORT_TEMPLATE_METADATA, supportsXlsx, type ImportDomain } from "@/lib/imports/templates";
import { getCurrentPrincipal } from "@/lib/services/principal";
// Founder rule 2026-07-02 v15.1 — Fund Applicability canonicalisation.
import {
  parseFundApplicability,
  serializeFundApplicability,
} from "@/lib/accounting/fund-applicability";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const VALID_DOMAINS: ReadonlyArray<ImportDomain> = [
  "MEMBERS",
  "VENDORS",
  "COA",
  "OPENING_TRIAL_BALANCE",
  "INVENTORY",
  "EMPLOYEES",
  "EVENTS",
  "AR_HISTORY",
];

function setError(message: string) {
  cookies().set("spectre_import_error", message, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: 30,
  });
  revalidatePath("/app/admin/imports");
}

export async function createBatchAction(formData: FormData): Promise<void> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });

  const domainRaw = String(formData.get("domain") ?? "").trim();
  if (!VALID_DOMAINS.includes(domainRaw as ImportDomain)) {
    setError("Select an import domain before submitting.");
    return;
  }
  const domain = domainRaw as ImportDomain;

  // ----- Input source: pasted text XOR uploaded file ----------------------
  const csvText = String(formData.get("csv") ?? "").trim();
  const fileEntry = formData.get("csvFile");
  const hasFile =
    fileEntry instanceof File && fileEntry.size > 0 && fileEntry.name.length > 0;
  const hasText = csvText.length > 0;

  // Founder rule 2026-06-30 v14.1 — XLSX opt-in is per-domain via
  // the shared `supportsXlsx` helper. `isCoa` remains for the
  // COA-specific post-upload behavior (auto-mapping + redirect).
  // `isTb` handles the TB auto-validate + redirect so the operator
  // lands on the preview screen directly after upload.
  const isCoa = domain === "COA";
  const isTb = domain === "OPENING_TRIAL_BALANCE";
  const xlsxOk = supportsXlsx(domain);

  // Defensive tenant bootstrap for COA uploads. A club provisioned
  // before the standard-accounting-configuration bootstrap existed can
  // have zero AccountCategory / FinancialStatementGroup rows — in that
  // state every canonical categoryKey / fsGroupKey on the CSV would
  // fail validation with "not configured for this club" and mislead
  // the founder. Idempotent + non-destructive; a fully-configured
  // tenant is a no-op.
  if (isCoa) {
    await ensureStandardAccountingConfiguration(clubId);
  }
  const metadata = IMPORT_TEMPLATE_METADATA[domain];
  if (hasFile && hasText) {
    setError(
      xlsxOk
        ? "Use only one input source — either upload a workbook / CSV file OR paste CSV content, not both."
        : "Use only one input source — either upload a CSV file OR paste CSV content, not both.",
    );
    return;
  }
  if (!hasFile && !hasText) {
    setError(
      xlsxOk
        ? `Upload a ${metadata.displayName} workbook (.xlsx) or CSV file, or paste CSV content before submitting.`
        : "Upload a CSV file or paste CSV content before submitting.",
    );
    return;
  }

  let rows: Array<Record<string, string>>;
  let fileName: string;
  let source: "CSV" | "XLSX" = "CSV";
  // Founder rule 2026-06-30 v14.3 — auto-detected trial balance
  // period. Only set for OPENING_TRIAL_BALANCE uploads; every
  // other domain leaves this null.
  let detectedAsOfDate: Date | null = null;
  if (hasFile) {
    const file = fileEntry as File;
    if (file.size > MAX_FILE_BYTES) {
      setError(
        `Uploaded file is larger than ${(MAX_FILE_BYTES / (1024 * 1024)).toFixed(0)} MB. Split it into smaller batches.`,
      );
      return;
    }
    fileName = file.name;
    // Auto-detect format: file extension + OPC magic bytes. XLSX
    // routes through the workbook parser; everything else routes
    // through the existing CSV parser. Both paths normalise to
    // the same Record<string, string>[] shape downstream so the
    // createBatch contract stays unchanged.
    const arrayBuffer = await file.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    const isXlsx = looksLikeXlsx(fileName, buf);

    // Guard against obviously-unsupported binary uploads (Word,
    // PDF, images, etc). XLSX magic is PK\x03\x04 — also the
    // signature of every ZIP container, so any non-XLSX zip that
    // sneaks past the extension check would fail downstream
    // anyway with a clearer error. For non-XLSX file paths we
    // require the content to look like text.
    if (!isXlsx) {
      const looksTextual = isLikelyTextual(buf);
      if (!looksTextual) {
        setError(
          xlsxOk
            ? "Unsupported file type. Upload an .xlsx workbook or a .csv file."
            : "Unsupported file type. Upload a .csv file.",
        );
        return;
      }
    }

    try {
      if (isXlsx) {
        if (isTb) {
          // Founder rule 2026-06-30 v14.3 — TB XLSX flows through
          // the dedicated wrapper so we ALSO detect the report
          // period ("Trial Balance for May, 2026") from the
          // pre-header rows and persist it on the batch.
          const parsed = await parseTrialBalanceXlsx(buf);
          rows = parsed.rows;
          detectedAsOfDate = parsed.detectedAsOfDate;
        } else {
          rows = await parseXlsxRows(buf, { domain });
        }
        source = "XLSX";
      } else {
        const csv = buf.toString("utf8");
        if (isTb) {
          const parsed = parseTrialBalanceCsv(csv);
          rows = parsed.rows;
          detectedAsOfDate = parsed.detectedAsOfDate;
        } else {
          rows = parseCsvRows(csv, { domain });
        }
      }
    } catch (err) {
      setError(
        `${metadata.displayName} file could not be parsed. ${(err as Error).message}`,
      );
      return;
    }
  } else {
    try {
      if (isTb) {
        const parsed = parseTrialBalanceCsv(csvText);
        rows = parsed.rows;
        detectedAsOfDate = parsed.detectedAsOfDate;
      } else {
        rows = parseCsvRows(csvText, { domain });
      }
    } catch (err) {
      setError(`Pasted CSV could not be parsed. ${(err as Error).message}`);
      return;
    }
    fileName = "pasted.csv";
  }

  if (rows.length === 0) {
    setError(
      `${metadata.displayName} file had a header row but no data rows.`,
    );
    return;
  }

  // Founder rule 2026-07-14: a COA upload immediately parses,
  // creates, AND validates the batch in the same workflow, then
  // sends the operator to the detail page so the
  // auto-scroll-to-first-error UX (CoaMappingTable) lands
  // immediately. Other domains keep the original "land on the
  // list" flow until they adopt the same upgrade.
  let createdBatchId: string | null = null;
  try {
    const created = await createBatch(principal, {
      clubId,
      domain,
      rows,
      source,
      fileName,
      // v14.3 — persist the detected TB period so the preview
      // page renders "Trial Balance as of: April 30, 2026" and
      // the commit path posts the journal on that same date.
      options: detectedAsOfDate ? { asOfDate: detectedAsOfDate.toISOString() } : undefined,
    });
    createdBatchId = created.id;
    if (isCoa) {
      // Founder rule 2026-06-29: COA uploads run the intelligent
      // auto-mapping engine BEFORE validation, so the operator
      // lands on the mapping screen with predictions already in
      // place. Existing-account matches inherit the club's prior
      // decisions; name keywords + number ranges handle new rows.
      await applyCoaAutoMapping(principal, created.id);
      // Then validate against the predictions so the list never
      // shows a misleading "0 valid / 0 errors" state. The two
      // calls share a request — the operator's only click after
      // upload is "Complete import" on whatever predictions
      // landed cleanly.
      await validateBatch(principal, created.id);
    } else if (isTb) {
      // Founder rule 2026-06-30 v14.1 — Trial Balance uploads
      // auto-validate so the operator lands on the preview
      // screen (Σ debit / Σ credit / variance + unmatched
      // accounts panel) directly. No manual "Dry run" click.
      await validateBatch(principal, created.id);
    }
  } catch (err) {
    if (isAppError(err)) {
      setError(err.safeMessage);
      return;
    }
    throw err;
  }
  revalidatePath("/app/admin/imports");
  if ((isCoa || isTb) && createdBatchId) {
    // Redirect lands the operator on the batch detail page:
    //   • COA — the mapping table auto-scrolls to the first
    //     error and surfaces predictions inline.
    //   • Trial Balance — the preview panel (v14) shows totals,
    //     variance, unmatched accounts, and parsed rows.
    redirect(`/app/admin/imports/${createdBatchId}`);
  }
}

// ---------------------------------------------------------------------------
// Delete a draft batch.
// ---------------------------------------------------------------------------
// Thin wrapper around `deleteDraftBatch`. Tenant + DRAFT-status
// gating live in the library function; this just surfaces the
// outcome to the page via the success/error cookies.

function setNotice(message: string) {
  cookies().set("spectre_import_notice", message, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: 30,
  });
  revalidatePath("/app/admin/imports");
}

// Founder rule 2026-06-30 v14.3 — manual-fallback action for the
// Trial Balance as-of date. Wired from the preview page when the
// auto-detect returned null (no title row in the file). Persists
// the date to the batch's optionsJson so the commit path can
// read it and post the journal on that day.
export async function setTrialBalanceAsOfDateAction(formData: FormData): Promise<void> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const batchId = String(formData.get("batchId") ?? "").trim();
  const asOfInput = String(formData.get("asOfDate") ?? "").trim();
  if (!batchId) { setError("Missing batch id."); return; }
  if (!asOfInput) { setError("Enter the Trial Balance as-of date."); return; }
  const parsed = new Date(asOfInput);
  if (!Number.isFinite(parsed.getTime())) { setError("Invalid Trial Balance as-of date."); return; }
  try {
    const { setTrialBalanceAsOfDate } = await import("@/lib/imports");
    await setTrialBalanceAsOfDate(principal, batchId, parsed);
  } catch (err) {
    if (isAppError(err)) { setError(err.safeMessage); return; }
    throw err;
  }
  revalidatePath(`/app/admin/imports/${batchId}`);
  redirect(`/app/admin/imports/${batchId}`);
}

// Founder rule 2026-06-30 v14.5 — void a committed Trial Balance
// batch. Reverses the ledger impact + marks the batch VOIDED.
// Reason is required so the audit trail carries operator intent.
export async function voidBatchAction(formData: FormData): Promise<void> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const batchId = String(formData.get("batchId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!batchId) { setError("Missing batch id."); return; }
  if (!reason) { setError("Void reason is required."); return; }
  try {
    const { voidCommittedBatch } = await import("@/lib/imports");
    const voided = await voidCommittedBatch(principal, batchId, reason);
    setNotice(`Trial Balance batch voided: ${voided.fileName ?? voided.id}`);
  } catch (err) {
    if (isAppError(err)) { setError(err.safeMessage); return; }
    throw err;
  }
  revalidatePath("/app/admin/imports");
  redirect("/app/admin/imports");
}

// Founder rule 2026-07-01 v14.16 — approve unmatched TB accounts +
// re-validate the batch. Reads a form with one row per approved
// account (fields prefixed `row.<n>.*`). Skips unapproved rows.
export async function approveTbMappingsAction(formData: FormData): Promise<void> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const batchId = String(formData.get("batchId") ?? "").trim();
  if (!batchId) { setError("Missing batch id."); return; }

  // Extract per-row approved data. The form uses `row.<rowNumber>.<field>`
  // keys plus a per-row `row.<rowNumber>.approved` checkbox.
  const approved: Array<{
    accountNumber: string; name: string; type: string;
    categoryKey: string | null; fsGroupKey: string | null;
    defaultDepartmentCode: string | null;
    fundApplicability: string | null;
  }> = [];
  // Founder rule 2026-07-02 v15.1 — Fund Applicability: collect
  // every ticked checkbox for the row prefix, canonicalise +
  // dedupe, then serialise. Empty selection falls through to
  // the tb-map-accounts service which defaults from the FS Group.
  const collectFundForRow = (prefix: string): string | null => {
    const tokens = formData.getAll(`${prefix}.fundApplicability`)
      .map((v) => String(v).trim().toUpperCase())
      .filter((v) => v.length > 0);
    return serializeFundApplicability(parseFundApplicability(tokens.join(",")));
  };
  for (const key of Array.from(formData.keys())) {
    if (!key.endsWith(".approved")) continue;
    if (formData.get(key) !== "on") continue;
    const prefix = key.slice(0, -".approved".length);
    const num = String(formData.get(`${prefix}.accountNumber`) ?? "").trim();
    const name = String(formData.get(`${prefix}.name`) ?? "").trim();
    const type = String(formData.get(`${prefix}.type`) ?? "").trim();
    const categoryKey = String(formData.get(`${prefix}.categoryKey`) ?? "").trim() || null;
    const fsGroupKey = String(formData.get(`${prefix}.fsGroupKey`) ?? "").trim() || null;
    const departmentCode = String(formData.get(`${prefix}.departmentCode`) ?? "").trim() || null;
    if (!num || !name || !type) continue; // required-field validation
    approved.push({
      accountNumber: num, name, type,
      categoryKey, fsGroupKey,
      defaultDepartmentCode: departmentCode,
      fundApplicability: collectFundForRow(prefix),
    });
  }
  if (approved.length === 0) {
    setError("Approve at least one account (tick the checkbox) before submitting.");
    redirect(`/app/admin/imports/${batchId}/map-accounts`);
  }
  try {
    const { approveTbMappedAccounts } = await import("@/lib/imports/tb-map-accounts");
    const result = await approveTbMappedAccounts(principal, batchId, approved);

    // Founder rule 2026-07-01 v14.19 — the operator MUST see WHY
    // any row failed. Prior behaviour only surfaced counts, and
    // the notice cookie was set but never rendered on the batch
    // detail page (the redirect target), so a run of "31 approved
    // → 0 created → 31 failed" looked identical to "31 approved
    // → 31 created" from the operator's perspective. Now:
    //   • Success path → notice cookie with counts + a line
    //     explicitly stating the batch was re-validated.
    //   • Failure path → error cookie with the per-row
    //     accountNumber + the exact createAccount reason so the
    //     operator can go back to /map-accounts and re-approve.
    // Cookie size is capped by the trailing `.slice()` — the same
    // 4 KiB cookie budget applies to every message we set here.
    const parts = [`${result.created} created`];
    if (result.skippedExisting > 0) parts.push(`${result.skippedExisting} skipped (already exist)`);
    if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);
    const summary = `Accounts mapped: ${parts.join(", ")}. Batch re-validated.`;
    if (result.failed.length > 0) {
      // Per-row failure detail — the operator can identify each
      // offending accountNumber + the createAccount reason (e.g.
      // "Unknown FS group: BS_LEASE_LIABILITIES") and fix it in
      // the map-accounts screen without leaving the batch.
      const rendered = result.failed
        .map((f) => `${f.accountNumber} (${f.error})`)
        .join("; ")
        .slice(0, 3500);
      setError(`${summary} Failed rows: ${rendered}`);
    } else {
      setNotice(summary);
    }
  } catch (err) {
    if (isAppError(err)) { setError(err.safeMessage); return; }
    throw err;
  }
  revalidatePath(`/app/admin/imports/${batchId}`);
  redirect(`/app/admin/imports/${batchId}`);
}

export async function deleteDraftBatchAction(batchId: string): Promise<void> {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  try {
    const result = await deleteDraftBatch(principal, batchId);
    setNotice(`Draft ${result.domain} batch deleted.`);
  } catch (err) {
    if (isAppError(err)) {
      setError(err.safeMessage);
      return;
    }
    throw err;
  }
}
