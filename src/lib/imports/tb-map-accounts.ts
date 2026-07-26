// Founder rule 2026-07-01 v14.16 — Trial Balance import: map + add
// unmatched accounts without leaving the import task.
//
// When a Trial Balance import lands on 31 accounts not in the club's
// Chart of Accounts, the operator previously had to leave the import
// flow, manually create each account, then re-import. This service
// closes that loop:
//
//   1. `getUnmatchedTbAccountSuggestions(clubId, batchId)` — reads
//      every ACCOUNT_NOT_FOUND row on the batch, runs each through
//      the existing `predictCoaRow` engine (10 slices of taxonomy +
//      keyword refinement), and returns per-row suggestions the
//      operator can review.
//   2. `approveTbMappedAccounts(principal, batchId, rows)` — takes
//      the operator's approved list, calls the SAME `createAccount`
//      the manual COA maintenance UI uses (v13 validation +
//      uniqueness + audit), then re-runs `validateBatch` so the
//      preview clears ACCOUNT_NOT_FOUND rows automatically.
//
// Zero duplicate business logic — the predictor, the account create
// path, and the batch validator are all pre-existing.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { ConflictError, NotFoundError } from "../errors";
import {
  predictCoaRow,
  type CoaPrediction,
  type ExistingAccountSnapshot,
} from "./coa-predictor";

// ---------------------------------------------------------------------------
// Suggestion shape returned to the UI.
// ---------------------------------------------------------------------------
export type TbAccountSuggestion = {
  rowNumber: number;
  accountNumber: string;
  description: string;
  debit: number;
  credit: number;
  prediction: CoaPrediction;
  /** true when the club already has this account (defensive — should
   *  not happen if `ACCOUNT_NOT_FOUND` fired correctly, but the UI
   *  can skip already-present numbers to avoid a UI/DB race). */
  alreadyExists: boolean;
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/**
 * Load every ACCOUNT_NOT_FOUND row on the batch, build a suggestion
 * with the pre-existing predictor. Returns rows sorted by
 * `accountNumber` so the review UI is deterministic.
 */
export async function getUnmatchedTbAccountSuggestions(
  principal: Principal,
  batchId: string,
): Promise<TbAccountSuggestion[]> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: {
      rows: { orderBy: { rowNumber: "asc" } },
      errors: { where: { code: "ACCOUNT_NOT_FOUND" } },
    },
  });
  if (!batch) throw new NotFoundError("ImportBatch", batchId);
  requirePermission(principal, batch.clubId, "settings:write");
  if (batch.domain !== "OPENING_TRIAL_BALANCE") {
    throw new ConflictError("Only Opening Trial Balance batches expose this mapping surface.");
  }

  // Load existing club accounts once — the predictor uses this map
  // to inherit specific mappings for numbers the operator has
  // already classified in prior imports (the "learning" path).
  const existingAccounts = await prisma.account.findMany({
    where: { clubId: batch.clubId, isActive: true },
    select: {
      accountNumber: true,
      type: true,
      category: { select: { key: true } },
      fsGroup: { select: { key: true } },
      defaultDepartment: { select: { code: true } },
    },
  });
  const existingByNumber = new Map<string, ExistingAccountSnapshot>();
  for (const a of existingAccounts) {
    existingByNumber.set(a.accountNumber, {
      accountNumber: a.accountNumber,
      type: a.type,
      categoryKey: a.category?.key ?? null,
      fsGroupKey: a.fsGroup?.key ?? null,
      defaultDepartmentCode: a.defaultDepartment?.code ?? null,
    });
  }
  const existingSet = new Set(existingAccounts.map((a) => a.accountNumber));

  const rowByNumber = new Map<number, (typeof batch.rows)[number]>();
  for (const r of batch.rows) rowByNumber.set(r.rowNumber, r);

  const suggestions: TbAccountSuggestion[] = [];
  for (const err of batch.errors) {
    const row = rowByNumber.get(err.rowNumber);
    if (!row) continue;
    const n = parseJson<Record<string, unknown>>(row.normalizedJson, {});
    const accountNumber = String(n.accountNumber ?? "").trim();
    if (!accountNumber) continue;
    const description = String(n.description ?? "").trim();
    const debit = Number(n.debit ?? 0) || 0;
    const credit = Number(n.credit ?? 0) || 0;
    // Founder rule 2026-07-01 v14.22 — pass the trial-balance
    // sign into the predictor so ambiguous 9xxx catch-all rows
    // (e.g. "Share Transfer Fee" with a credit balance) get
    // promoted from IS_OTHER_EXPENSES to IS_OTHER_REVENUE.
    // Sign is a supporting signal only — it never overrides a
    // keyword or bracket match.
    const prediction = predictCoaRow(
      { number: accountNumber, name: description, debit, credit },
      existingByNumber,
    );
    suggestions.push({
      rowNumber: row.rowNumber,
      accountNumber,
      description,
      debit,
      credit,
      prediction,
      alreadyExists: existingSet.has(accountNumber),
    });
  }
  suggestions.sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
  return suggestions;
}

// ---------------------------------------------------------------------------
// Approval — bulk-create + re-validate.
// ---------------------------------------------------------------------------
export type ApprovedTbAccountRow = {
  accountNumber: string;
  name: string;
  type: string;
  categoryKey: string | null;
  fsGroupKey: string | null;
  defaultDepartmentCode: string | null;
  /**
   * Founder rule 2026-07-02 v15.0 — Fund Applicability CSV. When
   * omitted, the service defaults from FS Group (see
   * `defaultFundApplicabilityStringForAccount`). The form
   * populates this from the predicted default; operators can
   * override it before submitting.
   */
  fundApplicability?: string | null;
};

export type ApproveTbMappingsResult = {
  created: number;
  skippedExisting: number;
  failed: Array<{ accountNumber: string; error: string }>;
  batchStatus: string;
  errorRows: number;
  validRows: number;
};

/**
 * Create every approved account via the SAME `createAccount` the
 * COA maintenance UI uses (v13 validation, uniqueness, audit).
 * Skips numbers that already exist by the time approval runs — the
 * founder's spec: "If an account number already exists by the time
 * approval occurs, skip creation and revalidate." Runs
 * `validateBatch` at the end so the batch's ACCOUNT_NOT_FOUND rows
 * update immediately.
 */
export async function approveTbMappedAccounts(
  principal: Principal,
  batchId: string,
  approved: ReadonlyArray<ApprovedTbAccountRow>,
): Promise<ApproveTbMappingsResult> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new NotFoundError("ImportBatch", batchId);
  requirePermission(principal, batch.clubId, "settings:write");
  if (batch.domain !== "OPENING_TRIAL_BALANCE") {
    throw new ConflictError("Only Opening Trial Balance batches expose this mapping surface.");
  }
  if (batch.status === "COMMITTED") {
    throw new ConflictError("Cannot map accounts on a committed batch.");
  }

  // Deferred to import time to break a would-be circular init between
  // this file and `./index.ts` (which imports many domain services).
  //
  // Founder rule 2026-07-01 v14.21 — permission-path alignment with
  // the COA import commit. The COA import commit path
  // (`commitCoaBatchAsReplacement` in ./index.ts) creates accounts
  // via a raw `tx.account.upsert(...)` and is gated by
  // `settings:write` at the batch-service boundary — that's why
  // Club Admins CAN commit a COA import. This TB mapping workflow
  // is the same class of operation (bulk data-import flow that
  // lands rows into the live COA), so it now goes through
  // `upsertAccountInternal` — the SAME FK-resolution + Zod +
  // audit helper `createAccount` delegates to — WITHOUT the
  // standalone-maintenance `coa:write` gate. The batch-level
  // `settings:write` requirement at the top of this function is
  // the authorization boundary. Manual COA maintenance still
  // requires `coa:write` because `createAccount` is unchanged.
  const { upsertAccountInternal } = await import("../accounting/coa");
  const { validateBatch } = await import("./index");

  const result: ApproveTbMappingsResult = {
    created: 0,
    skippedExisting: 0,
    failed: [],
    batchStatus: batch.status,
    errorRows: batch.errorRows,
    validRows: batch.validRows,
  };

  for (const row of approved) {
    try {
      const existing = await prisma.account.findFirst({
        where: { clubId: batch.clubId, accountNumber: row.accountNumber },
        select: { id: true },
      });
      if (existing) {
        // v14.16 — silently skip: some other operator may have
        // added the same number between suggestion + approval.
        result.skippedExisting++;
        continue;
      }
      // v14.21 — pre-check already skipped existing rows, so
      // upsertAccountInternal always takes the `create` branch
      // here. Same Zod schema + FK lookups + audit trail as the
      // manual COA maintenance UI, minus the standalone
      // `coa:write` gate that this bulk-import workflow doesn't
      // require (batch-service-level `settings:write` is the
      // real gate — identical to how COA import commit works).
      await upsertAccountInternal(
        batch.clubId,
        {
          accountNumber: row.accountNumber,
          name: row.name,
          type: row.type,
          categoryKey: row.categoryKey,
          fsGroupKey: row.fsGroupKey,
          defaultDepartmentCode: row.defaultDepartmentCode,
          // Founder rule 2026-07-02 v15.0 — thread Fund
          // Applicability through. `undefined` triggers the
          // upsert helper's FS-group default; explicit values
          // (from the approval form) are used verbatim.
          fundApplicability: row.fundApplicability ?? undefined,
          parentAccountNumber: null,
          isHeader: false,
          allowManualPosting: true,
          isControlAccount: false,
          isBankAccount: false,
          isCashAccount: false,
          isTaxRelevant: false,
        },
        principal,
      );
      await audit(principal, {
        action: "import.tb.map-account.create",
        entityType: "Account",
        entityId: row.accountNumber, // account id resolved elsewhere; use number as stable ref
        clubId: batch.clubId,
        after: {
          batchId,
          accountNumber: row.accountNumber,
          name: row.name,
          type: row.type,
          fsGroupKey: row.fsGroupKey,
          categoryKey: row.categoryKey,
          defaultDepartmentCode: row.defaultDepartmentCode,
        },
      });
      result.created++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push({ accountNumber: row.accountNumber, error: message });
    }
  }

  // Re-run validate so the ACCOUNT_NOT_FOUND rows update immediately.
  await validateBatch(principal, batchId);
  const refreshed = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { status: true, errorRows: true, validRows: true },
  });
  if (refreshed) {
    result.batchStatus = refreshed.status;
    result.errorRows = refreshed.errorRows;
    result.validRows = refreshed.validRows;
  }
  return result;
}
