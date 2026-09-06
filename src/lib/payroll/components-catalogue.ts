// Payroll-3C-1 (2026-09-07) — Payroll Component catalogue service.
//
// Tenant-scoped library of every distinct compensation / benefit /
// deduction concept a Club operates. Downstream slices consume
// these definitions when preparing / calculating / posting payroll;
// 3C-1 itself only stores + reads them.
//
// Every write is audited. Reads are permission-gated (`payroll:read`).

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, hasPermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { NotFoundError, ValidationError } from "../errors";

const ENTITY = "PayrollComponent";
const ASSIGNMENT_ENTITY = "EmployeeRecurringPayrollComponent";

export const COMPONENT_CATEGORIES = [
  "REGULAR_EARNING",
  "ADDITIONAL_EARNING",
  "ALLOWANCE",
  "TAXABLE_BENEFIT",
  "NON_TAXABLE_BENEFIT",
  "EMPLOYER_CONTRIBUTION",
  "EMPLOYEE_DEDUCTION",
  "REIMBURSEMENT",
] as const;
export type ComponentCategory = (typeof COMPONENT_CATEGORIES)[number];

export const COMPONENT_SIDES = ["EMPLOYEE", "EMPLOYER"] as const;
export type ComponentSide = (typeof COMPONENT_SIDES)[number];

export const CALCULATION_METHODS = [
  "FIXED_AMOUNT",
  "PERCENT_OF_ELIGIBLE_EARNINGS",
] as const;
export type CalculationMethod = (typeof CALCULATION_METHODS)[number];

export const DISPLAY_SECTIONS = ["EARNINGS", "BENEFITS", "DEDUCTIONS"] as const;
export type DisplaySection = (typeof DISPLAY_SECTIONS)[number];

// Payroll-3C-2 (2026-09-07) — explicit cash-effect classifier that
// replaces the ambiguous 3C-1 `isCash` boolean.
//
//   INCREASES_NET_PAY  cash earnings/allowances (add to net)
//   DECREASES_NET_PAY  employee-side cash deductions (subtract from net)
//   NO_NET_PAY_EFFECT  non-cash benefits + all employer-side items
export const CASH_EFFECTS = [
  "INCREASES_NET_PAY",
  "DECREASES_NET_PAY",
  "NO_NET_PAY_EFFECT",
] as const;
export type CashEffect = (typeof CASH_EFFECTS)[number];

// Payroll-3C-2 (2026-09-07) — treatment provenance for the statutory
// flags. Only SPECTRE_LIBRARY entries are considered vetted; CUSTOM
// entries carry user-configured risk. 3C-3 adds CUSTOM_TEST for
// synthetic fixtures whose treatment must not be confused with a
// real production tenant's CUSTOM configuration.
export const STATUTORY_TREATMENT_SOURCES = ["SPECTRE_LIBRARY", "CUSTOM", "CUSTOM_TEST"] as const;
export type StatutoryTreatmentSource = (typeof STATUTORY_TREATMENT_SOURCES)[number];

// Payroll-3C-3 (2026-09-08) — directional statutory effect on a base.
export const STATUTORY_EFFECTS = ["ADD", "SUBTRACT", "NONE"] as const;
export type StatutoryEffect = (typeof STATUTORY_EFFECTS)[number];

// Payroll-3C-3 (2026-09-08) — WHAT a PERCENT component is a
// percentage of. Enum-shaped so no free-form formulas can leak in.
export const ELIGIBLE_EARNINGS_BASES = ["REGULAR_EARNINGS_ONLY", "CASH_EARNINGS"] as const;
export type EligibleEarningsBase = (typeof ELIGIBLE_EARNINGS_BASES)[number];

export interface UpsertComponentInput {
  code:                  string;
  displayName:           string;
  description?:          string | null;
  category:              ComponentCategory;
  side:                  ComponentSide;
  cashEffect:            CashEffect;
  // Payroll-3C-3 (2026-09-08) — directional statutory effects.
  taxableEffect:         StatutoryEffect;
  cppPensionableEffect:  StatutoryEffect;
  eiInsurableEffect:     StatutoryEffect;
  calculationMethod:     CalculationMethod;
  // Required when calculationMethod === "PERCENT_OF_ELIGIBLE_EARNINGS";
  // must be null / omitted for FIXED_AMOUNT.
  eligibleEarningsBase?: EligibleEarningsBase | null;
  statutoryTreatmentSource?: StatutoryTreatmentSource;
  // Payroll-3C-3C (2026-09-09) — SPECTRE_LIBRARY provenance.
  // Required when statutoryTreatmentSource === "SPECTRE_LIBRARY".
  statutoryRuleKey?:     string | null;
  statutoryRuleVariant?: string | null;
  // Payroll-3C-3D (2026-09-09) — T4127 tax-formula deduction input.
  //   null                       — no tax-formula effect (default)
  //   "RRSP_DEDUCTED_AT_SOURCE"  — resolved amount feeds F on federal + Alberta calcs
  //   (future) "REGISTERED_PENSION_PLAN" | "UNION_DUES" | "PRESCRIBED_ZONE" | "AUTHORIZED_OTHER_DEDUCTION"
  taxFormulaDeductionType?: string | null;
  glAccountId?:          string | null;
  // Payroll-3C-6 (2026-09-05) — component-aware GL mapping.
  //   expenseAccountId    — debited when the component creates an
  //                         employer cost (cash earning, employer
  //                         contribution, non-cash taxable benefit).
  //   liabilityAccountId  — credited when the component creates a
  //                         liability (employee deduction, employer
  //                         benefit payable).
  // Both are OPTIONAL — the GL readiness evaluator refuses to post
  // a batch whose components lack the side they need for their
  // side/cashEffect combination.
  expenseAccountId?:     string | null;
  liabilityAccountId?:   string | null;
  displaySection:        DisplaySection;
  displayOrder?:         number;
  active?:               boolean;
  notes?:                string | null;
}

export interface UpsertRecurringComponentInput {
  employeeId:    string;
  componentId:   string;
  amount?:       string | number | null;
  percentBps?:   number | null;
  effectiveFrom: Date;
  effectiveTo?:  Date | null;
  active?:       boolean;
  notes?:        string | null;
}

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------
function requireCode(code: string) {
  const trimmed = (code ?? "").trim();
  if (!trimmed || trimmed.length > 64 || !/^[A-Z][A-Z0-9_]*$/.test(trimmed)) {
    throw new ValidationError([
      { path: "code", message: "code must be UPPER_SNAKE_CASE (letters, digits, underscore) and ≤ 64 chars." },
    ]);
  }
  return trimmed;
}
function requireOneOf<T extends string>(field: string, value: string, set: readonly T[]): T {
  if (!set.includes(value as T)) {
    throw new ValidationError([{ path: field, message: `${field} must be one of ${set.join(", ")}` }]);
  }
  return value as T;
}
function validateStatutoryFlagCoherence(input: UpsertComponentInput) {
  // A REGULAR_EARNING is by construction a cash earning that grows
  // employee net pay. Refuse any other cash-effect here.
  if (input.category === "REGULAR_EARNING" && input.cashEffect !== "INCREASES_NET_PAY") {
    throw new ValidationError([{
      path: "cashEffect",
      message: "REGULAR_EARNING requires cashEffect=INCREASES_NET_PAY.",
    }]);
  }
  // An EMPLOYEE_DEDUCTION reduces employee net pay by construction.
  if (input.category === "EMPLOYEE_DEDUCTION" && input.cashEffect === "INCREASES_NET_PAY") {
    throw new ValidationError([{
      path: "cashEffect",
      message: "EMPLOYEE_DEDUCTION cannot increase net pay — use INCREASES_NET_PAY only on earnings.",
    }]);
  }
  // Employer-side items never change employee net (that would be
  // double-funding). This forbids the specific mistake of using
  // side=EMPLOYER + cashEffect=INCREASES_NET_PAY.
  if (input.side === "EMPLOYER" && input.cashEffect !== "NO_NET_PAY_EFFECT") {
    throw new ValidationError([{
      path: "cashEffect",
      message: "Employer-side components must have cashEffect=NO_NET_PAY_EFFECT (they never touch employee net).",
    }]);
  }
  if (input.category === "EMPLOYEE_DEDUCTION" && input.side !== "EMPLOYEE") {
    throw new ValidationError([{ path: "side", message: "EMPLOYEE_DEDUCTION requires side=EMPLOYEE." }]);
  }
  if (input.category === "EMPLOYER_CONTRIBUTION" && input.side !== "EMPLOYER") {
    throw new ValidationError([{ path: "side", message: "EMPLOYER_CONTRIBUTION requires side=EMPLOYER." }]);
  }
}

// ---------------------------------------------------------------------
// Catalogue writes
// ---------------------------------------------------------------------
export async function upsertPayrollComponent(
  principal: Principal, clubId: string, input: UpsertComponentInput,
): Promise<{ id: string; code: string; createdOrUpdated: "created" | "updated" }> {
  requirePermission(principal, clubId, "payroll:write");

  const code = requireCode(input.code);
  requireOneOf("category", input.category, COMPONENT_CATEGORIES);
  requireOneOf("side", input.side, COMPONENT_SIDES);
  requireOneOf("cashEffect", input.cashEffect, CASH_EFFECTS);
  requireOneOf("taxableEffect",        input.taxableEffect,        STATUTORY_EFFECTS);
  requireOneOf("cppPensionableEffect", input.cppPensionableEffect, STATUTORY_EFFECTS);
  requireOneOf("eiInsurableEffect",    input.eiInsurableEffect,    STATUTORY_EFFECTS);
  requireOneOf("calculationMethod", input.calculationMethod, CALCULATION_METHODS);
  requireOneOf("displaySection", input.displaySection, DISPLAY_SECTIONS);
  const treatmentSource = input.statutoryTreatmentSource ?? "CUSTOM";
  requireOneOf("statutoryTreatmentSource", treatmentSource, STATUTORY_TREATMENT_SOURCES);

  // Payroll-3C-3: eligibleEarningsBase is REQUIRED for PERCENT
  // components and FORBIDDEN for FIXED_AMOUNT (§7 + §8).
  const eligibleBase = input.eligibleEarningsBase ?? null;
  if (input.calculationMethod === "PERCENT_OF_ELIGIBLE_EARNINGS") {
    if (!eligibleBase) {
      throw new ValidationError([{
        path: "eligibleEarningsBase",
        message: "PERCENT_OF_ELIGIBLE_EARNINGS requires an eligibleEarningsBase (REGULAR_EARNINGS_ONLY | CASH_EARNINGS).",
      }]);
    }
    requireOneOf("eligibleEarningsBase", eligibleBase, ELIGIBLE_EARNINGS_BASES);
  } else if (eligibleBase != null) {
    throw new ValidationError([{
      path: "eligibleEarningsBase",
      message: "FIXED_AMOUNT components must not carry an eligibleEarningsBase.",
    }]);
  }
  if (!input.displayName || input.displayName.trim().length === 0) {
    throw new ValidationError([{ path: "displayName", message: "displayName is required." }]);
  }
  validateStatutoryFlagCoherence(input);

  // Payroll-3C-3C (2026-09-09) — SPECTRE_LIBRARY provenance guard.
  // A component may only claim SPECTRE_LIBRARY when a matching rule
  // resolves in the code-defined library. Directional effects must
  // also match the rule to prevent silent divergence between the
  // library and the component's inline flags.
  let ruleKey    = input.statutoryRuleKey    ?? null;
  let ruleVariant = input.statutoryRuleVariant ?? null;
  if (treatmentSource === "SPECTRE_LIBRARY") {
    if (!ruleKey) {
      throw new ValidationError([{
        path: "statutoryRuleKey",
        message: "SPECTRE_LIBRARY components must reference a statutoryRuleKey.",
      }]);
    }
    const { assertLibraryRuleResolves } = await import("./statutory-library");
    const rule = assertLibraryRuleResolves({
      ruleKey,
      variant: (ruleVariant ?? undefined) as never,
      jurisdiction: { country: "CA" },
      asOf: new Date(),
    });
    if (rule.taxableEffect !== input.taxableEffect ||
        rule.cppPensionableEffect !== input.cppPensionableEffect ||
        rule.eiInsurableEffect !== input.eiInsurableEffect) {
      throw new ValidationError([{
        path: "statutoryEffects",
        message:
          `Component effects diverge from SPECTRE_LIBRARY rule ${rule.ruleKey} v${rule.version}: ` +
          `rule requires taxable=${rule.taxableEffect} cpp=${rule.cppPensionableEffect} ei=${rule.eiInsurableEffect}. ` +
          `Refusing to persist mismatched inline effects.`,
      }]);
    }
    ruleVariant = ruleVariant ?? rule.variant;
  } else {
    // Non-library components must NOT carry rule provenance.
    ruleKey = null; ruleVariant = null;
  }

  // Optional GL account must belong to this club.
  if (input.glAccountId) {
    const acct = await prisma.account.findFirst({
      where: { id: input.glAccountId, clubId }, select: { id: true },
    });
    if (!acct) {
      throw new ValidationError([{ path: "glAccountId", message: "GL account is not in this club's chart." }]);
    }
  }
  // Payroll-3C-6 — component-aware GL mapping must be tenant-scoped.
  // Same validation shape as glAccountId; type-appropriateness is a
  // read-time concern for the GL readiness evaluator, not this write.
  for (const [field, value] of [
    ["expenseAccountId",   input.expenseAccountId] as const,
    ["liabilityAccountId", input.liabilityAccountId] as const,
  ]) {
    if (value) {
      const acct = await prisma.account.findFirst({
        where: { id: value, clubId }, select: { id: true, isActive: true, type: true },
      });
      if (!acct) {
        throw new ValidationError([{ path: field, message: `${field} is not in this club's chart.` }]);
      }
    }
  }

  const existing = await prisma.payrollComponent.findUnique({
    where: { clubId_code: { clubId, code } }, select: { id: true },
  });

  const data = {
    displayName:           input.displayName.trim(),
    description:           input.description ?? null,
    category:              input.category,
    side:                  input.side,
    cashEffect:            input.cashEffect,
    taxableEffect:         input.taxableEffect,
    cppPensionableEffect:  input.cppPensionableEffect,
    eiInsurableEffect:     input.eiInsurableEffect,
    calculationMethod:     input.calculationMethod,
    eligibleEarningsBase:  eligibleBase,
    statutoryTreatmentSource: treatmentSource,
    statutoryRuleKey:     ruleKey,
    statutoryRuleVariant: ruleVariant,
    // Payroll-3C-3D — persist the tax-formula deduction stamp.
    taxFormulaDeductionType: input.taxFormulaDeductionType ?? null,
    glAccountId:           input.glAccountId ?? null,
    // Payroll-3C-6 — component-aware GL mapping (live catalogue values).
    // Snapshotted onto every PayrollBatchComponentSnapshot at PREPARE.
    expenseAccountId:      input.expenseAccountId   ?? null,
    liabilityAccountId:    input.liabilityAccountId ?? null,
    displaySection:        input.displaySection,
    displayOrder:          input.displayOrder ?? 0,
    active:                input.active ?? true,
    notes:                 input.notes ?? null,
  };

  let id: string; let createdOrUpdated: "created" | "updated";
  if (existing) {
    await prisma.payrollComponent.update({ where: { id: existing.id }, data });
    id = existing.id; createdOrUpdated = "updated";
  } else {
    const row = await prisma.payrollComponent.create({
      data: { clubId, code, ...data, createdByUserId: principal.id },
    });
    id = row.id; createdOrUpdated = "created";
  }

  await audit(principal, {
    clubId, action: `payroll.component.${createdOrUpdated === "created" ? "create" : "update"}`,
    entityType: ENTITY, entityId: id,
    after: {
      code, category: input.category, side: input.side,
      cashEffect: input.cashEffect,
      taxableEffect: input.taxableEffect,
      cppPensionableEffect: input.cppPensionableEffect,
      eiInsurableEffect: input.eiInsurableEffect,
      calculationMethod: input.calculationMethod,
      eligibleEarningsBase: eligibleBase,
      statutoryTreatmentSource: treatmentSource,
      displaySection: input.displaySection, active: data.active,
    },
  });

  return { id, code, createdOrUpdated };
}

// ---------------------------------------------------------------------
// Catalogue reads
// ---------------------------------------------------------------------
export async function listPayrollComponents(
  principal: Principal, clubId: string, opts?: { includeInactive?: boolean },
) {
  requirePermission(principal, clubId, "payroll:read");
  const rows = await prisma.payrollComponent.findMany({
    where: { clubId, ...(opts?.includeInactive ? {} : { active: true }) },
    orderBy: [{ displaySection: "asc" }, { displayOrder: "asc" }, { displayName: "asc" }],
    // Payroll-3C-6 — surface GL mapping so the components setup
    // page can render an at-a-glance readiness column per row.
    include: {
      expenseAccount:   { select: { accountNumber: true } },
      liabilityAccount: { select: { accountNumber: true } },
    },
  });
  return rows.map((r) => ({
    ...r,
    expenseAccountNumber:   r.expenseAccount?.accountNumber   ?? null,
    liabilityAccountNumber: r.liabilityAccount?.accountNumber ?? null,
  }));
}

export async function getPayrollComponent(
  principal: Principal, clubId: string, id: string,
) {
  requirePermission(principal, clubId, "payroll:read");
  const row = await prisma.payrollComponent.findUnique({
    where: { id }, include: { assignments: false },
  });
  if (!row) throw new NotFoundError(ENTITY, id);
  assertTenantOwned(row, principal);
  if (row.clubId !== clubId) throw new NotFoundError(ENTITY, id);
  return row;
}

// ---------------------------------------------------------------------
// Employee recurring-assignment writes
// ---------------------------------------------------------------------
function validateAssignmentInputs(input: UpsertRecurringComponentInput, method: CalculationMethod) {
  if (method === "FIXED_AMOUNT") {
    if (input.amount == null) {
      throw new ValidationError([{ path: "amount", message: "FIXED_AMOUNT requires a non-null dollar amount." }]);
    }
    if (input.percentBps != null) {
      throw new ValidationError([{ path: "percentBps", message: "FIXED_AMOUNT must not carry percentBps." }]);
    }
  } else if (method === "PERCENT_OF_ELIGIBLE_EARNINGS") {
    if (input.percentBps == null) {
      throw new ValidationError([{ path: "percentBps", message: "PERCENT method requires percentBps (e.g. 500 = 5.00%)." }]);
    }
    if (input.percentBps < 0 || input.percentBps > 100_00) {
      throw new ValidationError([{ path: "percentBps", message: "percentBps must be between 0 and 10000 (0% – 100%)." }]);
    }
    if (input.amount != null) {
      throw new ValidationError([{ path: "amount", message: "PERCENT method must not carry a fixed dollar amount." }]);
    }
  }
  if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) {
    throw new ValidationError([{
      path: "effectiveTo",
      message: "effectiveTo must be strictly after effectiveFrom.",
    }]);
  }
}

export async function createRecurringComponentAssignment(
  principal: Principal, clubId: string, input: UpsertRecurringComponentInput,
): Promise<{ id: string }> {
  requirePermission(principal, clubId, "payroll:write");

  const component = await prisma.payrollComponent.findUnique({
    where: { id: input.componentId }, select: { id: true, clubId: true, code: true, calculationMethod: true, active: true },
  });
  if (!component || component.clubId !== clubId) {
    throw new ValidationError([{ path: "componentId", message: "Component not found in this club." }]);
  }
  if (!component.active) {
    throw new ValidationError([{ path: "componentId", message: "Component is inactive; reactivate before assigning." }]);
  }
  const employee = await prisma.employee.findUnique({
    where: { id: input.employeeId }, select: { id: true, clubId: true, firstName: true, lastName: true },
  });
  if (!employee || employee.clubId !== clubId) {
    throw new ValidationError([{ path: "employeeId", message: "Employee not found in this club." }]);
  }
  validateAssignmentInputs(input, component.calculationMethod as CalculationMethod);

  const row = await prisma.employeeRecurringPayrollComponent.create({
    data: {
      clubId,
      employeeId: input.employeeId,
      componentId: input.componentId,
      amount: input.amount != null ? String(input.amount) : null,
      percentBps: input.percentBps ?? null,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      active: input.active ?? true,
      notes: input.notes ?? null,
      createdByUserId: principal.id,
    },
    select: { id: true },
  });

  await audit(principal, {
    clubId, action: "payroll.component.assign", entityType: ASSIGNMENT_ENTITY, entityId: row.id,
    after: {
      employeeId: input.employeeId, componentCode: component.code,
      effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null,
    },
  });

  return row;
}

export async function endRecurringComponentAssignment(
  principal: Principal, clubId: string, id: string, effectiveTo: Date,
) {
  requirePermission(principal, clubId, "payroll:write");
  const row = await prisma.employeeRecurringPayrollComponent.findUnique({ where: { id } });
  if (!row) throw new NotFoundError(ASSIGNMENT_ENTITY, id);
  assertTenantOwned(row, principal);
  if (row.clubId !== clubId) throw new NotFoundError(ASSIGNMENT_ENTITY, id);
  if (effectiveTo <= row.effectiveFrom) {
    throw new ValidationError([{ path: "effectiveTo", message: "effectiveTo must be after effectiveFrom." }]);
  }
  await prisma.employeeRecurringPayrollComponent.update({
    where: { id }, data: { effectiveTo, active: false },
  });
  await audit(principal, {
    clubId, action: "payroll.component.assign.end", entityType: ASSIGNMENT_ENTITY, entityId: id,
    after: { effectiveTo },
  });
}

// ---------------------------------------------------------------------
// Employee recurring-assignment reads
// ---------------------------------------------------------------------
export async function listActiveEmployeeComponentAssignments(
  principal: Principal, clubId: string, employeeId: string, asOf?: Date,
) {
  requirePermission(principal, clubId, "payroll:read");
  const when = asOf ?? new Date();
  const rows = await prisma.employeeRecurringPayrollComponent.findMany({
    where: {
      clubId, employeeId,
      effectiveFrom: { lte: when },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: when } }],
      active: true,
      component: { active: true },
    },
    include: { component: true },
    orderBy: [{ effectiveFrom: "asc" }],
  });
  return rows;
}

/**
 * Feature-gate — returns true when the current build should expose
 * the 3C-1 Payroll Components surfaces. Kept function-shaped so a
 * later slice can wire a real flag without a mass find-replace.
 */
export function payrollComponentsEnabled(principal: Principal, clubId: string): boolean {
  return hasPermission(principal, clubId, "payroll:read");
}
