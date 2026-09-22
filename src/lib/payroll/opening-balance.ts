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
  /**
   * Payroll-3B-5B-2 pre-calc gate (§6) — cutover boundary.
   * "This opening balance includes all same-employer payroll
   * results with pay date <= throughPayDate." The YTD aggregator
   * refuses to consume an ACTIVE row whose throughPayDate is null.
   * DB layer allows null for additive-migration compatibility;
   * application layer REQUIRES it for every new draft.
   */
  throughPayDate: Date | null;
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
    throughPayDate: row.throughPayDate,
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

/**
 * FPP-1 (2026-09-20) — mid-year cutover invariant.
 *
 * When the Club is in MID_YEAR_MIGRATION mode for `taxYear`, the
 * opening balance's `throughPayDate` MUST be strictly less than the
 * declared `firstSpectrePayDate`. `throughPayDate === firstSpectrePayDate`
 * would double-count the first Spectre payroll (once as history, once as
 * a POSTED batch). `throughPayDate > firstSpectrePayDate` would either
 * bury a real Spectre-generated batch inside the "history" bucket or
 * silently skip it in the aggregator's window.
 *
 * Enforced server-side on both draft creation and activation so the
 * UI cannot bypass by editing values then jumping straight to Activate.
 * ZERO_OPENING_YTD and clubs with no declaration are exempt (a Club
 * with no declaration is by definition not in mid-year cutover).
 */
async function assertThroughPayDateBeforeFirstSpectrePayDate(
  clubId: string,
  taxYear: number,
  throughPayDate: Date,
): Promise<void> {
  const decl = await prisma.payrollImplementationDeclaration.findUnique({
    where: { clubId_taxYear: { clubId, taxYear } },
    select: { mode: true, firstSpectrePayDate: true },
  });
  if (!decl) return;
  if (decl.mode !== "MID_YEAR_MIGRATION") return;
  if (!decl.firstSpectrePayDate) return;
  const cutover = new Date(throughPayDate);
  const firstPay = new Date(decl.firstSpectrePayDate);
  cutover.setUTCHours(0, 0, 0, 0);
  firstPay.setUTCHours(0, 0, 0, 0);
  if (cutover.getTime() >= firstPay.getTime()) {
    throw new ValidationError([
      {
        path: "throughPayDate",
        message:
          `throughPayDate (${cutover.toISOString().slice(0, 10)}) must be strictly BEFORE the Club's first Spectre pay date (${firstPay.toISOString().slice(0, 10)}). ` +
          `Enter balances accumulated through the final payroll BEFORE Spectre's first payroll — do not include the first Spectre pay run in the opening YTD.`,
      },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Draft (import / manual)
// ---------------------------------------------------------------------------

export interface CreateDraftOpeningBalanceInput {
  employeeId: string;
  taxYear: number;
  values: OpeningBalanceFields;
  /**
   * Payroll-3B-5B-2 pre-calc gate — REQUIRED cutover boundary.
   * The date on/before which the opening balance is cumulative.
   * The YTD aggregator will include Spectre POSTED batches with
   * strict `payDate > throughPayDate` (and same taxYear). The
   * date MUST be in the same tax year as `taxYear`.
   */
  throughPayDate: Date;
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
  requirePermission(principal, clubId, "payroll:opening-balance:write");
  await assertPostingAllowed(principal, clubId, "payroll.opening-balance.draft", ENTITY, input.employeeId);
  await assertTenantEmployee(clubId, input.employeeId);
  assertValidNumerics(input.values);

  if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > 2100) {
    throw new ValidationError([{ path: "taxYear", message: "Invalid tax year." }]);
  }

  // Payroll-3B-5B-2 pre-calc gate (§6) — cutover boundary is required
  // and must live in the same tax year as the balance itself. Refuse
  // silently absent / cross-year / non-Date values loudly here so a
  // malformed importer or UI cannot bypass the invariant.
  if (!(input.throughPayDate instanceof Date) || Number.isNaN(input.throughPayDate.getTime())) {
    throw new ValidationError([
      { path: "throughPayDate", message: "throughPayDate is required — the cutover date on/before which this opening balance is cumulative." },
    ]);
  }
  if (input.throughPayDate.getUTCFullYear() !== input.taxYear) {
    throw new ValidationError([
      {
        path: "throughPayDate",
        message: `throughPayDate (${input.throughPayDate.toISOString().slice(0, 10)}) must be in the same tax year as taxYear (${input.taxYear}).`,
      },
    ]);
  }
  // FPP-1 (2026-09-20) — mid-year cutover invariant.
  await assertThroughPayDateBeforeFirstSpectrePayDate(clubId, input.taxYear, input.throughPayDate);

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
        throughPayDate: input.throughPayDate,
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
      after: {
        taxYear: input.taxYear,
        employeeId: input.employeeId,
        importSource: input.importSource,
        throughPayDate: input.throughPayDate.toISOString().slice(0, 10),
      },
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
      throughPayDate: input.throughPayDate,
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
  requirePermission(principal, clubId, "payroll:opening-balance:write");
  const row = await prisma.payrollOpeningBalance.findFirst({ where: { id, clubId } });
  if (!row) throw new NotFoundError(ENTITY, id);
  if (row.status !== "DRAFT") {
    throw new ValidationError([{ path: "status", message: `Cannot validate; status is ${row.status}.` }]);
  }
  // FPP-1 (2026-09-20) — re-check mid-year cutover invariant in case
  // the declaration's firstSpectrePayDate has shifted since the draft
  // was written.
  if (row.throughPayDate) {
    await assertThroughPayDateBeforeFirstSpectrePayDate(clubId, row.taxYear, row.throughPayDate);
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
  requirePermission(principal, clubId, "payroll:opening-balance:write");
  await assertPostingAllowed(principal, clubId, "payroll.opening-balance.activate", ENTITY, id);

  const row = await prisma.payrollOpeningBalance.findFirst({ where: { id, clubId } });
  if (!row) throw new NotFoundError(ENTITY, id);
  if (row.status !== "VALIDATED" && row.status !== "DRAFT") {
    throw new ValidationError([{ path: "status", message: `Cannot activate; status is ${row.status}.` }]);
  }
  // FPP-1 (2026-09-20) — mid-year cutover invariant. Recheck at activation
  // so a draft cannot slip through when the declaration was tightened.
  if (row.throughPayDate) {
    await assertThroughPayDateBeforeFirstSpectrePayDate(clubId, row.taxYear, row.throughPayDate);
  }

  const result = await prisma.$transaction(async (tx) => {
    const active = await tx.payrollOpeningBalance.findFirst({
      where: { clubId, employeeId: row.employeeId, taxYear: row.taxYear, status: "ACTIVE" },
    });
    if (active) {
      // FPP-8B.1 (2026-09-22, §5-§9) — Opening YTD financial evidence is
      // immutable once a POSTED payroll depends on it. If any POSTED
      // PayrollBatch exists for (clubId, employeeId, taxYear) with a
      // payDate > active.throughPayDate, superseding the ACTIVE opening
      // would retroactively rewrite historical YTD used by that batch.
      // Refuse the supersede rather than silently corrupting history.
      const cutover = active.throughPayDate ?? new Date(active.taxYear, 0, 1);
      const dependantPosted = await tx.payrollBatch.findFirst({
        where: {
          clubId,
          status: "POSTED",
          employees: { some: { employeeId: row.employeeId } },
          payPeriod: { taxYear: row.taxYear, payDate: { gt: cutover } },
        },
        select: { id: true, payPeriod: { select: { payDate: true } } },
      });
      if (dependantPosted) {
        throw new ValidationError([{
          path: "openingBalance",
          message:
            `Cannot supersede ACTIVE opening balance ${active.id}: POSTED payroll ${dependantPosted.id} ` +
            `(payDate ${dependantPosted.payPeriod.payDate.toISOString().slice(0,10)}) ` +
            `already uses this opening as historical YTD input. Historical opening evidence is immutable once ` +
            `payrolls depend on it. Void the dependant payroll(s) via the reversal/correction workflow first.`,
        }]);
      }
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

// ---------------------------------------------------------------------------
// FPP-1 (2026-09-19) — PayrollOpeningBalanceComponent CRUD.
//
// The Payroll-3C-5 model already exists (schema.prisma) plus the
// getEmployeeComponentYtd aggregator (component-ytd.ts). What was
// missing is the founder-facing service to add / remove / list per-
// Component opening rows against a DRAFT parent PayrollOpeningBalance.
//
// Rules (mirrors §16 of the opening-balance brief):
//   1) Parent must be DRAFT — VALIDATED/ACTIVE/SUPERSEDED refuse.
//   2) Row is a frozen snapshot of PayrollComponent identity at insert
//      time (code / displayName / category / side / cashEffect).
//   3) @@unique([openingBalanceId, componentCode]) prevents duplicates;
//      the DB error is remapped to a friendly ValidationError.
//   4) Historically-inactive components MAY still be picked (§15) —
//      opening balances are HISTORY, not a live catalogue.
//   5) Audit every mutation.
// ---------------------------------------------------------------------------

export interface OpeningBalanceComponentView {
  id: string;
  clubId: string;
  openingBalanceId: string;
  sourceComponentId: string | null;
  componentCode: string;
  displayName: string;
  category: string;
  side: "EMPLOYEE" | "EMPLOYER";
  cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
  ytdAmount: string;
  ytdQuantity: string | null;
  notes: string | null;
  createdAt: Date;
}

const COMPONENT_ENTITY = "PayrollOpeningBalanceComponent";

function toComponentView(
  row: NonNullable<Awaited<ReturnType<typeof prisma.payrollOpeningBalanceComponent.findFirst>>>,
): OpeningBalanceComponentView {
  return {
    id: row.id,
    clubId: row.clubId,
    openingBalanceId: row.openingBalanceId,
    sourceComponentId: row.sourceComponentId,
    componentCode: row.componentCode,
    displayName: row.displayName,
    category: row.category,
    side: row.side as OpeningBalanceComponentView["side"],
    cashEffect: row.cashEffect as OpeningBalanceComponentView["cashEffect"],
    ytdAmount: row.ytdAmount.toString(),
    ytdQuantity: row.ytdQuantity != null ? row.ytdQuantity.toString() : null,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

async function loadDraftOpeningForComponentEdit(clubId: string, openingBalanceId: string) {
  const parent = await prisma.payrollOpeningBalance.findFirst({
    where: { id: openingBalanceId, clubId },
    select: { id: true, status: true },
  });
  if (!parent) throw new NotFoundError(ENTITY, openingBalanceId);
  if (parent.status !== "DRAFT") {
    throw new ValidationError([
      {
        path: "openingBalanceId",
        message: `Cannot edit component openings on a ${parent.status.toLowerCase()} opening balance. Only DRAFT parents accept component edits.`,
      },
    ]);
  }
  return parent;
}

export interface AddOpeningComponentBalanceInput {
  openingBalanceId: string;
  componentId: string;
  ytdAmount: string;
  ytdQuantity?: string | null;
  notes?: string | null;
}

export async function addOpeningComponentBalance(
  principal: Principal,
  clubId: string,
  input: AddOpeningComponentBalanceInput,
): Promise<OpeningBalanceComponentView> {
  requirePermission(principal, clubId, "payroll:opening-balance:write");
  await assertPostingAllowed(
    principal,
    clubId,
    "payroll.opening-balance.component.create",
    COMPONENT_ENTITY,
    input.openingBalanceId,
  );

  await loadDraftOpeningForComponentEdit(clubId, input.openingBalanceId);

  const componentId = String(input.componentId ?? "").trim();
  if (!componentId) {
    throw new ValidationError([{ path: "componentId", message: "componentId is required." }]);
  }

  if (!/^-?\d+(\.\d+)?$/.test(input.ytdAmount)) {
    throw new ValidationError([
      { path: "ytdAmount", message: `"${input.ytdAmount}" is not a valid decimal string.` },
    ]);
  }
  if (Number(input.ytdAmount) < 0) {
    throw new ValidationError([{ path: "ytdAmount", message: "ytdAmount must be zero or positive." }]);
  }

  if (input.ytdQuantity != null && input.ytdQuantity !== "") {
    if (!/^-?\d+(\.\d+)?$/.test(input.ytdQuantity)) {
      throw new ValidationError([
        { path: "ytdQuantity", message: `"${input.ytdQuantity}" is not a valid decimal string.` },
      ]);
    }
  }

  const component = await prisma.payrollComponent.findFirst({
    where: { id: componentId, clubId },
    select: {
      id: true, code: true, displayName: true, category: true,
      side: true, cashEffect: true, active: true,
    },
  });
  if (!component) {
    throw new ValidationError([
      { path: "componentId", message: "Component does not belong to this Club." },
    ]);
  }
  // §15 — inactive components are still selectable for HISTORICAL opening
  // balances. No refusal here.

  const dupe = await prisma.payrollOpeningBalanceComponent.findFirst({
    where: { openingBalanceId: input.openingBalanceId, componentCode: component.code },
    select: { id: true },
  });
  if (dupe) {
    throw new ValidationError([
      {
        path: "componentId",
        message: `Component "${component.code}" already has an opening balance on this row. Remove it first to change the amount.`,
      },
    ]);
  }

  const row = await prisma.payrollOpeningBalanceComponent.create({
    data: {
      clubId,
      openingBalanceId: input.openingBalanceId,
      sourceComponentId: component.id,
      componentCode: component.code,
      displayName: component.displayName,
      category: component.category,
      side: component.side,
      cashEffect: component.cashEffect,
      ytdAmount: input.ytdAmount,
      ytdQuantity:
        input.ytdQuantity != null && input.ytdQuantity !== "" ? input.ytdQuantity : null,
      notes: input.notes?.trim() || null,
    },
  });

  await audit(principal, {
    action: "payroll.opening-balance.component.create",
    entityType: COMPONENT_ENTITY,
    entityId: row.id,
    clubId,
    after: {
      openingBalanceId: input.openingBalanceId,
      componentCode: component.code,
      ytdAmount: input.ytdAmount,
    },
  });

  return toComponentView(row);
}

export async function removeOpeningComponentBalance(
  principal: Principal,
  clubId: string,
  openingComponentId: string,
): Promise<void> {
  requirePermission(principal, clubId, "payroll:opening-balance:write");

  const row = await prisma.payrollOpeningBalanceComponent.findFirst({
    where: { id: openingComponentId, clubId },
    select: { id: true, openingBalanceId: true, componentCode: true, ytdAmount: true },
  });
  if (!row) throw new NotFoundError(COMPONENT_ENTITY, openingComponentId);

  await assertPostingAllowed(
    principal,
    clubId,
    "payroll.opening-balance.component.delete",
    COMPONENT_ENTITY,
    row.id,
  );

  await loadDraftOpeningForComponentEdit(clubId, row.openingBalanceId);

  await prisma.payrollOpeningBalanceComponent.delete({ where: { id: row.id } });

  await audit(principal, {
    action: "payroll.opening-balance.component.delete",
    entityType: COMPONENT_ENTITY,
    entityId: row.id,
    clubId,
    before: {
      openingBalanceId: row.openingBalanceId,
      componentCode: row.componentCode,
      ytdAmount: row.ytdAmount.toString(),
    },
  });
}

export async function listOpeningComponentBalances(
  principal: Principal,
  clubId: string,
  openingBalanceId: string,
): Promise<OpeningBalanceComponentView[]> {
  requirePermission(principal, clubId, "payroll:read");
  const parent = await prisma.payrollOpeningBalance.findFirst({
    where: { id: openingBalanceId, clubId },
    select: { id: true },
  });
  if (!parent) throw new NotFoundError(ENTITY, openingBalanceId);
  const rows = await prisma.payrollOpeningBalanceComponent.findMany({
    where: { clubId, openingBalanceId },
    orderBy: [{ side: "asc" }, { category: "asc" }, { displayName: "asc" }],
  });
  return rows.map(toComponentView);
}

// ---------------------------------------------------------------------------
// FPP-2 (2026-09-20) — direct-edit of a component YTD amount.
//
// A payroll administrator MUST be able to change RRSP EE from $3,093.97 to
// $3,093.79 in place — without removing and re-adding the row. §16 lifecycle
// immutability is preserved: edits are DRAFT-only. Tenant isolation, decimal
// validation, and audit are enforced. Nothing about the component's frozen
// identity fields (code/displayName/category/side/cashEffect) is mutated.
// ---------------------------------------------------------------------------

export interface UpdateOpeningComponentBalanceInput {
  ytdAmount: string;
  ytdQuantity?: string | null;
  notes?: string | null;
}

export async function updateOpeningComponentBalance(
  principal: Principal,
  clubId: string,
  openingComponentId: string,
  input: UpdateOpeningComponentBalanceInput,
): Promise<OpeningBalanceComponentView> {
  requirePermission(principal, clubId, "payroll:opening-balance:write");

  const row = await prisma.payrollOpeningBalanceComponent.findFirst({
    where: { id: openingComponentId, clubId },
    select: {
      id: true, openingBalanceId: true, componentCode: true, ytdAmount: true,
    },
  });
  if (!row) throw new NotFoundError(COMPONENT_ENTITY, openingComponentId);

  await assertPostingAllowed(
    principal,
    clubId,
    "payroll.opening-balance.component.update",
    COMPONENT_ENTITY,
    row.id,
  );

  await loadDraftOpeningForComponentEdit(clubId, row.openingBalanceId);

  if (!/^-?\d+(\.\d+)?$/.test(input.ytdAmount)) {
    throw new ValidationError([
      { path: "ytdAmount", message: `"${input.ytdAmount}" is not a valid decimal string.` },
    ]);
  }
  if (Number(input.ytdAmount) < 0) {
    throw new ValidationError([{ path: "ytdAmount", message: "ytdAmount must be zero or positive." }]);
  }

  if (input.ytdQuantity != null && input.ytdQuantity !== "") {
    if (!/^-?\d+(\.\d+)?$/.test(input.ytdQuantity)) {
      throw new ValidationError([
        { path: "ytdQuantity", message: `"${input.ytdQuantity}" is not a valid decimal string.` },
      ]);
    }
  }

  const before = row.ytdAmount.toString();
  const updated = await prisma.payrollOpeningBalanceComponent.update({
    where: { id: row.id },
    data: {
      ytdAmount: input.ytdAmount,
      ytdQuantity:
        input.ytdQuantity != null && input.ytdQuantity !== "" ? input.ytdQuantity : null,
      notes: input.notes != null ? (input.notes.trim() || null) : undefined,
    },
  });

  await audit(principal, {
    action: "payroll.opening-balance.component.update",
    entityType: COMPONENT_ENTITY,
    entityId: row.id,
    clubId,
    before: { ytdAmount: before },
    after: {
      openingBalanceId: row.openingBalanceId,
      componentCode: row.componentCode,
      ytdAmount: input.ytdAmount,
    },
  });

  return toComponentView(updated);
}

// ---------------------------------------------------------------------------
// FPP-2 (2026-09-20) — atomic save of the entire Opening YTD position.
//
// The founder must be able to enter aggregate/statutory values AND per-
// component YTD amounts in ONE unified form, in either order, and click
// Save Draft ONCE. This service accepts the whole position and persists
// it in a single database transaction:
//
//   1) Upsert the parent DRAFT PayrollOpeningBalance (create if absent,
//      refresh if present — same idempotency as createDraftOpeningBalance).
//   2) For each supplied component entry: upsert the matching
//      PayrollOpeningBalanceComponent under the parent. A BLANK entry
//      (amount === "" or unspecified) is NOT persisted — meaningless
//      zero rows are not created. An entry that goes from populated to
//      blank REMOVES the row.
//   3) On any failure the whole thing rolls back — no partial state.
//
// DRAFT-only: refuses non-DRAFT parents (existing lifecycle immutability
// preserved). Never mutates ACTIVE/VALIDATED/SUPERSEDED rows. Only DRAFT
// parents accept component edits; VALIDATED requires validate step first.
// ---------------------------------------------------------------------------

export interface AtomicOpeningComponentEntry {
  /** PayrollComponent.id (tenant-scoped). Required. */
  componentId: string;
  /** Empty string / null / undefined means "not entered" — no row will be
   *  persisted. If a row previously existed for the same code, it is
   *  DELETED (component amount cleared). */
  ytdAmount: string | null | undefined;
  ytdQuantity?: string | null;
  notes?: string | null;
}

export interface SaveOpeningBalanceWithComponentsInput {
  employeeId: string;
  taxYear: number;
  values: OpeningBalanceFields;
  throughPayDate: Date;
  importSource?: string;
  notes?: string;
  priorPayrollKind?: PriorPayrollKind;
  priorEmployerId?: string | null;
  components: AtomicOpeningComponentEntry[];
}

/**
 * Atomically upsert the parent draft opening balance + its per-component
 * rows. Returns the (potentially newly-created) parent view and the final
 * component-view array. Every mutation is inside one Prisma transaction.
 */
export async function saveOpeningBalanceWithComponents(
  principal: Principal,
  clubId: string,
  input: SaveOpeningBalanceWithComponentsInput,
): Promise<{ parent: OpeningBalanceView; components: OpeningBalanceComponentView[] }> {
  requirePermission(principal, clubId, "payroll:opening-balance:write");
  await assertPostingAllowed(principal, clubId, "payroll.opening-balance.draft", ENTITY, input.employeeId);
  await assertTenantEmployee(clubId, input.employeeId);
  assertValidNumerics(input.values);

  if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > 2100) {
    throw new ValidationError([{ path: "taxYear", message: "Invalid tax year." }]);
  }
  if (!(input.throughPayDate instanceof Date) || Number.isNaN(input.throughPayDate.getTime())) {
    throw new ValidationError([
      { path: "throughPayDate", message: "throughPayDate is required." },
    ]);
  }
  if (input.throughPayDate.getUTCFullYear() !== input.taxYear) {
    throw new ValidationError([
      {
        path: "throughPayDate",
        message: `throughPayDate (${input.throughPayDate.toISOString().slice(0, 10)}) must be in the same tax year as taxYear (${input.taxYear}).`,
      },
    ]);
  }
  await assertThroughPayDateBeforeFirstSpectrePayDate(clubId, input.taxYear, input.throughPayDate);

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

  // Validate + normalize component entries. Empty entries are dropped
  // ("not entered" — the row is either not created or explicitly removed).
  interface NormalizedEntry {
    componentId: string;
    amount: string | null; // null = "delete row if present, do not create"
    quantity: string | null;
    notes: string | null;
  }
  const normalized: NormalizedEntry[] = [];
  const seenIds = new Set<string>();
  for (const raw of input.components ?? []) {
    const componentId = String(raw.componentId ?? "").trim();
    if (!componentId) continue;
    if (seenIds.has(componentId)) {
      throw new ValidationError([
        { path: "components", message: `Duplicate componentId "${componentId}" in submission.` },
      ]);
    }
    seenIds.add(componentId);
    const rawAmt = raw.ytdAmount == null ? "" : String(raw.ytdAmount).trim();
    let amount: string | null;
    if (rawAmt === "") {
      amount = null;
    } else {
      if (!/^-?\d+(\.\d+)?$/.test(rawAmt)) {
        throw new ValidationError([
          { path: `components.${componentId}.ytdAmount`, message: `"${rawAmt}" is not a valid decimal string.` },
        ]);
      }
      if (Number(rawAmt) < 0) {
        throw new ValidationError([
          { path: `components.${componentId}.ytdAmount`, message: "ytdAmount must be zero or positive." },
        ]);
      }
      amount = rawAmt;
    }
    let quantity: string | null = null;
    if (raw.ytdQuantity != null && raw.ytdQuantity !== "") {
      const q = String(raw.ytdQuantity).trim();
      if (!/^-?\d+(\.\d+)?$/.test(q)) {
        throw new ValidationError([
          { path: `components.${componentId}.ytdQuantity`, message: `"${q}" is not a valid decimal string.` },
        ]);
      }
      quantity = q;
    }
    normalized.push({
      componentId,
      amount,
      quantity,
      notes: raw.notes != null ? String(raw.notes).trim() || null : null,
    });
  }

  const decimalData: Record<string, string> = {};
  for (const f of NUMERIC_FIELDS) decimalData[f] = input.values[f];

  const result = await prisma.$transaction(async (tx) => {
    // Refuse if a non-DRAFT row already exists for the tuple that isn't
    // superseded. The parent must be DRAFT (create) OR a DRAFT already
    // exists (refresh in place). VALIDATED/ACTIVE rows can only be
    // superseded via the dedicated activation path — that's not this
    // service's job.
    const existing = await tx.payrollOpeningBalance.findFirst({
      where: { clubId, employeeId: input.employeeId, taxYear: input.taxYear, status: "DRAFT" },
    });

    let parent;
    if (existing) {
      parent = await tx.payrollOpeningBalance.update({
        where: { id: existing.id },
        data: {
          ...decimalData,
          throughPayDate: input.throughPayDate,
          importSource: input.importSource ?? existing.importSource,
          notes: input.notes ?? existing.notes,
          priorPayrollKind,
          priorEmployerId: input.priorEmployerId ?? existing.priorEmployerId,
          importedByUserId: principal.id,
          importedAt: new Date(),
        },
      });
    } else {
      // Refuse if a non-DRAFT row exists for the tuple — the caller has
      // to supersede it through the activation path, not silently create a
      // second parallel row.
      const nonDraft = await tx.payrollOpeningBalance.findFirst({
        where: {
          clubId,
          employeeId: input.employeeId,
          taxYear: input.taxYear,
          status: { in: ["VALIDATED", "ACTIVE"] },
        },
        select: { id: true, status: true },
      });
      if (nonDraft) {
        throw new ValidationError([
          {
            path: "status",
            message: `An opening balance for this employee is already ${nonDraft.status}. Use the supersede workflow to correct it.`,
          },
        ]);
      }
      parent = await tx.payrollOpeningBalance.create({
        data: {
          clubId,
          employeeId: input.employeeId,
          taxYear: input.taxYear,
          status: "DRAFT",
          ...decimalData,
          throughPayDate: input.throughPayDate,
          importSource: input.importSource ?? "MANUAL",
          notes: input.notes ?? null,
          priorPayrollKind,
          priorEmployerId: input.priorEmployerId ?? null,
          importedByUserId: principal.id,
          importedAt: new Date(),
        },
      });
    }

    // Component upserts. For each supplied entry:
    //   - amount === null  → delete any existing row for this componentCode.
    //   - amount === "..." → upsert row (create if absent, update ytdAmount).
    // Every component's identity (code/name/category/side/cashEffect) is
    // frozen at the moment of upsert from the current PayrollComponent row.
    const componentIds = normalized.map((n) => n.componentId);
    const components = componentIds.length
      ? await tx.payrollComponent.findMany({
          where: { id: { in: componentIds }, clubId },
          select: { id: true, code: true, displayName: true, category: true, side: true, cashEffect: true },
        })
      : [];
    const catalogueById = new Map(components.map((c) => [c.id, c]));
    for (const n of normalized) {
      const cat = catalogueById.get(n.componentId);
      if (!cat) {
        throw new ValidationError([
          { path: `components.${n.componentId}`, message: "Component does not belong to this Club." },
        ]);
      }
      const existingRow = await tx.payrollOpeningBalanceComponent.findFirst({
        where: { openingBalanceId: parent.id, componentCode: cat.code },
        select: { id: true },
      });
      if (n.amount == null) {
        if (existingRow) {
          await tx.payrollOpeningBalanceComponent.delete({ where: { id: existingRow.id } });
        }
        continue;
      }
      if (existingRow) {
        await tx.payrollOpeningBalanceComponent.update({
          where: { id: existingRow.id },
          data: {
            ytdAmount: n.amount,
            ytdQuantity: n.quantity,
            notes: n.notes,
          },
        });
      } else {
        await tx.payrollOpeningBalanceComponent.create({
          data: {
            clubId,
            openingBalanceId: parent.id,
            sourceComponentId: cat.id,
            componentCode: cat.code,
            displayName: cat.displayName,
            category: cat.category,
            side: cat.side,
            cashEffect: cat.cashEffect,
            ytdAmount: n.amount,
            ytdQuantity: n.quantity,
            notes: n.notes,
          },
        });
      }
    }

    const finalRows = await tx.payrollOpeningBalanceComponent.findMany({
      where: { clubId, openingBalanceId: parent.id },
      orderBy: [{ side: "asc" }, { category: "asc" }, { displayName: "asc" }],
    });

    return { parent, components: finalRows };
  });

  await audit(principal, {
    action: existing_marker(result.parent.createdAt, result.parent.updatedAt),
    entityType: ENTITY,
    entityId: result.parent.id,
    clubId,
    after: {
      taxYear: input.taxYear,
      employeeId: input.employeeId,
      componentCount: result.components.length,
    },
  });

  return {
    parent: toView(result.parent),
    components: result.components.map(toComponentView),
  };
}

function existing_marker(createdAt: Date, updatedAt: Date): string {
  const created = createdAt.getTime();
  const updated = updatedAt.getTime();
  return created === updated
    ? "payroll.opening-balance.draft.create-with-components"
    : "payroll.opening-balance.draft.save-with-components";
}

export { NUMERIC_FIELDS };
export type { Decimal };
