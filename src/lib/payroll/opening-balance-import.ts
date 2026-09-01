// Payroll-3B-5A (2026-08-31) — opening-balance CSV import (§17).
// Payroll-3B-5B-1b (2026-09-01, §11) — "same employer" clarification
// added to admin-facing help copy.
//
// SCOPE OF "OPENING BALANCES"
// ----------------------------
// Opening balances are payroll amounts YOUR CLUB (this employer,
// same Business Number) previously processed on another payroll
// system before adopting Spectre. They are NOT another employer's
// T4 amounts. If a seasonal employee also works for Employer B,
// Employer B's payroll history is IRRELEVANT to this Club's Spectre
// payroll — CRA requires each employer to deduct CPP + EI + income
// tax independently.
//
// This CSV import only accepts THIS CLUB's prior payroll history.
// PRIOR_EMPLOYER rows can be recorded via the manual-entry service
// for HR reference but the YTD aggregator zeroes them for payroll
// calculation (§9-10).
//
// SIN matching is explicitly prohibited (§18 of 3B-5A briefing).

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { parseCsvRecords } from "../imports/csv-parse";
import { ValidationError } from "../errors";
import {
  createDraftOpeningBalance,
  type OpeningBalanceFields,
  type OpeningBalanceView,
} from "./opening-balance";

const ENTITY = "PayrollOpeningBalance";
const IMPORT_ORIGIN_KIND = "PAYROLL_OPENING_BALANCE_REVIEW";

// Payroll-3B-5B-1 (§21) — the split CPP columns are OPTIONAL on
// import; when absent the row's split fields default to 0 and the
// aggregate `ytdCppEE`/`ytdCppER` remain the authoritative Box 16
// totals. Callers loading full CRA-split T4 data supply all rows;
// callers loading legacy aggregate-only data still succeed.
const REQUIRED_NUMERIC_FIELDS = [
  "ytdGrossEarnings",
  "ytdTaxableEarnings",
  "ytdPensionableEarnings",
  "ytdInsurableEarnings",
  "ytdCppEE",
  "ytdCpp2EE",
  "ytdEiEE",
  "ytdFederalTax",
  "ytdProvincialTax",
  "ytdCppER",
  "ytdCpp2ER",
  "ytdEiER",
] as const;

const OPTIONAL_NUMERIC_FIELDS = [
  "ytdCppEE_Base",
  "ytdCppEE_FirstAdd",
  "ytdCppER_Base",
  "ytdCppER_FirstAdd",
] as const;

export const OPENING_BALANCE_CSV_HEADERS = [
  "employeeNumber",
  "taxYear",
  ...REQUIRED_NUMERIC_FIELDS,
  ...OPTIONAL_NUMERIC_FIELDS,
] as const;

const REQUIRED_HEADERS = ["employeeNumber", "taxYear", ...REQUIRED_NUMERIC_FIELDS] as const;

export interface OpeningBalanceImportRowError {
  rowNumber: number;
  employeeNumber: string | null;
  code: string;
  message: string;
}

export interface OpeningBalanceImportResult {
  processed: number;
  createdOrRefreshed: number;
  errors: OpeningBalanceImportRowError[];
  drafts: OpeningBalanceView[];
  workIntakeItemId: string | null;
}

function toEmpMap(rows: Array<{ id: string; employeeNumber: string }>): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) m.set(r.employeeNumber.trim(), r.id);
  return m;
}

/**
 * Ingest an opening-balance CSV. Never partial-commits: each row is
 * an independent draft write within its own audit event. Rows that
 * fail validation are surfaced as row-level errors and do NOT block
 * the successful rows.
 */
export async function importOpeningBalancesFromCsv(
  principal: Principal,
  clubId: string,
  input: {
    csvText: string;
    taxYear: number;
    /**
     * Payroll-3B-5B-2 pre-calc gate (§15) — REQUIRED cutover boundary
     * for the whole import. The cutover date is supplied ONCE at the
     * import-operation level (rather than repeated on every employee
     * row) — the entire batch represents a single "prior payroll
     * system ran through this date" event. Applied to every drafted
     * row. The date MUST live in the same tax year as `taxYear`.
     */
    throughPayDate: Date;
    sourceFilename?: string;
  },
): Promise<OpeningBalanceImportResult> {
  requirePermission(principal, clubId, "payroll:run");
  await assertPostingAllowed(principal, clubId, "payroll.opening-balance.import", ENTITY, `taxYear:${input.taxYear}`);

  if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > 2100) {
    throw new ValidationError([{ path: "taxYear", message: "Invalid tax year." }]);
  }
  if (!(input.throughPayDate instanceof Date) || Number.isNaN(input.throughPayDate.getTime())) {
    throw new ValidationError([
      { path: "throughPayDate", message: "throughPayDate is required for opening-balance imports." },
    ]);
  }
  if (input.throughPayDate.getUTCFullYear() !== input.taxYear) {
    throw new ValidationError([
      {
        path: "throughPayDate",
        message: `throughPayDate (${input.throughPayDate.toISOString().slice(0, 10)}) must be in tax year ${input.taxYear}.`,
      },
    ]);
  }

  const records = parseCsvRecords(input.csvText);
  if (records.length < 2) {
    throw new ValidationError([{ path: "csvText", message: "CSV appears empty (no header + rows)." }]);
  }
  const header = records[0].map((c) => c.trim());
  const missing = REQUIRED_HEADERS.filter((h) => !header.includes(h));
  if (missing.length > 0) {
    throw new ValidationError([
      { path: "csvText", message: `Missing required columns: ${missing.join(", ")}` },
    ]);
  }
  const colIndex = new Map(header.map((h, i) => [h, i]));

  // Pre-load employees for match resolution — never SIN, per §18.
  const employees = await prisma.employee.findMany({
    where: { clubId },
    select: { id: true, employeeNumber: true },
  });
  const empIdByNumber = toEmpMap(
    employees
      .filter((e) => e.employeeNumber != null)
      .map((e) => ({ id: e.id, employeeNumber: String(e.employeeNumber) })),
  );

  const errors: OpeningBalanceImportRowError[] = [];
  const drafts: OpeningBalanceView[] = [];
  let createdOrRefreshed = 0;

  for (let i = 1; i < records.length; i++) {
    const row = records[i];
    const rowNumber = i + 1; // 1-indexed, header is row 1
    const empNum = (row[colIndex.get("employeeNumber")!] ?? "").trim();
    if (!empNum) {
      errors.push({ rowNumber, employeeNumber: null, code: "MISSING_EMPLOYEE_NUMBER", message: "employeeNumber is empty." });
      continue;
    }
    const employeeId = empIdByNumber.get(empNum);
    if (!employeeId) {
      errors.push({
        rowNumber,
        employeeNumber: empNum,
        code: "EMPLOYEE_NOT_FOUND",
        message: `No Employee with employeeNumber "${empNum}" in this Club.`,
      });
      continue;
    }
    const rawTaxYear = (row[colIndex.get("taxYear")!] ?? "").trim();
    const parsedTaxYear = Number(rawTaxYear);
    if (!Number.isInteger(parsedTaxYear) || parsedTaxYear !== input.taxYear) {
      errors.push({
        rowNumber,
        employeeNumber: empNum,
        code: "TAX_YEAR_MISMATCH",
        message: `taxYear "${rawTaxYear}" does not match import taxYear ${input.taxYear}.`,
      });
      continue;
    }

    const values: Partial<OpeningBalanceFields> = {};
    let rowInvalid = false;
    // REQUIRED columns must exist (already header-validated) — read them.
    for (const f of REQUIRED_NUMERIC_FIELDS) {
      const idx = colIndex.get(f);
      if (idx === undefined) { rowInvalid = true; break; }
      const raw = (row[idx] ?? "").trim();
      values[f as keyof OpeningBalanceFields] = raw === "" ? "0" : raw;
    }
    // OPTIONAL split columns — default to "0" when absent.
    for (const f of OPTIONAL_NUMERIC_FIELDS) {
      const idx = colIndex.get(f);
      if (idx === undefined) { values[f as keyof OpeningBalanceFields] = "0"; continue; }
      const raw = (row[idx] ?? "").trim();
      values[f as keyof OpeningBalanceFields] = raw === "" ? "0" : raw;
    }
    if (rowInvalid) {
      errors.push({ rowNumber, employeeNumber: empNum, code: "MISSING_NUMERIC_COLUMN", message: "One or more numeric columns absent." });
      continue;
    }

    try {
      const view = await createDraftOpeningBalance(principal, clubId, {
        employeeId,
        taxYear: input.taxYear,
        throughPayDate: input.throughPayDate,
        values: values as OpeningBalanceFields,
        importSource: "CSV",
        notes: input.sourceFilename ? `Imported from ${input.sourceFilename}` : undefined,
      });
      drafts.push(view);
      createdOrRefreshed++;
    } catch (err) {
      const message = err instanceof ValidationError
        ? err.issues.map((i) => `${i.path}: ${i.message}`).join("; ")
        : (err as Error).message;
      errors.push({ rowNumber, employeeNumber: empNum, code: "VALIDATION_FAILED", message });
    }
  }

  const workIntakeItemId = errors.length > 0
    ? await ensureOpeningBalanceReviewCard(clubId, input.taxYear, errors.length)
    : null;

  await audit(principal, {
    action: "payroll.opening-balance.import",
    entityType: ENTITY,
    entityId: `taxYear:${input.taxYear}`,
    clubId,
    after: {
      taxYear: input.taxYear,
      processed: records.length - 1,
      createdOrRefreshed,
      errorCount: errors.length,
      sourceFilename: input.sourceFilename ?? null,
    },
  });

  return {
    processed: records.length - 1,
    createdOrRefreshed,
    errors,
    drafts,
    workIntakeItemId,
  };
}

// ---------------------------------------------------------------------------
// Work Intake — opening-balance review card
// ---------------------------------------------------------------------------

/**
 * Ensure a PAYROLL_OPENING_BALANCE_REVIEW Work Intake card exists for
 * (Club, taxYear). Owner = PayrollClubConfig.payrollAdminUserId — the
 * single canonical Payroll Admin recipient. Never falls back.
 * Idempotent via `WorkIntakeOrigin(kind, referenceId)`.
 */
export async function ensureOpeningBalanceReviewCard(
  clubId: string,
  taxYear: number,
  errorCount: number,
): Promise<string | null> {
  const referenceId = `${taxYear}`;
  const existing = await prisma.workIntakeOrigin.findFirst({
    where: { clubId, kind: IMPORT_ORIGIN_KIND, referenceId, role: "PRIMARY" },
    select: { workIntakeItemId: true },
  });
  const config = await prisma.payrollClubConfig.findUnique({ where: { clubId } });
  const ownerUserId = config?.payrollAdminUserId ?? null;
  const subject = `Opening payroll balances need review (${taxYear})`;
  const preview = errorCount === 1
    ? "1 employee requires attention before payroll can be calculated."
    : `${errorCount} employees require attention before payroll can be calculated.`;

  if (existing) {
    await prisma.workIntakeItem.update({
      where: { id: existing.workIntakeItemId },
      data: {
        ownerUserId,
        displaySubject: subject,
        displayPreview: preview,
        displayReceivedAt: new Date(),
        status: "OPEN",
      },
    });
    return existing.workIntakeItemId;
  }

  const now = new Date();
  const created = await prisma.workIntakeItem.create({
    data: {
      clubId,
      status: "OPEN",
      judgmentRequired: true,
      ownerUserId,
      classification: IMPORT_ORIGIN_KIND,
      classificationReason: `Opening-balance import produced ${errorCount} exception(s).`,
      classificationMethod: "RULE",
      classificationRuleKey: "payroll-orchestration.v1",
      classificationRuleVersion: 1,
      displaySourceLabel: "Spectre Payroll",
      displaySender: "Payroll orchestration",
      displaySubject: subject,
      displayPreview: preview,
      displayReceivedAt: now,
      displayHasAttachments: false,
      workDomain: "PAYROLL",
      workIntent: "REVIEW",
      workSubtype: "PAYROLL_OPENING_BALANCE_REVIEW",
      workDomainConfidence: 1,
      workDomainClassifiedAt: now,
      workDomainClassifierVersion: "payroll-orchestration.v1",
    },
    select: { id: true },
  });
  await prisma.workIntakeOrigin.create({
    data: {
      clubId,
      workIntakeItemId: created.id,
      kind: IMPORT_ORIGIN_KIND,
      referenceId,
      role: "PRIMARY",
      linkReason: `Opening-balance CSV import for tax year ${taxYear}.`,
    },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: created.id,
      action: "MATERIALISED",
      note: `Opening-balance import produced ${errorCount} exception row(s).`,
    },
  });
  return created.id;
}

/**
 * Resolve the review card once no errors remain and every DRAFT for
 * the tax year has been activated. Called by the founder / admin
 * after correcting rows.
 */
export async function resolveOpeningBalanceReviewCardIfClean(
  clubId: string,
  taxYear: number,
): Promise<{ resolved: boolean; workIntakeItemId: string | null }> {
  const link = await prisma.workIntakeOrigin.findFirst({
    where: { clubId, kind: IMPORT_ORIGIN_KIND, referenceId: `${taxYear}`, role: "PRIMARY" },
    select: { workIntakeItemId: true },
  });
  if (!link) return { resolved: false, workIntakeItemId: null };
  const pendingDrafts = await prisma.payrollOpeningBalance.count({
    where: { clubId, taxYear, status: { in: ["DRAFT", "VALIDATED"] } },
  });
  if (pendingDrafts > 0) return { resolved: false, workIntakeItemId: link.workIntakeItemId };
  await prisma.workIntakeItem.update({
    where: { id: link.workIntakeItemId },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
  await prisma.workIntakeActivity.create({
    data: {
      workIntakeItemId: link.workIntakeItemId,
      action: "RESOLVED",
      note: `All DRAFT / VALIDATED opening balances for tax year ${taxYear} have been activated or removed.`,
    },
  });
  return { resolved: true, workIntakeItemId: link.workIntakeItemId };
}
