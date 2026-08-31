// Payroll-3B-5A (2026-08-31) — canonical opening-balance service.
//
// Every Club that adopts Spectre Payroll mid-calendar-year must load
// prior-payroll-system YTD totals per (Employee, taxYear) so
// CPP/EI/tax caps and bracketing are correct from the first
// Spectre-generated pay stub. This service is the ONLY authorised
// path to write those rows.
//
// Correction pattern (§16): rows are versioned. The current row
// carries `status = "ACTIVE"`; corrections do NOT mutate — they
// insert a new DRAFT row that supersedes the ACTIVE one on
// activation. Post-supersede the old row becomes SUPERSEDED with
// `supersededById` pointing at the successor.
//
// Sensitive plaintext is NEVER stored here. This is a YTD-numerics
// row only. Provenance (importedAt, importedByUserId, importSource,
// importBatchId) is required.

import type { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { NotFoundError, ValidationError } from "../errors";

const ENTITY = "PayrollOpeningBalance";

export type OpeningBalanceStatus = "DRAFT" | "VALIDATED" | "ACTIVE" | "SUPERSEDED";

export interface OpeningBalanceFields {
  ytdGrossEarnings: string;
  ytdTaxableEarnings: string;
  ytdPensionableEarnings: string;
  ytdInsurableEarnings: string;
  // Payroll-3B-5B-1 (§21) — CPP base + first-additional split.
  // Legacy `ytdCppEE` remains the aggregate for T4 Box 16.
  ytdCppEE_Base: string;
  ytdCppEE_FirstAdd: string;
  ytdCppEE: string;
  ytdCpp2EE: string;
  ytdEiEE: string;
  ytdFederalTax: string;
  ytdProvincialTax: string;
  ytdCppER_Base: string;
  ytdCppER_FirstAdd: string;
  ytdCppER: string;
  ytdCpp2ER: string;
  ytdEiER: string;
}

/**
 * Payroll-3B-5B-1 (§23) — provenance of a prior-payroll YTD row.
 * The value is stored on the row and returned in the view so the
 * calculator + reviewers can see whether the balance contributes
 * to CPP/EI annual maximums for this employer.
 */
export type PriorPayrollKind =
  | "PRIOR_SYSTEM_SAME_EMPLOYER" // this club's payroll on another system earlier this tax year — contributes to CPP/EI maxima
  | "PRIOR_EMPLOYER"             // different employer/BN — recorded for information only; does NOT reduce this employer's caps
  | "PRIOR_ADJUSTMENT";          // year-end / correction adjustment for this employer

export interface OpeningBalanceView {
  id: string;
  clubId: string;
  employeeId: string;
  taxYear: number;
  status: OpeningBalanceStatus;
  values: OpeningBalanceFields;
  importSource: string | null;
  importedAt: Date | null;
  importedByUserId: string | null;
  notes: string | null;
  supersededAt: Date | null;
  supersededById: string | null;
  activatedAt: Date | null;
  // Payroll-3B-5B-1 (§23) — prior-payroll kind provenance.
  priorPayrollKind: PriorPayrollKind;
  priorEmployerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const NUMERIC_FIELDS: Array<keyof OpeningBalanceFields> = [
  "ytdGrossEarnings",
  "ytdTaxableEarnings",
  "ytdPensionableEarnings",
  "ytdInsurableEarnings",
  "ytdCppEE_Base",
  "ytdCppEE_FirstAdd",
  "ytdCppEE",
  "ytdCpp2EE",
  "ytdEiEE",
  "ytdFederalTax",
  "ytdProvincialTax",
  "ytdCppER_Base",
  "ytdCppER_FirstAdd",
  "ytdCppER",
  "ytdCpp2ER",
  "ytdEiER",
];

const PRIOR_PAYROLL_KINDS: readonly PriorPayrollKind[] = [
  "PRIOR_SYSTEM_SAME_EMPLOYER",
  "PRIOR_EMPLOYER",
  "PRIOR_ADJUSTMENT",
];

function toView(row: Awaited<ReturnType<typeof prisma.payrollOpeningBalance.findFirst>>): OpeningBalanceView {
  if (!row) throw new NotFoundError(ENTITY, "(null)");
  return {
    id: row.id,
    clubId: row.clubId,
    employeeId: row.employeeId,
    taxYear: row.taxYear,
    status: row.status as OpeningBalanceStatus,
    values: {
      ytdGrossEarnings: row.ytdGrossEarnings.toString(),
      ytdTaxableEarnings: row.ytdTaxableEarnings.toString(),
      ytdPensionableEarnings: row.ytdPensionableEarnings.toString(),
      ytdInsurableEarnings: row.ytdInsurableEarnings.toString(),
      ytdCppEE_Base: row.ytdCppEE_Base.toString(),
      ytdCppEE_FirstAdd: row.ytdCppEE_FirstAdd.toString(),
      ytdCppEE: row.ytdCppEE.toString(),
      ytdCpp2EE: row.ytdCpp2EE.toString(),
      ytdEiEE: row.ytdEiEE.toString(),
      ytdFederalTax: row.ytdFederalTax.toString(),
      ytdProvincialTax: row.ytdProvincialTax.toString(),
      ytdCppER_Base: row.ytdCppER_Base.toString(),
      ytdCppER_FirstAdd: row.ytdCppER_FirstAdd.toString(),
      ytdCppER: row.ytdCppER.toString(),
      ytdCpp2ER: row.ytdCpp2ER.toString(),
      ytdEiER: row.ytdEiER.toString(),
    },
    importSource: row.importSource,
    importedAt: row.importedAt,
    importedByUserId: row.importedByUserId,
    notes: row.notes,
    supersededAt: row.supersededAt,
    supersededById: row.supersededById,
    activatedAt: row.activatedAt,
    priorPayrollKind: (row.priorPayrollKind as PriorPayrollKind) ?? "PRIOR_SYSTEM_SAME_EMPLOYER",
    priorEmployerId: row.priorEmployerId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertValidNumerics(values: OpeningBalanceFields): void {
  const issues: { path: string; message: string }[] = [];
  for (const field of NUMERIC_FIELDS) {
    const v = values[field];
    if (!/^-?\d+(\.\d+)?$/.test(v)) {
      issues.push({ path: field, message: `"${v}" is not a valid decimal string.` });
      continue;
    }
    // Negative values are only meaningful in narrow cases; refuse
    // silently-negative earnings/base fields. Tax fields may be
    // negative (adjustments), but base fields must be zero or positive.
    if (
      (field === "ytdGrossEarnings" ||
        field === "ytdTaxableEarnings" ||
        field === "ytdPensionableEarnings" ||
        field === "ytdInsurableEarnings" ||
        field === "ytdCppEE_Base" ||
        field === "ytdCppEE_FirstAdd" ||
        field === "ytdCppEE" ||
        field === "ytdCpp2EE" ||
        field === "ytdEiEE" ||
        field === "ytdCppER_Base" ||
        field === "ytdCppER_FirstAdd" ||
        field === "ytdCppER" ||
        field === "ytdCpp2ER" ||
        field === "ytdEiER") &&
      Number(v) < 0
    ) {
      issues.push({ path: field, message: `${field} must be zero or positive.` });
    }
  }
  if (issues.length > 0) throw new ValidationError(issues);
}

async function assertTenantEmployee(clubId: string, employeeId: string): Promise<void> {
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, clubId }, select: { id: true } });
  if (!emp) throw new ValidationError([{ path: "employeeId", message: "Employee does not belong to this Club." }]);
}

// ---------------------------------------------------------------------------
// Draft (import / manual)
// ---------------------------------------------------------------------------

export interface CreateDraftOpeningBalanceInput {
  employeeId: string;
  taxYear: number;
  values: OpeningBalanceFields;
  importSource?: string;
  importBatchId?: string | null;
  notes?: string;
  /** Payroll-3B-5B-1 (§23) — default PRIOR_SYSTEM_SAME_EMPLOYER. */
  priorPayrollKind?: PriorPayrollKind;
  priorEmployerId?: string | null;
}

/**
 * Create or refresh a DRAFT opening-balance row for (Club, Employee,
 * taxYear). Idempotent: if a DRAFT row already exists for the tuple,
 * its values are refreshed. VALIDATED / ACTIVE / SUPERSEDED rows are
 * never mutated.
 */
export async function createDraftOpeningBalance(
  principal: Principal,
  clubId: string,
  input: CreateDraftOpeningBalanceInput,
): Promise<OpeningBalanceView> {
  requirePermission(principal, clubId, "payroll:run");
  await assertPostingAllowed(principal, clubId, "payroll.opening-balance.draft", ENTITY, input.employeeId);
  await assertTenantEmployee(clubId, input.employeeId);
  assertValidNumerics(input.values);

  if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > 2100) {
    throw new ValidationError([{ path: "taxYear", message: "Invalid tax year." }]);
  }
  const priorPayrollKind: PriorPayrollKind = input.priorPayrollKind ?? "PRIOR_SYSTEM_SAME_EMPLOYER";
  if (!PRIOR_PAYROLL_KINDS.includes(priorPayrollKind)) {
    throw new ValidationError([
      { path: "priorPayrollKind", message: `priorPayrollKind must be one of ${PRIOR_PAYROLL_KINDS.join(", ")}` },
    ]);
  }
  if (priorPayrollKind === "PRIOR_EMPLOYER" && !input.priorEmployerId?.trim()) {
    throw new ValidationError([
      { path: "priorEmployerId", message: "priorEmployerId is required when priorPayrollKind is PRIOR_EMPLOYER." },
    ]);
  }

  const existing = await prisma.payrollOpeningBalance.findFirst({
    where: { clubId, employeeId: input.employeeId, taxYear: input.taxYear, status: "DRAFT" },
  });

  const decimalData: Record<string, string> = {};
  for (const f of NUMERIC_FIELDS) decimalData[f] = input.values[f];

  if (existing) {
    const updated = await prisma.payrollOpeningBalance.update({
      where: { id: existing.id },
      data: {
        ...decimalData,
        importSource: input.importSource ?? existing.importSource,
        importBatchId: input.importBatchId ?? existing.importBatchId,
        notes: input.notes ?? existing.notes,
        priorPayrollKind,
        priorEmployerId: input.priorEmployerId ?? existing.priorEmployerId,
        importedByUserId: principal.id,
        importedAt: new Date(),
      },
    });
    await audit(principal, {
      action: "payroll.opening-balance.draft.refresh",
      entityType: ENTITY,
      entityId: updated.id,
      clubId,
      after: { taxYear: input.taxYear, employeeId: input.employeeId, importSource: input.importSource },
    });
    return toView(updated);
  }

  const row = await prisma.payrollOpeningBalance.create({
    data: {
      clubId,
      employeeId: input.employeeId,
      taxYear: input.taxYear,
      status: "DRAFT",
      ...decimalData,
      importSource: input.importSource ?? "MANUAL",
      importBatchId: input.importBatchId ?? null,
      notes: input.notes ?? null,
      priorPayrollKind,
      priorEmployerId: input.priorEmployerId ?? null,
      importedByUserId: principal.id,
      importedAt: new Date(),
    },
  });
  await audit(principal, {
    action: "payroll.opening-balance.draft.create",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    after: { taxYear: input.taxYear, employeeId: input.employeeId, importSource: input.importSource },
  });
  return toView(row);
}

// ---------------------------------------------------------------------------
// Validate (mark a DRAFT ready for activation)
// ---------------------------------------------------------------------------

export async function validateOpeningBalance(
  principal: Principal,
  clubId: string,
  id: string,
): Promise<OpeningBalanceView> {
  requirePermission(principal, clubId, "payroll:run");
  const row = await prisma.payrollOpeningBalance.findFirst({ where: { id, clubId } });
  if (!row) throw new NotFoundError(ENTITY, id);
  if (row.status !== "DRAFT") {
    throw new ValidationError([{ path: "status", message: `Cannot validate; status is ${row.status}.` }]);
  }
  assertValidNumerics({
    ytdGrossEarnings: row.ytdGrossEarnings.toString(),
    ytdTaxableEarnings: row.ytdTaxableEarnings.toString(),
    ytdPensionableEarnings: row.ytdPensionableEarnings.toString(),
    ytdInsurableEarnings: row.ytdInsurableEarnings.toString(),
    ytdCppEE_Base: row.ytdCppEE_Base.toString(),
    ytdCppEE_FirstAdd: row.ytdCppEE_FirstAdd.toString(),
    ytdCppEE: row.ytdCppEE.toString(),
    ytdCpp2EE: row.ytdCpp2EE.toString(),
    ytdEiEE: row.ytdEiEE.toString(),
    ytdFederalTax: row.ytdFederalTax.toString(),
    ytdProvincialTax: row.ytdProvincialTax.toString(),
    ytdCppER_Base: row.ytdCppER_Base.toString(),
    ytdCppER_FirstAdd: row.ytdCppER_FirstAdd.toString(),
    ytdCppER: row.ytdCppER.toString(),
    ytdCpp2ER: row.ytdCpp2ER.toString(),
    ytdEiER: row.ytdEiER.toString(),
  });
  const updated = await prisma.payrollOpeningBalance.update({
    where: { id: row.id },
    data: { status: "VALIDATED" },
  });
  await audit(principal, {
    action: "payroll.opening-balance.validate",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    before: { status: "DRAFT" },
    after: { status: "VALIDATED" },
  });
  return toView(updated);
}

// ---------------------------------------------------------------------------
// Activate (supersede any prior ACTIVE row for the tuple)
// ---------------------------------------------------------------------------

export async function activateOpeningBalance(
  principal: Principal,
  clubId: string,
  id: string,
): Promise<OpeningBalanceView> {
  requirePermission(principal, clubId, "payroll:run");
  await assertPostingAllowed(principal, clubId, "payroll.opening-balance.activate", ENTITY, id);

  const row = await prisma.payrollOpeningBalance.findFirst({ where: { id, clubId } });
  if (!row) throw new NotFoundError(ENTITY, id);
  if (row.status !== "VALIDATED" && row.status !== "DRAFT") {
    throw new ValidationError([{ path: "status", message: `Cannot activate; status is ${row.status}.` }]);
  }

  const result = await prisma.$transaction(async (tx) => {
    const active = await tx.payrollOpeningBalance.findFirst({
      where: { clubId, employeeId: row.employeeId, taxYear: row.taxYear, status: "ACTIVE" },
    });
    if (active) {
      await tx.payrollOpeningBalance.update({
        where: { id: active.id },
        data: {
          status: "SUPERSEDED",
          supersededAt: new Date(),
          supersededByUserId: principal.id,
          supersededById: row.id,
        },
      });
    }
    return tx.payrollOpeningBalance.update({
      where: { id: row.id },
      data: {
        status: "ACTIVE",
        activatedAt: new Date(),
        activatedByUserId: principal.id,
      },
    });
  });

  await audit(principal, {
    action: "payroll.opening-balance.activate",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    after: { taxYear: row.taxYear, employeeId: row.employeeId, status: "ACTIVE" },
  });

  return toView(result);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getActiveOpeningBalance(
  clubId: string,
  employeeId: string,
  taxYear: number,
): Promise<OpeningBalanceView | null> {
  const row = await prisma.payrollOpeningBalance.findFirst({
    where: { clubId, employeeId, taxYear, status: "ACTIVE" },
  });
  return row ? toView(row) : null;
}

export async function listOpeningBalances(
  principal: Principal,
  clubId: string,
  taxYear: number,
): Promise<OpeningBalanceView[]> {
  requirePermission(principal, clubId, "payroll:read");
  const rows = await prisma.payrollOpeningBalance.findMany({
    where: { clubId, taxYear },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  return rows.map(toView);
}

// Small helper used by the YTD service.
export function zeroDecimalString(): string {
  return "0";
}

export { NUMERIC_FIELDS };
export type { Decimal };
