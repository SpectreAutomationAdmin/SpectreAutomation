// Phase 13B — Data migration tooling.
//
// Three-phase flow:
//   1. createBatch()   — upload raw rows + a mapping (column → field name).
//                        Status: DRAFT.
//   2. validateBatch() — apply per-domain validators, populate ImportRow.status
//                        and ImportError rows. Status: VALIDATED or FAILED.
//   3. commitBatch()   — persist VALID rows into the real domain tables.
//                        Status: COMMITTED.
//
// Imports are always tenant-scoped (clubId required) and audit logged. A
// commit step never silently creates "bad" financial data — if any required
// validator fails the batch refuses to commit unless explicitly allowed via
// allowPartial=true on the commit call (default false).
//
// Rollback: where the created entity is safe to soft-delete (e.g. members in
// status="PROVISIONAL"), rollbackBatch() flips them to INACTIVE. Financial
// rows are never destroyed; the opening-balance journal owns its own
// rollback (lock prevents accidental edits).

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { isSuperAdmin, requirePermission, type Principal } from "../rbac";
import {
  ConflictError,
  NotFoundError,
  RequiresCoaReplacementConfirmationError,
  ValidationError,
} from "../errors";
import { assertPostingAllowed } from "../posting-guard";
import {
  getCoaMappingOptions,
  normaliseCoaRow,
  resolveCoaRow,
  type CoaMappingOptions,
} from "./coa-mapping";

// Domain registry + per-domain template metadata lives in
// `./templates` so it can be consumed by client components without
// dragging the Prisma / RBAC / audit graph along. Local code in
// this file uses `IMPORT_TEMPLATES` directly; everything else is
// re-exported for back-compat.
import { IMPORT_TEMPLATES, type ImportDomain } from "./templates";

export {
  IMPORT_TEMPLATES,
  IMPORT_TEMPLATE_METADATA,
  type ImportDomain,
  type ImportTemplateMetadata,
  type ImportFieldDoc,
  buildTemplateCsv,
  buildHeaderRowCsv,
  templateFilename,
} from "./templates";

const FINANCIAL_DOMAINS = new Set(["COA", "OPENING_TRIAL_BALANCE", "AR_HISTORY"]);

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function ensureWrite(principal: Principal, clubId: string) {
  if (isSuperAdmin(principal)) return;
  requirePermission(principal, clubId, "settings:write");
}

// ---------------------------------------------------------------------------
// Create batch
// ---------------------------------------------------------------------------
export const createBatchSchema = z.object({
  clubId: z.string(),
  domain: z.enum(["MEMBERS", "VENDORS", "COA", "OPENING_TRIAL_BALANCE", "INVENTORY", "EMPLOYEES", "EVENTS", "AR_HISTORY"]),
  source: z.enum(["JONAS", "CSV", "XLSX", "MANUAL"]).default("CSV"),
  fileName: z.string().max(200).optional(),
  mapping: z.record(z.string(), z.string()).default({}),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1).max(20000),
  options: z.record(z.string(), z.unknown()).optional(),
});

export async function createBatch(principal: Principal, raw: unknown) {
  const parsed = createBatchSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  ensureWrite(principal, parsed.data.clubId);
  const batch = await prisma.$transaction(async (tx) => {
    const b = await tx.importBatch.create({
      data: {
        clubId: parsed.data.clubId, domain: parsed.data.domain, source: parsed.data.source,
        fileName: parsed.data.fileName ?? null,
        mappingJson: JSON.stringify(parsed.data.mapping),
        optionsJson: parsed.data.options ? JSON.stringify(parsed.data.options) : null,
        totalRows: parsed.data.rows.length,
        createdByUserId: principal.id,
      },
    });
    await tx.importRow.createMany({
      data: parsed.data.rows.map((r, i) => ({
        clubId: parsed.data.clubId, batchId: b.id,
        rowNumber: i + 1, rawJson: JSON.stringify(r),
      })),
    });
    return b;
  });
  await audit(principal, { action: "import.batch.create", entityType: "ImportBatch", entityId: batch.id, clubId: parsed.data.clubId, after: { domain: batch.domain, totalRows: batch.totalRows } });
  return batch;
}

// ---------------------------------------------------------------------------
// Per-domain validators. Each returns either { ok: true, normalized } or
// { ok: false, errors: [{ code, message, columnName? }] }.
// ---------------------------------------------------------------------------
type ValidatorResult = { ok: true; normalized: Record<string, unknown> } | { ok: false; errors: Array<{ code: string; message: string; columnName?: string }> };

function applyMapping(raw: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  if (Object.keys(mapping).length === 0) return raw;
  const out: Record<string, unknown> = {};
  for (const [srcCol, destField] of Object.entries(mapping)) {
    if (raw[srcCol] !== undefined) out[destField] = raw[srcCol];
  }
  // Also pass through unmapped columns that already match the target field name.
  for (const [k, v] of Object.entries(raw)) if (out[k] === undefined) out[k] = v;
  return out;
}

function asString(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

function asNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Founder rule 2026-06-30 v14 — Jonas Trial Balance import.
// Excel stores G/L account codes as numbers, so ExcelJS emits
// them as JavaScript `number` values. `String(1000)` gives us
// "1000" — but `String(1000.0)` (if a formula produced a float)
// also gives "1000", and defensive checks strip any accidental
// ".0" suffix to ensure "1000.0" and "1000" compare equal.
export function asAccountCode(v: unknown): string | null {
  if (v == null) return null;
  let s = String(v).trim();
  if (s.length === 0) return null;
  // Strip a trailing ".0" (or ".00" etc.) that Excel formula
  // outputs sometimes produce for integer-valued cells.
  s = s.replace(/\.0+$/, "");
  return s;
}

function asDate(v: unknown): Date | null {
  if (v == null) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

function validateMember(row: Record<string, unknown>): ValidatorResult {
  const memberNumber = asString(row.memberNumber);
  const firstName = asString(row.firstName);
  const lastName = asString(row.lastName);
  const email = asString(row.email);
  if (!memberNumber) return { ok: false, errors: [{ code: "REQUIRED", message: "memberNumber is required", columnName: "memberNumber" }] };
  if (!firstName) return { ok: false, errors: [{ code: "REQUIRED", message: "firstName is required", columnName: "firstName" }] };
  if (!lastName) return { ok: false, errors: [{ code: "REQUIRED", message: "lastName is required", columnName: "lastName" }] };
  if (!email || !email.includes("@")) return { ok: false, errors: [{ code: "INVALID_EMAIL", message: "valid email is required", columnName: "email" }] };
  return {
    ok: true,
    normalized: {
      memberNumber, firstName, lastName, email,
      phone: asString(row.phone),
      membershipCategory: asString(row.membershipCategory),
      joinDate: asDate(row.joinDate),
      status: asString(row.status) ?? "ACTIVE",
    },
  };
}

function validateVendor(row: Record<string, unknown>): ValidatorResult {
  const legalName = asString(row.legalName);
  if (!legalName) return { ok: false, errors: [{ code: "REQUIRED", message: "legalName is required", columnName: "legalName" }] };
  return {
    ok: true,
    normalized: {
      legalName,
      displayName: asString(row.displayName) ?? legalName,
      email: asString(row.email),
      phone: asString(row.phone),
      paymentTermsDays: asNumber(row.paymentTermsDays) ?? 30,
      paymentMethod: asString(row.paymentMethod) ?? "EFT",
      defaultExpenseAccountNumber: asString(row.defaultExpenseAccountNumber),
      defaultTaxCodeKey: asString(row.defaultTaxCodeKey),
    },
  };
}

// Founder rule 2026-06-29 v12 — duplicate-account detection.
// Normalise account names BEFORE comparing so case / whitespace /
// surrounding-quote differences don't mask a real duplicate.
// Returns the lower-case, whitespace-collapsed, quote-stripped key.
export function normaliseAccountName(raw: unknown): string {
  if (raw == null) return "";
  return String(raw)
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export type CoaDuplicateSets = {
  duplicateNumbers: Set<string>;
  duplicatePairs: Set<string>;
  duplicateNames: Set<string>;
};

// Scan ALL rows ONCE and bucket the keys that appear more than
// once. The validateBatch row-loop then decorates each duplicate
// row (first AND last occurrences) instead of the old code that
// only flagged the second-or-later row.
export function detectCoaDuplicates(
  rows: Array<{ number: string | null | undefined; name: string | null | undefined }>,
): CoaDuplicateSets {
  const numberCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  for (const r of rows) {
    const num = String(r.number ?? "").trim();
    const nameKey = normaliseAccountName(r.name);
    if (num) numberCounts.set(num, (numberCounts.get(num) ?? 0) + 1);
    if (nameKey) nameCounts.set(nameKey, (nameCounts.get(nameKey) ?? 0) + 1);
    if (num && nameKey) {
      const pair = `${num}::${nameKey}`;
      pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
    }
  }
  const dupSet = <K>(m: Map<K, number>) =>
    new Set(Array.from(m.entries()).filter(([, c]) => c > 1).map(([k]) => k));
  return {
    duplicateNumbers: dupSet(numberCounts) as Set<string>,
    duplicatePairs: dupSet(pairCounts) as Set<string>,
    duplicateNames: dupSet(nameCounts) as Set<string>,
  };
}

function validateCoa(row: Record<string, unknown>): ValidatorResult {
  // Synchronous gate — only the truly upload-time invariants. The
  // per-club resolution (type enum, category/fs-group/department
  // lookups) happens in `resolveCoaRowAsync` below so the in-page
  // mapping UI is the single place those choices are validated.
  const number = asString(row.number);
  const name = asString(row.name);
  if (!number) return { ok: false, errors: [{ code: "REQUIRED", message: "number is required", columnName: "number" }] };
  if (!name) return { ok: false, errors: [{ code: "REQUIRED", message: "name is required", columnName: "name" }] };
  // Pass through the rest of the row so the async resolver can
  // see whatever the operator typed in the mapping UI (or, for
  // legacy full-format CSVs, what they uploaded).
  return {
    ok: true,
    normalized: {
      number,
      name,
      type: asString(row.type),
      categoryKey: asString(row.categoryKey),
      fsGroupKey: asString(row.fsGroupKey),
      // Always normalise to the array shape downstream.
      departmentCodes: Array.isArray(row.departmentCodes)
        ? row.departmentCodes.map((v) => String(v))
        : row.departmentCode ? [String(row.departmentCode)] : [],
    },
  };
}

function validateOpeningTb(row: Record<string, unknown>): ValidatorResult {
  // Founder rule 2026-06-30 v14 — accept the Jonas TB export
  // exactly as it comes. Column aliasing happens at parse time
  // (csv-parse.ts DOMAIN_HEADER_ALIASES), so by the time we get
  // here the row has canonical keys: accountNumber, description,
  // debit, credit.
  //
  // Founder rule 2026-06-30 v14.2 — Jonas exports credit balances
  // as NEGATIVE numbers (accounting T-account convention). Take
  // the absolute value of both debit and credit BEFORE any
  // downstream logic. Blank / null / dash cells parse to null via
  // asNumber → coalesce to 0. The both-populated rejection uses
  // the absolute values so a `+100` debit paired with a `-100`
  // credit still trips BOTH_DR_CR.
  const accountNumber = asAccountCode(row.accountNumber);
  const description = asString(row.description);
  if (!accountNumber) return { ok: false, errors: [{ code: "REQUIRED", message: "Account number is required.", columnName: "accountNumber" }] };
  if (!description) return { ok: false, errors: [{ code: "REQUIRED", message: "Account description is required.", columnName: "description" }] };
  const debit = Math.abs(asNumber(row.debit) ?? 0);
  const credit = Math.abs(asNumber(row.credit) ?? 0);
  if (debit > 0 && credit > 0) return { ok: false, errors: [{ code: "BOTH_DR_CR", message: "A row cannot carry both a debit AND a credit balance.", columnName: "debit" }] };
  return { ok: true, normalized: { accountNumber, debit, credit, description } };
}

function validateInventory(row: Record<string, unknown>): ValidatorResult {
  const sku = asString(row.sku);
  const name = asString(row.name);
  if (!sku) return { ok: false, errors: [{ code: "REQUIRED", message: "sku is required", columnName: "sku" }] };
  if (!name) return { ok: false, errors: [{ code: "REQUIRED", message: "name is required", columnName: "name" }] };
  return { ok: true, normalized: { sku, name, categoryName: asString(row.categoryName), unit: asString(row.unit) ?? "EA", unitCost: asNumber(row.unitCost) ?? 0, reorderLevel: asNumber(row.reorderLevel) ?? 0 } };
}

const VALIDATORS: Record<ImportDomain, (row: Record<string, unknown>) => ValidatorResult> = {
  MEMBERS: validateMember,
  VENDORS: validateVendor,
  COA: validateCoa,
  OPENING_TRIAL_BALANCE: validateOpeningTb,
  INVENTORY: validateInventory,
  EMPLOYEES: (row) => {
    const employeeNumber = asString(row.employeeNumber);
    if (!employeeNumber) return { ok: false, errors: [{ code: "REQUIRED", message: "employeeNumber is required" }] };
    return { ok: true, normalized: { employeeNumber, firstName: asString(row.firstName), lastName: asString(row.lastName), email: asString(row.email), position: asString(row.position), department: asString(row.department), hireDate: asDate(row.hireDate) } };
  },
  EVENTS: (row) => {
    const name = asString(row.name);
    if (!name) return { ok: false, errors: [{ code: "REQUIRED", message: "name is required" }] };
    return { ok: true, normalized: { name, startsAt: asDate(row.startsAt), endsAt: asDate(row.endsAt), category: asString(row.category), capacity: asNumber(row.capacity) } };
  },
  AR_HISTORY: (row) => {
    const memberNumber = asString(row.memberNumber);
    const amount = asNumber(row.amount);
    if (!memberNumber) return { ok: false, errors: [{ code: "REQUIRED", message: "memberNumber is required" }] };
    if (amount == null) return { ok: false, errors: [{ code: "REQUIRED", message: "amount is required" }] };
    return { ok: true, normalized: { memberNumber, transactionDate: asDate(row.transactionDate) ?? new Date(), category: asString(row.category) ?? "OTHER", description: asString(row.description) ?? "Imported", amount } };
  },
};

// ---------------------------------------------------------------------------
// Validate batch
// ---------------------------------------------------------------------------
export async function validateBatch(principal: Principal, batchId: string) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId }, include: { rows: true } });
  if (!batch) throw new NotFoundError("ImportBatch", batchId);
  ensureWrite(principal, batch.clubId);
  if (batch.status === "COMMITTED") throw new ConflictError("Batch already committed");
  const validator = VALIDATORS[batch.domain as ImportDomain];
  if (!validator) throw new ValidationError([{ path: "domain", message: `Unsupported import domain ${batch.domain}` }]);
  const mapping = parseJson<Record<string, string>>(batch.mappingJson, {});
  // Clear previous errors so repeated validations work cleanly.
  await prisma.importError.deleteMany({ where: { batchId } });

  let valid = 0; let errors = 0;
  const seenKeys = new Set<string>();
  const dupCheckField: Record<string, string> = { MEMBERS: "memberNumber", VENDORS: "legalName", COA: "number", INVENTORY: "sku", EMPLOYEES: "employeeNumber" };
  const dupField = dupCheckField[batch.domain];

  // Lazy-load per-club COA options once per batch (instead of once
  // per row). The resolver runs per row but consults this single
  // bundle so we don't pound the DB.
  let coaOptions: CoaMappingOptions | null = null;
  if (batch.domain === "COA") {
    coaOptions = await getCoaMappingOptions(batch.clubId);
  }

  // Founder rule 2026-06-29 v12 — for COA, scan ALL rows ONCE to
  // bucket duplicate numbers + pairs + names. This replaces the
  // legacy first-occurrence-only logic (which let the first row
  // of a duplicate pass while only flagging the second).
  let coaDups: CoaDuplicateSets | null = null;
  let warnings = 0;
  if (batch.domain === "COA") {
    const pairs = batch.rows.map((r) => {
      const raw = parseJson<Record<string, unknown>>(r.rawJson, {});
      const mapped = applyMapping(raw, mapping);
      return { number: asString(mapped.number), name: asString(mapped.name) };
    });
    coaDups = detectCoaDuplicates(pairs);
  }

  // Founder rule 2026-06-30 v14 — Trial Balance pre-scan.
  // Fetch the club's active COA once so per-row existence
  // checks are a Set lookup, then walk every row to sum
  // debits + credits so the balance reconciliation error can
  // be emitted at batch-close time (below).
  let tbAccountNumbers: Set<string> | null = null;
  let tbTotalDebit = 0;
  let tbTotalCredit = 0;
  if (batch.domain === "OPENING_TRIAL_BALANCE") {
    const clubAccounts = await prisma.account.findMany({
      where: { clubId: batch.clubId, isActive: true },
      select: { accountNumber: true },
    });
    tbAccountNumbers = new Set(clubAccounts.map((a) => a.accountNumber));
  }

  for (const row of batch.rows) {
    const raw = parseJson<Record<string, unknown>>(row.rawJson, {});
    const mapped = applyMapping(raw, mapping);
    const result = validator(mapped);
    if (result.ok) {
      // Founder rule 2026-06-29 v12 — COA duplicate detection.
      // Number-duplicate and pair-duplicate are HARD errors that
      // mark the row INVALID. Name-only-duplicate is a WARNING
      // (row stays VALID; surfaced in the UI for review).
      if (batch.domain === "COA" && coaDups) {
        const n = result.normalized as Record<string, unknown>;
        const num = String(n.number ?? "").trim();
        const nameKey = normaliseAccountName(n.name);
        const pair = num && nameKey ? `${num}::${nameKey}` : "";
        const hasNumDup = num && coaDups.duplicateNumbers.has(num);
        const hasPairDup = pair && coaDups.duplicatePairs.has(pair);
        if (hasPairDup) {
          await prisma.importError.create({
            data: {
              clubId: batch.clubId, batchId, rowNumber: row.rowNumber,
              code: "DUPLICATE_ACCOUNT", severity: "ERROR",
              message: `Account ${num} · ${String(n.name ?? "")} appears more than once.`,
              columnName: "number",
            },
          });
          await prisma.importRow.update({
            where: { id: row.id },
            data: { status: "INVALID", errorMessage: `duplicate account ${num} · ${String(n.name ?? "")}`, normalizedJson: JSON.stringify(n) },
          });
          errors++; continue;
        }
        if (hasNumDup) {
          await prisma.importError.create({
            data: {
              clubId: batch.clubId, batchId, rowNumber: row.rowNumber,
              code: "DUPLICATE_ACCOUNT_NUMBER", severity: "ERROR",
              message: `Account number ${num} appears more than once. Account numbers must be unique.`,
              columnName: "number",
            },
          });
          await prisma.importRow.update({
            where: { id: row.id },
            data: { status: "INVALID", errorMessage: `duplicate account number ${num}`, normalizedJson: JSON.stringify(n) },
          });
          errors++; continue;
        }
        if (nameKey && coaDups.duplicateNames.has(nameKey)) {
          // Warning-only: row passes validation but flags the name
          // collision for the operator to confirm.
          await prisma.importError.create({
            data: {
              clubId: batch.clubId, batchId, rowNumber: row.rowNumber,
              code: "DUPLICATE_ACCOUNT_NAME", severity: "WARNING",
              message: `Account name '${String(n.name ?? "")}' appears more than once. Confirm these are intentionally separate accounts.`,
              columnName: "name",
            },
          });
          warnings++;
          // Fall through — row is still VALID for non-COA-pair purposes.
        }
      }
      // Duplicate detection within the batch (NON-COA domains).
      if (dupField && batch.domain !== "COA") {
        const key = String((result.normalized as Record<string, unknown>)[dupField] ?? "");
        if (seenKeys.has(key)) {
          await prisma.importError.create({ data: { clubId: batch.clubId, batchId, rowNumber: row.rowNumber, code: "DUPLICATE", message: `Duplicate ${dupField} '${key}' within this batch`, columnName: dupField } });
          await prisma.importRow.update({ where: { id: row.id }, data: { status: "INVALID", errorMessage: "duplicate within batch", normalizedJson: JSON.stringify(result.normalized) } });
          errors++; continue;
        }
        seenKeys.add(key);
      }
      // COA — second-pass async resolution against per-club options
      // (type enum, category/fs-group/department lookups). Failed
      // resolutions become per-field ImportError rows + bump the
      // row to INVALID.
      if (batch.domain === "COA" && coaOptions) {
        const coaRow = normaliseCoaRow(result.normalized as Record<string, unknown>);
        const resolution = resolveCoaRow(coaRow, coaOptions);
        if (!resolution.ok) {
          for (const e of resolution.errors) {
            await prisma.importError.create({
              data: {
                clubId: batch.clubId, batchId, rowNumber: row.rowNumber,
                code: e.code, message: e.message, columnName: e.columnName ?? null,
              },
            });
          }
          await prisma.importRow.update({
            where: { id: row.id },
            data: {
              status: "INVALID",
              errorMessage: resolution.errors.map((e) => e.message).join("; "),
              normalizedJson: JSON.stringify(result.normalized),
            },
          });
          errors++;
          continue;
        }
        await prisma.importRow.update({
          where: { id: row.id },
          data: {
            status: "VALID",
            // Store the FULLY-RESOLVED bundle (with FK ids) so the
            // commit step doesn't have to re-query the lookups.
            normalizedJson: JSON.stringify(resolution.resolved),
            errorMessage: null,
          },
        });
        valid++;
        continue;
      }
      // Founder rule 2026-06-30 v14 — Trial Balance per-row COA
      // existence check. Emit ACCOUNT_NOT_FOUND against the club's
      // active COA and mark the row INVALID. If the row passes,
      // tally its debit + credit into the batch-level running
      // totals so the balance reconciliation (post-loop) has real
      // numbers to compare.
      if (batch.domain === "OPENING_TRIAL_BALANCE" && tbAccountNumbers) {
        const n = result.normalized as { accountNumber: string; description: string | null; debit: number; credit: number };
        if (!tbAccountNumbers.has(n.accountNumber)) {
          await prisma.importError.create({
            data: {
              clubId: batch.clubId, batchId, rowNumber: row.rowNumber,
              code: "ACCOUNT_NOT_FOUND", severity: "ERROR",
              message: `Account ${n.accountNumber} '${n.description ?? ""}' (Debit ${n.debit.toFixed(2)}, Credit ${n.credit.toFixed(2)}) — Account number not found in Chart of Accounts.`,
              columnName: "accountNumber",
            },
          });
          await prisma.importRow.update({
            where: { id: row.id },
            data: { status: "INVALID", errorMessage: `Account ${n.accountNumber} not in Chart of Accounts`, normalizedJson: JSON.stringify(n) },
          });
          errors++;
          continue;
        }
        tbTotalDebit += n.debit;
        tbTotalCredit += n.credit;
      }
      await prisma.importRow.update({
        where: { id: row.id },
        data: { status: "VALID", normalizedJson: JSON.stringify(result.normalized), errorMessage: null },
      });
      valid++;
    } else {
      for (const e of result.errors) {
        await prisma.importError.create({
          data: { clubId: batch.clubId, batchId, rowNumber: row.rowNumber, code: e.code, message: e.message, columnName: e.columnName ?? null },
        });
      }
      await prisma.importRow.update({
        where: { id: row.id },
        data: { status: "INVALID", errorMessage: result.errors.map((e) => e.message).join("; ") },
      });
      errors++;
    }
  }
  // Founder rule 2026-06-30 v14 — Trial Balance batch
  // reconciliation. Debits must equal credits (within a $0.005
  // rounding tolerance) — the Jonas export sometimes carries
  // half-cent residuals from currency conversion. If unbalanced,
  // emit a single batch-level error at rowNumber 0 so the UI can
  // surface it prominently.
  if (batch.domain === "OPENING_TRIAL_BALANCE" && tbAccountNumbers) {
    const variance = tbTotalDebit - tbTotalCredit;
    if (Math.abs(variance) > 0.005) {
      await prisma.importError.create({
        data: {
          clubId: batch.clubId, batchId, rowNumber: 0,
          code: "TB_OUT_OF_BALANCE", severity: "ERROR",
          message: `Trial balance is out of balance. Total debits ${tbTotalDebit.toFixed(2)}, total credits ${tbTotalCredit.toFixed(2)}, variance ${variance.toFixed(2)}.`,
          columnName: null,
        },
      });
      errors++;
    }
  }

  const updated = await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      status: errors === 0 ? "VALIDATED" : "VALIDATED", // we keep VALIDATED even with errors so caller can decide
      validRows: valid, errorRows: errors,
      dryRunAt: new Date(),
    },
  });
  await audit(principal, {
    action: "import.batch.validate",
    entityType: "ImportBatch",
    entityId: batch.id,
    clubId: batch.clubId,
    after: {
      valid, errors, warnings,
      // v14 — expose the TB totals in the audit payload for the
      // preview UI + operator reports.
      ...(batch.domain === "OPENING_TRIAL_BALANCE"
        ? { totalDebit: tbTotalDebit, totalCredit: tbTotalCredit, variance: tbTotalDebit - tbTotalCredit }
        : {}),
    },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Commit batch — actually create the domain records.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// COA replacement planning
// ---------------------------------------------------------------------------
// The founder's 2026-07-07 rule: importing a Chart of Accounts
// REPLACES the club's existing active COA — it does not append.
// Before committing, the caller needs to know whether a confirm-
// to-replace step is required, and how big the change is so the
// modal can show meaningful counts. This helper is pure read; it
// does not mutate state.
export type CoaReplacementPlan = {
  /** Active (isActive=true) accounts the club has today. */
  existingActiveCount: number;
  /** Active accounts whose accountNumber appears in the import. */
  matchingImportCount: number;
  /** Active accounts NOT in the import — these will be soft-deactivated. */
  deactivateCount: number;
  /** Distinct account numbers in the import's VALID rows. */
  importedRowCount: number;
  /** True when there is at least one existing active account, i.e.
   *  the commit needs an explicit replace-confirmation step. */
  requiresConfirmation: boolean;
};

export async function planCoaReplacement(
  principal: Principal,
  batchId: string,
): Promise<CoaReplacementPlan> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { id: true, clubId: true, domain: true },
  });
  if (!batch) throw new NotFoundError("ImportBatch", batchId);
  ensureWrite(principal, batch.clubId);
  if (batch.domain !== "COA") {
    throw new ValidationError([
      { path: "domain", message: "planCoaReplacement is only valid for COA batches" },
    ]);
  }
  const validRows = await prisma.importRow.findMany({
    where: { batchId: batch.id, status: "VALID" },
    select: { normalizedJson: true },
  });
  const importNumbers = new Set<string>();
  for (const r of validRows) {
    const n = parseJson<Record<string, unknown>>(r.normalizedJson, {});
    const number = n.number ? String(n.number).trim() : "";
    if (number.length > 0) importNumbers.add(number);
  }
  const existingActive = await prisma.account.findMany({
    where: { clubId: batch.clubId, isActive: true },
    select: { accountNumber: true },
  });
  let matchingImportCount = 0;
  let deactivateCount = 0;
  for (const acct of existingActive) {
    if (importNumbers.has(acct.accountNumber)) matchingImportCount++;
    else deactivateCount++;
  }
  return {
    existingActiveCount: existingActive.length,
    matchingImportCount,
    deactivateCount,
    importedRowCount: importNumbers.size,
    requiresConfirmation: existingActive.length > 0,
  };
}

// Founder rule 2026-06-30 v14.3 — persist a manually-entered
// Trial Balance as-of date on the batch's optionsJson. Only
// valid for OPENING_TRIAL_BALANCE batches in DRAFT / VALIDATED
// state (never after commit).
export async function setTrialBalanceAsOfDate(
  principal: Principal,
  batchId: string,
  asOfDate: Date,
): Promise<Awaited<ReturnType<typeof prisma.importBatch.update>>> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new NotFoundError("ImportBatch", batchId);
  ensureWrite(principal, batch.clubId);
  if (batch.domain !== "OPENING_TRIAL_BALANCE") {
    throw new ConflictError("Trial balance as-of date only applies to Opening Trial Balance batches.");
  }
  if (batch.status === "COMMITTED") {
    throw new ConflictError("Batch already committed; cannot change the as-of date.");
  }
  const options = parseJson<Record<string, unknown>>(batch.optionsJson, {});
  options.asOfDate = asOfDate.toISOString();
  const updated = await prisma.importBatch.update({
    where: { id: batchId },
    data: { optionsJson: JSON.stringify(options) },
  });
  await audit(principal, {
    action: "import.batch.set-asof",
    entityType: "ImportBatch",
    entityId: batchId,
    clubId: batch.clubId,
    after: { asOfDate: asOfDate.toISOString() },
  });
  return updated;
}

// Founder rule 2026-06-30 v14.3 — read the persisted TB as-of date
// off a batch. Returns null when unset. Small helper reused by the
// preview page + the commit path.
export function readTrialBalanceAsOfDate(optionsJson: string | null): Date | null {
  if (!optionsJson) return null;
  const opts = parseJson<Record<string, unknown>>(optionsJson, {});
  const raw = opts.asOfDate;
  if (typeof raw !== "string" || raw.length === 0) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

// Founder rule 2026-06-30 v14.5 — reverse the ledger impact of a
// prior Trial Balance batch. Creates a contra JournalEntry with
// every line's debit + credit swapped so the net effect on
// balances is zero. Runs inside the caller's transaction so the
// reversal + batch state update are atomic.
async function reverseTbJournalInTransaction(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  batchId: string,
  postedByUserId: string,
  reverseDate: Date,
): Promise<{ contraEntryId: string; reversedLines: number } | null> {
  const orig = await tx.journalEntry.findFirst({
    where: { sourceEntityType: "ImportBatch", sourceEntityId: batchId, status: "POSTED" },
    include: { lines: true },
  });
  if (!orig) return null;
  const contra = await tx.journalEntry.create({
    data: {
      clubId: orig.clubId,
      entryNumber: `${orig.entryNumber}-R`,
      entryDate: reverseDate,
      periodId: orig.periodId,
      description: `Reversal of ${orig.entryNumber} — superseded / voided Trial Balance`,
      source: "IMPORT",
      sourceEntityType: "ImportBatch",
      sourceEntityId: batchId,
      status: "POSTED",
      postedAt: new Date(),
      postedByUserId,
      totalDebits: orig.totalCredits,
      totalCredits: orig.totalDebits,
      createdByUserId: postedByUserId,
      reversesId: orig.id,
    },
  });
  // Swap debit / credit on every line so the ledger net-out is
  // exactly zero.
  await tx.journalEntryLine.createMany({
    data: orig.lines.map((l, i) => ({
      clubId: orig.clubId,
      journalEntryId: contra.id,
      lineNumber: i + 1,
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
    })),
  });
  return { contraEntryId: contra.id, reversedLines: orig.lines.length };
}

// Founder rule 2026-06-30 v14.5 — manually void a committed TB
// batch. Reverses the ledger + marks the batch VOIDED with the
// operator's reason. Distinct from the auto-supersede path — a
// voided batch is explicitly "undone" and gets a `voidedAt`
// stamp, while a superseded batch is "replaced" by a newer one.
// If the batch is already superseded, we still support void as
// a clean-up affordance (the ledger was already reversed at
// supersede time so the reverse call is idempotent + returns
// null; the batch simply flips to VOIDED for record).
export async function voidCommittedBatch(
  principal: Principal,
  batchId: string,
  reason: string,
): Promise<Awaited<ReturnType<typeof prisma.importBatch.update>>> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new NotFoundError("ImportBatch", batchId);
  ensureWrite(principal, batch.clubId);
  if (batch.domain !== "OPENING_TRIAL_BALANCE") {
    throw new ConflictError("Void is only supported for Opening Trial Balance batches.");
  }
  if (batch.status !== "COMMITTED" && batch.status !== "SUPERSEDED") {
    throw new ConflictError(`Cannot void a batch in status ${batch.status}. Only COMMITTED or SUPERSEDED batches can be voided.`);
  }
  if (batch.voidedAt) {
    throw new ConflictError("Batch already voided.");
  }
  const trimmedReason = String(reason ?? "").trim();
  if (!trimmedReason) {
    throw new ConflictError("Void reason is required.");
  }
  await assertPostingAllowed(principal, batch.clubId, "import.batch.void", "ImportBatch", batch.id);

  // Reverse (if the batch was live and still has an un-reversed
  // JE) + flip status. Atomic.
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    // Only reverse when the batch is STILL live — superseded
    // batches were already reversed when they were superseded.
    if (batch.status === "COMMITTED" && batch.supersededAt == null) {
      const asOfDate = readTrialBalanceAsOfDate(batch.optionsJson) ?? batch.committedAt ?? now;
      await reverseTbJournalInTransaction(tx, batch.id, principal.id, asOfDate);
    }
    return tx.importBatch.update({
      where: { id: batch.id },
      data: {
        status: "VOIDED",
        voidedAt: now,
        voidedByUserId: principal.id,
        voidReason: trimmedReason,
      },
    });
  });
  await audit(principal, {
    action: "import.batch.void",
    entityType: "ImportBatch",
    entityId: batch.id,
    clubId: batch.clubId,
    before: { status: batch.status, supersededAt: batch.supersededAt },
    after: { status: "VOIDED", voidedAt: now.toISOString(), reason: trimmedReason },
  });
  return updated;
}

export async function commitBatch(
  principal: Principal,
  args: { batchId: string; allowPartial?: boolean; confirmReplaceCoa?: boolean },
) {
  const batch = await prisma.importBatch.findUnique({ where: { id: args.batchId }, include: { rows: { where: { status: "VALID" } } } });
  if (!batch) throw new NotFoundError("ImportBatch", args.batchId);
  ensureWrite(principal, batch.clubId);
  // Financial-domain commits flow through the posting guard so training mode
  // and read-only support sessions cannot push real journals / members.
  if (FINANCIAL_DOMAINS.has(batch.domain)) {
    await assertPostingAllowed(principal, batch.clubId, `import.commit.${batch.domain.toLowerCase()}`, "ImportBatch", batch.id);
  }
  if (batch.status === "COMMITTED") throw new ConflictError("Batch already committed");
  if (!batch.dryRunAt) throw new ConflictError("Dry-run required before commit. Call validateBatch first.");
  // Founder rule 2026-07-20: COA imports NEVER support a
  // partial commit. They replace the active Chart of Accounts,
  // and a partial-invalid commit creates reporting risk. The
  // server rejects unconditionally — the `allowPartial` flag
  // is ignored for COA. Other domains keep the legacy escape
  // hatch (additive imports can tolerate a row-skip).
  if (batch.domain === "COA" && batch.errorRows > 0) {
    throw new ConflictError(
      `Batch has ${batch.errorRows} error rows; fix every flagged row and re-validate before completing the import.`,
    );
  }
  if (batch.domain !== "COA" && batch.errorRows > 0 && !args.allowPartial) {
    throw new ConflictError(`Batch has ${batch.errorRows} error rows; pass allowPartial=true to commit anyway`);
  }

  // ── COA branch: transactional REPLACE ─────────────────────────────────
  //
  // Founder rule 2026-07-07: a club has exactly one active Chart
  // of Accounts. A COA commit must
  //   1. require explicit caller confirmation when an existing COA
  //      is present (the UI shows the founder's confirmation modal),
  //   2. wrap the entire upsert + deactivate-stale pass in a single
  //      DB transaction so a row-level failure leaves the live COA
  //      untouched, AND
  //   3. soft-deactivate (never delete) stale accounts so historical
  //      JournalEntryLine references stay intact.
  if (batch.domain === "COA") {
    const plan = await planCoaReplacement(principal, batch.id);
    if (plan.requiresConfirmation && !args.confirmReplaceCoa) {
      throw new RequiresCoaReplacementConfirmationError({
        existingActiveCount: plan.existingActiveCount,
        matchingImportCount: plan.matchingImportCount,
        deactivateCount: plan.deactivateCount,
        importedRowCount: plan.importedRowCount,
      });
    }
    const replaceResult = await commitCoaBatchAsReplacement(principal, batch, plan);
    await audit(principal, {
      action: "import.batch.commit",
      entityType: "ImportBatch",
      entityId: batch.id,
      clubId: batch.clubId,
      after: { committed: replaceResult.committed, domain: batch.domain },
    });
    // Founder-spec replacement-specific audit entry — gives a
    // first-class record of the destructive intent in addition to
    // the generic commit log entry above.
    if (plan.requiresConfirmation) {
      await audit(principal, {
        action: "import.coa.replace",
        entityType: "ImportBatch",
        entityId: batch.id,
        clubId: batch.clubId,
        after: {
          existingActiveCount: plan.existingActiveCount,
          matchingImportCount: plan.matchingImportCount,
          deactivateCount: replaceResult.deactivated,
          importedRowCount: plan.importedRowCount,
          committed: replaceResult.committed,
          archivedPriorBatches: replaceResult.archivedPriorBatches,
        },
      });
    }
    return replaceResult.batch;
  }

  // ── Opening Trial Balance branch — v14.3 ─────────────────────────────
  // Build a single POSTED journal entry dated on the batch's
  // as-of date, with one line per row (debit or credit). The
  // existing trialBalance() report reads JournalEntryLine so
  // once this posts, Finance → Trial Balance as of the same
  // date renders every imported balance.
  //
  // Founder rule 2026-06-30 v14.5 — supersedence. If a prior
  // TB batch is LIVE (COMMITTED + not superseded + not voided),
  // this commit takes over as the live batch: the prior batch
  // is marked SUPERSEDED, its ledger impact reversed via a
  // contra journal entry, and the new commit becomes the
  // authoritative Trial Balance for the club. This guarantees
  // only ONE live TB batch exists per club.
  if (batch.domain === "OPENING_TRIAL_BALANCE") {
    const asOfDate = readTrialBalanceAsOfDate(batch.optionsJson);
    if (!asOfDate) {
      throw new ConflictError(
        "Trial Balance as-of date is not set. Detect it from the source file or enter it manually on the preview page before completing the import.",
      );
    }
    const period = await prisma.fiscalPeriod.findFirst({
      where: {
        fiscalYear: { clubId: batch.clubId },
        startDate: { lte: asOfDate },
        endDate: { gte: asOfDate },
      },
    });
    if (!period) {
      throw new ConflictError(
        `No fiscal period covers ${asOfDate.toISOString().slice(0, 10)}. Add the fiscal year first, then re-commit.`,
      );
    }
    // Resolve every account number → id in one query so posting
    // stays a single transaction.
    const acctNumbers = Array.from(new Set(
      batch.rows.map((r) => {
        const n = parseJson<Record<string, unknown>>(r.normalizedJson, {});
        return String(n.accountNumber ?? "").trim();
      }).filter(Boolean),
    ));
    // Founder rule 2026-07-01 v14.10 — pull each account's
    // `defaultDepartmentId` alongside the id lookup so the
    // journal lines can carry the COA's dept mapping through to
    // the ledger. Income by Department reads line.departmentId
    // first, then falls back to account.defaultDepartmentId —
    // but populating it here means new imports don't rely on the
    // fallback for correctness.
    const clubAccounts = await prisma.account.findMany({
      where: { clubId: batch.clubId, accountNumber: { in: acctNumbers } },
      select: { id: true, accountNumber: true, defaultDepartmentId: true },
    });
    const idByNumber = new Map(clubAccounts.map((a) => [a.accountNumber, a.id]));
    const deptByNumber = new Map(clubAccounts.map((a) => [a.accountNumber, a.defaultDepartmentId]));

    // Assemble journal lines. Every row was already validated in
    // validateBatch (accounts exist, amounts absolute-valued,
    // batch reconciles). Absolute values come off normalizedJson.
    type LineDraft = { rowId: string; accountId: string; departmentId: string | null; debit: number; credit: number };
    const lines: LineDraft[] = [];
    let totalDebit = 0;
    let totalCredit = 0;
    for (const row of batch.rows) {
      const n = parseJson<Record<string, unknown>>(row.normalizedJson, {});
      const num = String(n.accountNumber ?? "").trim();
      const accountId = idByNumber.get(num);
      if (!accountId) {
        // Defensive: validateBatch already flagged this. Skip.
        continue;
      }
      const debit = Number(n.debit ?? 0) || 0;
      const credit = Number(n.credit ?? 0) || 0;
      // Drop zero-value rows — they'd be balance-neutral clutter
      // in the ledger and every serious accounting engine skips
      // them.
      if (debit === 0 && credit === 0) continue;
      lines.push({
        rowId: row.id,
        accountId,
        departmentId: deptByNumber.get(num) ?? null,
        debit,
        credit,
      });
      totalDebit += debit;
      totalCredit += credit;
    }
    if (lines.length === 0) {
      throw new ConflictError("No importable rows — every VALID row was zero-value.");
    }

    const entryNumber = `TB-${asOfDate.toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    // Founder rule 2026-06-30 v14.5 — find the prior LIVE TB batch
    // (if any) and prepare to supersede it in the same transaction.
    // "Live" = COMMITTED + not superseded + not voided.
    const priorLive = await prisma.importBatch.findFirst({
      where: {
        clubId: batch.clubId,
        domain: "OPENING_TRIAL_BALANCE",
        status: "COMMITTED",
        supersededAt: null,
        voidedAt: null,
        NOT: { id: batch.id },
      },
      orderBy: { committedAt: "desc" },
    });

    const tbCommit = await prisma.$transaction(async (tx) => {
      const entry = await tx.journalEntry.create({
        data: {
          clubId: batch.clubId,
          entryNumber,
          entryDate: asOfDate,
          periodId: period.id,
          description: `Opening Trial Balance — ${asOfDate.toISOString().slice(0, 10)}`,
          source: "IMPORT",
          sourceEntityType: "ImportBatch",
          sourceEntityId: batch.id,
          status: "POSTED",
          postedAt: new Date(),
          postedByUserId: principal.id,
          totalDebits: totalDebit,
          totalCredits: totalCredit,
          createdByUserId: principal.id,
        },
      });
      await tx.journalEntryLine.createMany({
        data: lines.map((l, i) => ({
          clubId: batch.clubId,
          journalEntryId: entry.id,
          lineNumber: i + 1,
          accountId: l.accountId,
          // v14.10 — carry the account's defaultDepartmentId onto
          // the journal line so Income by Department groups the
          // TB rows under the COA's departments (no fallback needed).
          departmentId: l.departmentId,
          debit: l.debit,
          credit: l.credit,
        })),
      });
      // Mark every row IMPORTED + link to the created entry.
      for (const l of lines) {
        await tx.importRow.update({
          where: { id: l.rowId },
          data: { status: "IMPORTED", createdEntityType: "JournalEntry", createdEntityId: entry.id },
        });
      }

      // v14.5 — supersede prior live TB batch inside the same
      // transaction. Reversal creates a contra JournalEntry so
      // the trialBalance() report only reflects the new commit.
      if (priorLive) {
        await reverseTbJournalInTransaction(tx, priorLive.id, principal.id, asOfDate);
        await tx.importBatch.update({
          where: { id: priorLive.id },
          data: {
            status: "SUPERSEDED",
            supersededAt: new Date(),
            supersededByBatchId: batch.id,
          },
        });
      }
      return entry;
    }, {
      // Sprint 3 · Checkpoint 15I-5 — same rationale as the COA
      // commit transaction below (~ N ImportRow updates in a
      // loop plus one JE + N JEL createMany). Prior-live reversal
      // adds another round-trip per pre-existing line. A 200-line
      // TB comfortably exceeds Prisma's 5s default; raise the
      // window in lockstep with the COA path.
      timeout: 120_000,
      maxWait: 30_000,
    });
    const updated = await prisma.importBatch.update({
      where: { id: batch.id },
      data: {
        status: "COMMITTED",
        committedRows: lines.length,
        committedAt: new Date(),
        committedByUserId: principal.id,
      },
    });
    await audit(principal, {
      action: "import.batch.commit",
      entityType: "ImportBatch",
      entityId: batch.id,
      clubId: batch.clubId,
      after: {
        committed: lines.length, domain: batch.domain,
        journalEntryId: tbCommit.id, asOfDate: asOfDate.toISOString(),
        totalDebit, totalCredit,
      },
    });
    return updated;
  }

  // ── Other domains: existing best-effort per-row commit ────────────────
  let committed = 0;
  for (const row of batch.rows) {
    const normalized = parseJson<Record<string, unknown>>(row.normalizedJson, {});
    try {
      const created = await commitDomainRow(batch.clubId, batch.domain as ImportDomain, normalized);
      await prisma.importRow.update({
        where: { id: row.id },
        data: { status: "IMPORTED", createdEntityType: created?.entityType ?? null, createdEntityId: created?.entityId ?? null },
      });
      committed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.importRow.update({ where: { id: row.id }, data: { status: "INVALID", errorMessage: `Commit failed: ${msg}` } });
      await prisma.importError.create({
        data: { clubId: batch.clubId, batchId: batch.id, rowNumber: row.rowNumber, code: "COMMIT_FAILED", message: msg.slice(0, 500) },
      });
    }
  }
  const updated = await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      status: "COMMITTED",
      committedRows: committed,
      committedAt: new Date(),
      committedByUserId: principal.id,
    },
  });
  await audit(principal, { action: "import.batch.commit", entityType: "ImportBatch", entityId: batch.id, clubId: batch.clubId, after: { committed, domain: batch.domain } });
  return updated;
}

/**
 * Atomic COA replacement.
 *
 * Wraps every write in `prisma.$transaction` so the live Chart of
 * Accounts is never left in a half-replaced state. The transaction:
 *
 *   1. UPSERTs every VALID row in the batch into Account, keyed
 *      by (clubId, accountNumber). Matched accounts are reactivated
 *      (isActive=true, archivedAt=null). Unmatched accounts are
 *      created fresh.
 *   2. Reconciles AccountDepartment per account (wipe + re-insert
 *      the operator's mapping selection).
 *   3. Soft-deactivates every existing active account whose number
 *      is NOT in the import (isActive=false, archivedAt=now). Hard
 *      delete is never used — JournalEntryLine.accountId references
 *      must stay valid so historical ledger snapshots keep
 *      reconciling.
 *   4. Marks each committed ImportRow as IMPORTED.
 *   5. Stamps the ImportBatch as COMMITTED.
 *
 * Any throw inside the transaction aborts the whole replacement —
 * Postgres / SQLite roll back to the pre-commit state and the
 * caller sees a clean error. The previous active COA survives
 * intact.
 */
async function commitCoaBatchAsReplacement(
  principal: Principal,
  batch: Awaited<ReturnType<typeof prisma.importBatch.findUnique>> & {
    rows: Array<{ id: string; normalizedJson: string | null; rowNumber: number }>;
  },
  plan: CoaReplacementPlan,
): Promise<{
  batch: Awaited<ReturnType<typeof prisma.importBatch.update>>;
  committed: number;
  deactivated: number;
  archivedPriorBatches: number;
}> {
  if (!batch) throw new NotFoundError("ImportBatch");
  // Sprint 3 · Checkpoint 15I-5 — explicit transaction timeout.
  // Prisma's default $transaction timeout is 5 seconds. A COA
  // commit does 3-4 DB round-trips per row (upsert account +
  // deleteMany accountDepartments + optional createMany +
  // importRow.update), so a full 237-account chart runs ~700-900
  // round-trips. On a hosted Postgres (Neon) that comfortably
  // exceeds 5s and Prisma throws P2028 — "Transaction not found"
  // — the moment the deadline passes, which reaches Next.js as a
  // generic server-side exception. The failed batch on staging
  // (2026-07-26T21:02:07 UTC, digest 3147618077) hit exactly this
  // limit. Postgres rolls back cleanly so no partial data exists,
  // but the founder sees an unhelpful error and the batch can't
  // commit.
  //
  // Timeout raised to 120s (well beyond any real COA volume — a
  // 1000-account chart still fits inside 30s). maxWait 30s gives
  // enough headroom for connection-pool acquisition on cold
  // starts. Bulk COA imports are infrequent, non-user-blocking
  // (async server action), and safely serialised — the wider
  // window carries no downside.
  return prisma.$transaction(async (tx) => {
    let committed = 0;
    const seenNumbers = new Set<string>();
    for (const row of batch.rows) {
      const normalized = parseJson<Record<string, unknown>>(row.normalizedJson, {});
      const number = String(normalized.number ?? "").trim();
      if (number.length === 0) {
        throw new ConflictError(
          `COA row ${row.rowNumber} has no account number; cannot commit replacement.`,
        );
      }
      seenNumbers.add(number);
      const type = String(normalized.type).toUpperCase();
      const normalBalance = (type === "ASSET" || type === "EXPENSE") ? "DEBIT" : "CREDIT";
      const categoryId = normalized.categoryId ? String(normalized.categoryId) : null;
      const fsGroupId = normalized.fsGroupId ? String(normalized.fsGroupId) : null;
      const departmentIds = Array.isArray(normalized.departmentIds)
        ? normalized.departmentIds.map((v) => String(v)).filter((v) => v.length > 0)
        : [];
      const primaryDepartmentId = departmentIds[0] ?? null;

      const account = await tx.account.upsert({
        where: { clubId_accountNumber: { clubId: batch.clubId, accountNumber: number } },
        update: {
          name: String(normalized.name),
          type,
          normalBalance,
          categoryId,
          fsGroupId,
          defaultDepartmentId: primaryDepartmentId,
          isActive: true,
          archivedAt: null,
        },
        create: {
          clubId: batch.clubId,
          accountNumber: number,
          name: String(normalized.name),
          type,
          normalBalance,
          categoryId,
          fsGroupId,
          defaultDepartmentId: primaryDepartmentId,
          isActive: true,
        },
      });

      // Reconcile per-account departments.
      await tx.accountDepartment.deleteMany({
        where: { accountId: account.id, clubId: batch.clubId },
      });
      if (departmentIds.length > 0) {
        await tx.accountDepartment.createMany({
          data: departmentIds.map((departmentId) => ({
            clubId: batch.clubId,
            accountId: account.id,
            departmentId,
          })),
        });
      }

      await tx.importRow.update({
        where: { id: row.id },
        data: {
          status: "IMPORTED",
          createdEntityType: "Account",
          createdEntityId: account.id,
        },
      });
      committed++;
    }

    // Soft-deactivate any account that the import did NOT touch.
    // We never hard delete: ledger lines, prior reporting snapshots,
    // AP / inventory references, and tax / collection wiring all
    // point at Account.id and must continue resolving.
    const stale = await tx.account.findMany({
      where: {
        clubId: batch.clubId,
        isActive: true,
        accountNumber: { notIn: Array.from(seenNumbers) },
      },
      select: { id: true },
    });
    let deactivated = 0;
    if (stale.length > 0) {
      const archivedAt = new Date();
      const result = await tx.account.updateMany({
        where: { id: { in: stale.map((a) => a.id) }, clubId: batch.clubId },
        data: { isActive: false, archivedAt },
      });
      deactivated = result.count;
    }

    // Founder rule 2026-07-12: a COA commit replaces the active
    // chart, so any PRIOR committed COA batch for this club is
    // no longer the active source of truth. Flip them to
    // ARCHIVED inside the same transaction so the Data Imports
    // list stops presenting them as live committed history.
    // Only flips other COMMITTED COA batches — never touches the
    // batch we're about to commit, never touches other domains
    // (Members, Vendors, Opening TB, etc.).
    const archived = await tx.importBatch.updateMany({
      where: {
        clubId: batch.clubId,
        domain: "COA",
        status: "COMMITTED",
        id: { not: batch.id },
      },
      data: { status: "ARCHIVED" },
    });

    const updated = await tx.importBatch.update({
      where: { id: batch.id },
      data: {
        status: "COMMITTED",
        committedRows: committed,
        committedAt: new Date(),
        committedByUserId: principal.id,
      },
    });
    // Silence the "plan unused inside the closure" lint — the
    // plan is captured by the outer call site for the audit
    // record. Keeping the parameter makes the contract explicit.
    void plan;
    return { batch: updated, committed, deactivated, archivedPriorBatches: archived.count };
  }, {
    // See comment above the transaction opening for rationale.
    timeout: 120_000,
    maxWait: 30_000,
  });
}

async function commitDomainRow(clubId: string, domain: ImportDomain, normalized: Record<string, unknown>): Promise<{ entityType: string; entityId: string } | null> {
  if (domain === "MEMBERS") {
    const member = await prisma.member.create({
      data: {
        clubId,
        memberNumber: String(normalized.memberNumber),
        firstName: String(normalized.firstName),
        lastName: String(normalized.lastName),
        email: String(normalized.email),
        phone: normalized.phone ? String(normalized.phone) : null,
        membershipCategory: normalized.membershipCategory ? String(normalized.membershipCategory) : null,
        joinDate: normalized.joinDate as Date | null,
        status: String(normalized.status ?? "ACTIVE"),
        paymentMethodStatus: "NONE",
      },
    });
    await prisma.memberAccount.create({ data: { clubId, memberId: member.id } });
    return { entityType: "Member", entityId: member.id };
  }
  if (domain === "VENDORS") {
    const legalName = String(normalized.legalName);
    const vendorNumber = `V-IMP-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
    let defaultExpenseAccountId: string | null = null;
    if (normalized.defaultExpenseAccountNumber) {
      const acct = await prisma.account.findUnique({
        where: { clubId_accountNumber: { clubId, accountNumber: String(normalized.defaultExpenseAccountNumber) } },
      });
      defaultExpenseAccountId = acct?.id ?? null;
    }
    const vendor = await prisma.vendor.create({
      data: {
        clubId,
        vendorNumber,
        legalName,
        operatingName: normalized.displayName ? String(normalized.displayName) : null,
        email: normalized.email ? String(normalized.email) : null,
        phone: normalized.phone ? String(normalized.phone) : null,
        paymentTermsDays: Number(normalized.paymentTermsDays ?? 30),
        paymentMethod: String(normalized.paymentMethod ?? "EFT"),
        defaultExpenseAccountId,
        defaultTaxCodeKey: normalized.defaultTaxCodeKey ? String(normalized.defaultTaxCodeKey) : null,
        status: "DRAFT",
      },
    });
    return { entityType: "Vendor", entityId: vendor.id };
  }
  if (domain === "INVENTORY") {
    const item = await prisma.inventoryItem.create({
      data: {
        clubId,
        sku: String(normalized.sku),
        name: String(normalized.name),
        unitOfMeasure: String(normalized.unit ?? "EA"),
        averageCost: Number(normalized.unitCost ?? 0),
        defaultCost: Number(normalized.unitCost ?? 0),
        reorderPoint: Number(normalized.reorderLevel ?? 0),
      },
    });
    return { entityType: "InventoryItem", entityId: item.id };
  }
  // COA — validateBatch resolves type/category/fs-group/department
  // FK ids and stores them in `normalizedJson`. We just persist them.
  if (domain === "COA") {
    const type = String(normalized.type).toUpperCase();
    const normalBalance = (type === "ASSET" || type === "EXPENSE") ? "DEBIT" : "CREDIT";
    const categoryId = normalized.categoryId ? String(normalized.categoryId) : null;
    const fsGroupId = normalized.fsGroupId ? String(normalized.fsGroupId) : null;
    const departmentIds = Array.isArray(normalized.departmentIds)
      ? normalized.departmentIds.map((v) => String(v)).filter((v) => v.length > 0)
      : [];
    // First department in the mapping is the "primary" — kept on
    // Account.defaultDepartmentId for legacy callers.
    const primaryDepartmentId = departmentIds[0] ?? null;

    const account = await prisma.account.upsert({
      where: { clubId_accountNumber: { clubId, accountNumber: String(normalized.number) } },
      update: {
        name: String(normalized.name),
        type,
        normalBalance,
        categoryId,
        fsGroupId,
        defaultDepartmentId: primaryDepartmentId,
      },
      create: {
        clubId,
        accountNumber: String(normalized.number),
        name: String(normalized.name),
        type,
        normalBalance,
        categoryId,
        fsGroupId,
        defaultDepartmentId: primaryDepartmentId,
        isActive: true,
      },
    });

    // Reconcile the many-to-many AccountDepartment join. Strategy:
    // wipe the existing rows for this account, then insert the new
    // set. Operator-driven re-import is the normal path here.
    await prisma.accountDepartment.deleteMany({
      where: { accountId: account.id, clubId },
    });
    if (departmentIds.length > 0) {
      await prisma.accountDepartment.createMany({
        data: departmentIds.map((departmentId) => ({
          clubId,
          accountId: account.id,
          departmentId,
        })),
      });
    }

    return { entityType: "Account", entityId: account.id };
  }
  // Other domains: record only (no auto-create). Caller can wire them later.
  return null;
}

// ---------------------------------------------------------------------------
// COA mapping — persist row-by-row decisions from the mapping UI.
// ---------------------------------------------------------------------------
// The in-page mapping table sends one entry per ImportRow with the
// operator-selected type / category / fs group / departments. This
// helper merges those decisions back into each ImportRow.rawJson so
// the next `validateBatch` call sees them. Validate/commit logic
// itself doesn't change.
export async function saveCoaRowMappings(
  principal: Principal,
  args: {
    batchId: string;
    mappings: ReadonlyArray<{
      rowId: string;
      type: string | null;
      categoryKey: string | null;
      fsGroupKey: string | null;
      departmentCodes: string[];
    }>;
  },
) {
  const batch = await prisma.importBatch.findUnique({
    where: { id: args.batchId },
    select: { id: true, clubId: true, domain: true, status: true },
  });
  if (!batch) throw new NotFoundError("ImportBatch", args.batchId);
  ensureWrite(principal, batch.clubId);
  if (batch.domain !== "COA") {
    throw new ValidationError([{ path: "domain", message: "saveCoaRowMappings is only valid for COA batches" }]);
  }
  if (batch.status === "COMMITTED" || batch.status === "ROLLED_BACK") {
    throw new ConflictError(`Batch is ${batch.status}; mapping can no longer be edited.`);
  }

  const rowIds = args.mappings.map((m) => m.rowId);
  // Tenant guard — every row must belong to this batch (and therefore
  // this club). We refuse to write if the operator hands in a foreign
  // row id.
  const rows = await prisma.importRow.findMany({
    where: { id: { in: rowIds }, batchId: batch.id },
    select: { id: true, rawJson: true },
  });
  const rowMap = new Map(rows.map((r) => [r.id, r] as const));
  if (rowMap.size !== rowIds.length) {
    throw new ValidationError([{ path: "mappings", message: "One or more rows do not belong to this batch." }]);
  }

  // Founder rule 2026-07-13: Save Mapping persists the operator's
  // edits and ONLY their edits. It must not blanket-clear the
  // prior validation state — that erases the operator's view of
  // what errors existed and makes a DRAFT/VALIDATED batch
  // misleadingly read as "0 errors" until they re-validate.
  //
  // What we DO touch per mapping:
  //   • rawJson — the new operator-chosen mapping is persisted.
  //   • If the row's mapping actually changed (rawJson differs
  //     after the merge), wipe its prior status / errorMessage /
  //     normalizedJson AND delete its persisted ImportError rows.
  //     Those errors were tied to the OLD mapping; preserving
  //     them after the operator changed the row would be more
  //     misleading than helpful.
  //
  // What we DO NOT touch:
  //   • Any row whose serialized rawJson is byte-identical after
  //     the merge — its prior status + errorMessage stay in place.
  //   • The batch's `validRows` / `errorRows` — those represent
  //     the LAST validation's result and must persist so the list
  //     can still report meaningful counts after Save Mapping.
  //   • The batch's `status` — DRAFT stays DRAFT, VALIDATED stays
  //     VALIDATED; only Validate / Commit move the status.
  //   • Any ImportError record on a row whose mapping didn't
  //     change in this save.
  //
  // What we DO touch on the batch:
  //   • `dryRunAt` — cleared if any row's mapping actually
  //     changed, so the commit guard ("Dry-run required before
  //     commit") forces a fresh Validate before committing.
  let changedRowCount = 0;
  const changedRowIds: string[] = [];
  for (const m of args.mappings) {
    const existing = rowMap.get(m.rowId);
    if (!existing) continue;
    const raw = parseJson<Record<string, unknown>>(existing.rawJson, {});
    const merged: Record<string, unknown> = {
      ...raw,
      type: m.type ?? "",
      categoryKey: m.categoryKey ?? "",
      fsGroupKey: m.fsGroupKey ?? "",
      departmentCodes: m.departmentCodes.filter((c) => c.trim().length > 0),
    };
    // Drop the legacy singular field if present — the array is now
    // the canonical shape downstream.
    delete merged.departmentCode;
    const nextRawJson = JSON.stringify(merged);
    const changed = nextRawJson !== existing.rawJson;
    if (!changed) continue;
    changedRowCount++;
    changedRowIds.push(m.rowId);
    await prisma.importRow.update({
      where: { id: m.rowId },
      data: {
        rawJson: nextRawJson,
        // Row mapping changed → its prior validation result is
        // tied to a stale mapping. Clear it so the next Validate
        // pass starts clean for this row, but leave the rest of
        // the batch alone.
        status: "PENDING",
        errorMessage: null,
        normalizedJson: null,
      },
    });
  }
  if (changedRowIds.length > 0) {
    await prisma.importError.deleteMany({
      where: { batchId: batch.id, rowNumber: { in: await rowNumbersFor(changedRowIds) } },
    });
    // Force a fresh validation pass before commit; preserve every
    // other batch field so the operator's view (status, counts)
    // remains coherent until they re-validate.
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: { dryRunAt: null },
    });
  }

  await audit(principal, {
    action: "import.coa.mapping.save",
    entityType: "ImportBatch",
    entityId: batch.id,
    clubId: batch.clubId,
    after: { rows: args.mappings.length, changedRows: changedRowCount },
  });

  return { rowsUpdated: changedRowCount };
}

/**
 * Founder rule 2026-06-29: every COA upload runs through the
 * intelligent auto-mapping engine BEFORE the operator sees the
 * mapping screen. This helper loads the club's existing
 * accounts (for the "second import is faster" learning path),
 * calls the pure predictor, writes the predictions to the rows
 * via `saveCoaRowMappings`, and persists per-row confidence +
 * source metadata in each ImportRow.rawJson under `_prediction`.
 *
 * The UI reads `_prediction` to render confidence indicators
 * (amber dot for medium, subtle tint for low).
 *
 * Idempotent: re-running predicts again from the same inputs.
 */
export async function applyCoaAutoMapping(
  principal: Principal,
  batchId: string,
): Promise<{ predicted: number; high: number; medium: number; low: number }> {
  const { predictCoaBatch } = await import("./coa-predictor");

  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { id: true, clubId: true, domain: true },
  });
  if (!batch) throw new NotFoundError("ImportBatch", batchId);
  ensureWrite(principal, batch.clubId);
  if (batch.domain !== "COA") {
    throw new ValidationError([
      { path: "domain", message: "applyCoaAutoMapping is only valid for COA batches" },
    ]);
  }

  // Load the existing accounts on this club so the predictor can
  // inherit prior decisions on re-imports (no separate "learned
  // mappings" table needed — Account rows ARE the memory).
  const existingAccounts = await prisma.account.findMany({
    where: { clubId: batch.clubId, isActive: true },
    include: { category: true, fsGroup: true, defaultDepartment: true },
  });
  const existingByNumber = new Map(
    existingAccounts.map((a) => [
      a.accountNumber,
      {
        accountNumber: a.accountNumber,
        type: a.type,
        categoryKey: a.category?.key ?? null,
        fsGroupKey: a.fsGroup?.key ?? null,
        defaultDepartmentCode: a.defaultDepartment?.code ?? null,
      },
    ]),
  );

  // Pull every ImportRow + its current raw mapping data.
  const rows = await prisma.importRow.findMany({
    where: { batchId: batch.id },
    orderBy: { rowNumber: "asc" },
    select: { id: true, rawJson: true },
  });
  const inputs = rows.map((r) => {
    const raw = parseJson<Record<string, unknown>>(r.rawJson, {});
    return {
      rowId: r.id,
      number: String(raw.number ?? "").trim(),
      name: String(raw.name ?? "").trim(),
    };
  });

  const predictions = predictCoaBatch(inputs, existingByNumber);

  // Stamp _prediction into rawJson so the page can render
  // confidence hints, then route mapping through the canonical
  // saveCoaRowMappings path (which handles the dirty-state
  // bookkeeping, ImportError targeting, etc.).
  for (let i = 0; i < rows.length; i++) {
    const ir = rows[i];
    const p = predictions[i];
    const raw = parseJson<Record<string, unknown>>(ir.rawJson, {});
    raw._prediction = {
      confidence: p.confidence,
      source: p.source,
      type: p.type,
      categoryKey: p.categoryKey,
      fsGroupKey: p.fsGroupKey,
    };
    await prisma.importRow.update({
      where: { id: ir.id },
      data: { rawJson: JSON.stringify(raw) },
    });
  }

  await saveCoaRowMappings(principal, {
    batchId: batch.id,
    mappings: rows.map((r, i) => ({
      rowId: r.id,
      type: predictions[i].type,
      categoryKey: predictions[i].categoryKey,
      fsGroupKey: predictions[i].fsGroupKey,
      departmentCodes: predictions[i].defaultDepartmentCode
        ? [predictions[i].defaultDepartmentCode!]
        : [],
    })),
  });

  const counts = { high: 0, medium: 0, low: 0 };
  for (const p of predictions) {
    counts[p.confidence]++;
  }
  await audit(principal, {
    action: "import.coa.auto-map",
    entityType: "ImportBatch",
    entityId: batch.id,
    clubId: batch.clubId,
    after: { predicted: predictions.length, ...counts },
  });
  return { predicted: predictions.length, ...counts };
}

/**
 * Helper for saveCoaRowMappings: resolve a set of ImportRow IDs
 * to their `rowNumber`s so we can scope a targeted
 * `importError.deleteMany` to ONLY the rows whose mapping
 * actually changed in this save.
 */
async function rowNumbersFor(rowIds: string[]): Promise<number[]> {
  if (rowIds.length === 0) return [];
  const rows = await prisma.importRow.findMany({
    where: { id: { in: rowIds } },
    select: { rowNumber: true },
  });
  return rows.map((r) => r.rowNumber);
}

// ---------------------------------------------------------------------------
// Delete a DRAFT batch (and its child rows + errors).
// ---------------------------------------------------------------------------
// Only DRAFT batches are deletable from this path. Once a batch is
// VALIDATED, COMMITTED, ROLLED_BACK, or anything else, the operator
// must use the existing rollback flow (for committed batches) — we
// will not silently destroy audit history for batches that have
// already touched the live tables.
//
// Cascading deletes for ImportRow + ImportError are wired at the
// schema layer (`onDelete: Cascade`), so a single
// `prisma.importBatch.delete()` removes the batch + every staging
// row + every error in one transaction.
/**
 * Delete an import batch + its staged rows.
 *
 * Founder rule 2026-07-12: only COMMITTED batches are protected
 * from deletion — they are retained for audit history. Every
 * other status (DRAFT, VALIDATED, FAILED, ARCHIVED, …) is
 * deletable so the import history stays clean.
 *
 * Deleting an ARCHIVED COA batch does NOT touch the active Chart
 * of Accounts — the Account rows live in their own tables and
 * are independent of the ImportBatch / ImportRow records this
 * function removes.
 *
 * Always tenant-scoped via `ensureWrite`.
 *
 * The legacy name `deleteDraftBatch` is preserved as an alias for
 * call-site stability; both names route through the same logic.
 */
export async function deleteBatch(principal: Principal, batchId: string) {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      clubId: true,
      domain: true,
      status: true,
      totalRows: true,
      fileName: true,
    },
  });
  if (!batch) throw new NotFoundError("ImportBatch", batchId);
  ensureWrite(principal, batch.clubId);
  // Founder rule 2026-06-30 v14.5 — allow deletion of TB batches
  // in SUPERSEDED or VOIDED state (their ledger impact is already
  // zero). COMMITTED (live) batches remain audit-locked and must
  // be voided or superseded first.
  const isCleanableTb = batch.domain === "OPENING_TRIAL_BALANCE" &&
    (batch.status === "SUPERSEDED" || batch.status === "VOIDED");
  if (batch.status === "COMMITTED" && !isCleanableTb) {
    throw new ConflictError(
      "Committed batches are retained for audit history and cannot be deleted. Use Rollback to reverse a committed batch.",
    );
  }
  await prisma.importBatch.delete({ where: { id: batch.id } });
  await audit(principal, {
    action: "import.batch.delete",
    entityType: "ImportBatch",
    entityId: batch.id,
    clubId: batch.clubId,
    before: {
      domain: batch.domain,
      status: batch.status,
      totalRows: batch.totalRows,
      fileName: batch.fileName,
    },
  });
  return { deleted: true, batchId: batch.id, domain: batch.domain };
}

/** @deprecated use `deleteBatch` — kept as an alias for stability. */
export const deleteDraftBatch = deleteBatch;

// ---------------------------------------------------------------------------
// Rollback — soft-delete created entities (members → INACTIVE, vendors → DRAFT)
// ---------------------------------------------------------------------------
export async function rollbackBatch(principal: Principal, batchId: string) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new NotFoundError("ImportBatch", batchId);
  ensureWrite(principal, batch.clubId);
  if (batch.status !== "COMMITTED") throw new ConflictError("Only COMMITTED batches can be rolled back");
  const rows = await prisma.importRow.findMany({ where: { batchId, status: "IMPORTED", createdEntityId: { not: null } } });
  let reverted = 0;
  for (const row of rows) {
    if (row.createdEntityType === "Member") {
      await prisma.member.update({ where: { id: row.createdEntityId! }, data: { status: "INACTIVE" } });
      reverted++;
    } else if (row.createdEntityType === "Vendor") {
      await prisma.vendor.update({ where: { id: row.createdEntityId! }, data: { status: "ARCHIVED" } });
      reverted++;
    } else if (row.createdEntityType === "InventoryItem") {
      await prisma.inventoryItem.update({ where: { id: row.createdEntityId! }, data: { isActive: false } });
      reverted++;
    }
    // Account / journal commits are never rolled back this way.
  }
  const updated = await prisma.importBatch.update({
    where: { id: batch.id },
    data: { status: "ROLLED_BACK", rolledBackAt: new Date() },
  });
  await audit(principal, { action: "import.batch.rollback", entityType: "ImportBatch", entityId: batch.id, clubId: batch.clubId, after: { reverted } });
  return updated;
}

// ---------------------------------------------------------------------------
// Helpers for the UI
// ---------------------------------------------------------------------------
export async function listBatches(principal: Principal, clubId: string) {
  ensureWrite(principal, clubId);
  return prisma.importBatch.findMany({
    where: { clubId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function batchDetail(principal: Principal, batchId: string) {
  // Rows: NO `take` limit — the COA mapping UI needs every row so
  // the operator can classify all of them; createBatchSchema already
  // caps a batch at 20,000 rows. Errors stay capped at 500 since
  // the surfaced list is diagnostic and a longer scroll is wasted.
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: {
      rows: { orderBy: { rowNumber: "asc" } },
      errors: { orderBy: { rowNumber: "asc" }, take: 500 },
    },
  });
  if (!batch) throw new NotFoundError("ImportBatch", batchId);
  ensureWrite(principal, batch.clubId);
  return batch;
}

export function templateCsvFor(domain: ImportDomain): string {
  const cols = IMPORT_TEMPLATES[domain];
  return cols.join(",") + "\n";
}
