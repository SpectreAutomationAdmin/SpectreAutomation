// v-slice-1-followup-7 (2026-09-15) — Payroll implementation cutover.
//
// A Club must EXPLICITLY declare its payroll implementation position
// for each tax year before Prepare/Calculate will consume payroll for
// that year. Absence of a confirmed declaration is itself a blocker —
// Spectre must never silently assume zero prior YTD.
//
// Two modes:
//   ZERO_OPENING_YTD    — no prior same-employer payroll exists in
//                         this tax year for the affected employees.
//                         Spectre may assume zero opening YTD without
//                         requiring per-employee entry.
//   MID_YEAR_MIGRATION  — Club processed payroll before Spectre in
//                         this tax year. Each employee included in
//                         a batch's period must have an ACTIVE
//                         PayrollOpeningBalance for the tax year.
//
// Service contract:
//   * declare(): idempotent upsert. Confirms atomically at write time.
//   * revoke(): unconfirms (allows re-declaration during setup).
//   * get(): read for a (clubId, taxYear).
//   * requiresMidYearOpeningBalances(): boolean helper used by the
//     Prepare/Calculate gate.
//
// Every write audits: `payroll.implementation.declare` /
// `payroll.implementation.revoke`. Callers must hold
// `payroll:config:write` and pass the posting-guard gate.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertSensitiveActionAllowed } from "../posting-guard";
import { ValidationError, NotFoundError } from "../errors";

const ENTITY = "PayrollImplementationDeclaration";

export type ImplementationMode = "ZERO_OPENING_YTD" | "MID_YEAR_MIGRATION";

export function isImplementationMode(v: string): v is ImplementationMode {
  return v === "ZERO_OPENING_YTD" || v === "MID_YEAR_MIGRATION";
}

export interface DeclareImplementationInput {
  taxYear: number;
  mode: ImplementationMode;
  firstSpectrePayDate?: Date | null;
  notes?: string | null;
}

export interface ImplementationDeclarationView {
  id: string;
  clubId: string;
  taxYear: number;
  mode: ImplementationMode;
  firstSpectrePayDate: Date | null;
  confirmedAt: Date | null;
  confirmedByUserId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function normaliseTaxYear(y: number): number {
  if (!Number.isInteger(y) || y < 2020 || y > 2100) {
    throw new ValidationError([{ path: "taxYear", message: `taxYear must be a 4-digit year in [2020..2100]; got ${y}.` }]);
  }
  return y;
}

/**
 * Read the current declaration for (clubId, taxYear). Returns null when
 * the Club has never declared its position for this tax year.
 */
export async function getImplementationDeclaration(
  principal: Principal,
  clubId: string,
  taxYear: number,
): Promise<ImplementationDeclarationView | null> {
  requirePermission(principal, clubId, "payroll:config:read");
  const row = await prisma.payrollImplementationDeclaration.findUnique({
    where: { clubId_taxYear: { clubId, taxYear: normaliseTaxYear(taxYear) } },
  });
  if (!row) return null;
  return toView(row);
}

/** Upsert (create-or-update) + atomically confirm. Idempotent on the
 *  same (clubId, taxYear, mode). Every call rewrites confirmedAt +
 *  confirmedByUserId to the acting principal, so audit trails the most
 *  recent decision-maker. */
export async function declareImplementation(
  principal: Principal,
  clubId: string,
  input: DeclareImplementationInput,
): Promise<ImplementationDeclarationView> {
  requirePermission(principal, clubId, "payroll:config:write");
  const taxYear = normaliseTaxYear(input.taxYear);
  if (!isImplementationMode(input.mode)) {
    throw new ValidationError([{
      path: "mode",
      message: `mode must be "ZERO_OPENING_YTD" or "MID_YEAR_MIGRATION"; got ${JSON.stringify(input.mode)}.`,
    }]);
  }
  if (input.mode === "MID_YEAR_MIGRATION" && !input.firstSpectrePayDate) {
    throw new ValidationError([{
      path: "firstSpectrePayDate",
      message: "firstSpectrePayDate is required for MID_YEAR_MIGRATION — this is the Club's first Spectre pay date.",
    }]);
  }
  await assertSensitiveActionAllowed(
    principal, clubId, "payroll.implementation.declare", ENTITY, `${clubId}:${taxYear}`,
  );

  const before = await prisma.payrollImplementationDeclaration.findUnique({
    where: { clubId_taxYear: { clubId, taxYear } },
  });

  const now = new Date();
  const upserted = await prisma.payrollImplementationDeclaration.upsert({
    where: { clubId_taxYear: { clubId, taxYear } },
    create: {
      clubId, taxYear, mode: input.mode,
      firstSpectrePayDate: input.firstSpectrePayDate ?? null,
      confirmedAt: now,
      confirmedByUserId: principal.id,
      notes: input.notes ?? null,
    },
    update: {
      mode: input.mode,
      firstSpectrePayDate: input.firstSpectrePayDate ?? null,
      confirmedAt: now,
      confirmedByUserId: principal.id,
      notes: input.notes ?? null,
    },
  });

  await audit(principal, {
    action: "payroll.implementation.declare",
    entityType: ENTITY,
    entityId: upserted.id,
    clubId,
    before: before
      ? {
          mode: before.mode,
          firstSpectrePayDate: before.firstSpectrePayDate?.toISOString() ?? null,
          confirmedByUserId: before.confirmedByUserId,
        }
      : null,
    after: {
      mode: upserted.mode,
      firstSpectrePayDate: upserted.firstSpectrePayDate?.toISOString() ?? null,
      confirmedByUserId: upserted.confirmedByUserId,
      taxYear: upserted.taxYear,
    },
  });

  return toView(upserted);
}

/** Unconfirm — the row is retained (audit history) but confirmedAt/By
 *  are cleared. Prepare/Calculate will treat the club as unimplemented
 *  for this tax year until a fresh declare(). */
export async function revokeImplementationDeclaration(
  principal: Principal,
  clubId: string,
  taxYear: number,
): Promise<ImplementationDeclarationView> {
  requirePermission(principal, clubId, "payroll:config:write");
  const y = normaliseTaxYear(taxYear);
  const row = await prisma.payrollImplementationDeclaration.findUnique({
    where: { clubId_taxYear: { clubId, taxYear: y } },
  });
  if (!row) throw new NotFoundError(ENTITY, `${clubId}:${y}`);
  await assertSensitiveActionAllowed(
    principal, clubId, "payroll.implementation.revoke", ENTITY, row.id,
  );
  const updated = await prisma.payrollImplementationDeclaration.update({
    where: { id: row.id },
    data: { confirmedAt: null, confirmedByUserId: null },
  });
  await audit(principal, {
    action: "payroll.implementation.revoke",
    entityType: ENTITY,
    entityId: updated.id,
    clubId,
    before: { confirmedAt: row.confirmedAt?.toISOString() ?? null, confirmedByUserId: row.confirmedByUserId },
    after: { confirmedAt: null, confirmedByUserId: null, taxYear: y },
  });
  return toView(updated);
}

/**
 * Prepare/Calculate readiness helper. Returns:
 *   { requiresOpeningBalances: boolean, hasDeclaration: boolean, mode: ... }
 *
 * Contract used by preparePayrollBatch (v-slice-1-followup-7):
 *   * `hasDeclaration === false` → blocker: "Payroll implementation
 *     not declared for tax year XXXX. Confirm in Payroll Settings →
 *     Payroll Implementation before running payroll."
 *   * `hasDeclaration === true && mode === "MID_YEAR_MIGRATION"` →
 *     each batch-included employee must have an ACTIVE
 *     PayrollOpeningBalance for the tax year; caller performs the
 *     per-employee check.
 *   * `hasDeclaration === true && mode === "ZERO_OPENING_YTD"` → no
 *     per-employee opening balances are required. Aggregator uses
 *     zero YTD by default.
 */
export async function readImplementationForCalculation(
  clubId: string,
  taxYear: number,
): Promise<{
  hasDeclaration: boolean;
  mode: ImplementationMode | null;
  requiresOpeningBalances: boolean;
  declaration: ImplementationDeclarationView | null;
}> {
  const y = normaliseTaxYear(taxYear);
  const row = await prisma.payrollImplementationDeclaration.findUnique({
    where: { clubId_taxYear: { clubId, taxYear: y } },
  });
  if (!row || row.confirmedAt == null) {
    return { hasDeclaration: false, mode: null, requiresOpeningBalances: false, declaration: null };
  }
  const mode = isImplementationMode(row.mode) ? row.mode : null;
  return {
    hasDeclaration: true,
    mode,
    requiresOpeningBalances: mode === "MID_YEAR_MIGRATION",
    declaration: toView(row),
  };
}

function toView(row: {
  id: string; clubId: string; taxYear: number; mode: string;
  firstSpectrePayDate: Date | null; confirmedAt: Date | null;
  confirmedByUserId: string | null; notes: string | null;
  createdAt: Date; updatedAt: Date;
}): ImplementationDeclarationView {
  const mode: ImplementationMode = isImplementationMode(row.mode) ? row.mode : "ZERO_OPENING_YTD";
  return {
    id: row.id,
    clubId: row.clubId,
    taxYear: row.taxYear,
    mode,
    firstSpectrePayDate: row.firstSpectrePayDate,
    confirmedAt: row.confirmedAt,
    confirmedByUserId: row.confirmedByUserId,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
