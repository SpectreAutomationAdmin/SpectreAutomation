// Payroll-3B-5B-3A (2026-09-01) — server-side Payroll Review DTO.
//
// Builds a strongly typed, sanitized view model for the Payroll
// Review workspace. Aggregation is Decimal-safe (no JS binary
// float in a reconciliation path). The `calculationExplanationJson`
// blob is translated into human-readable diagnostics before it
// leaves the server — encrypted refs, KMS material, SIN, and bank
// data are never included.
//
// The UI never re-runs a calculator; it consumes only persisted
// canonical values on `PayrollBatchEmployee`.

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { NotFoundError } from "../errors";
import { Decimal, roundCentsHalfUp, sum, toCentString, toDecimal } from "./statutory/decimal-money";

const ENTITY = "PayrollBatch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewBatchHeader {
  batchId:           string;
  clubId:            string;
  payGroupId:        string;
  payGroupCode:      string;
  payGroupName:      string;
  payPeriodId:       string;
  periodStartIso:    string;
  periodEndInclusiveIso: string;
  payDateIso:        string;
  taxYear:           number;
  status:            string;
  statusLabel:       string;
  employeeCount:     number;
  calculatedAtIso:   string | null;
  calculationVersion: number;
  algorithmVersion:  string | null;
  statutoryPackageVersion: string | null;
  statutoryPackageChecksum: string | null;
  workIntakeItemId:  string | null;
}

export interface ReviewBatchTotals {
  gross:                   string;
  employeeDeductions:      string;
  netPay:                  string;
  employerContributions:   string;
  totalEmployerCost:       string;
  reconciled:              boolean;
  reconciliation: {
    grossMinusDeductions:  string;
    netPay:                string;
    differenceCents:       number;
  };
  breakdown: {
    cppEE:            string;
    cpp2EE:           string;
    eiEE:             string;
    federalTax:       string;
    provincialTax:    string;
    additionalTax:    string;
    cppER:            string;
    cpp2ER:           string;
    eiER:             string;
  };
}

export interface ReviewEmployeeRow {
  batchEmployeeId:      string;
  employeeId:           string;
  displayName:          string;
  employeeNumber:       string | null;
  departmentLabel:      string | null;
  jurisdiction:         string;
  status:               string;
  hasBlockingException: boolean;
  hasWarning:           boolean;
  earningsGross:        string | null;
  earningsTaxable:      string | null;
  cppCombined:          string | null;
  cpp2:                 string | null;
  ei:                   string | null;
  federalTax:           string | null;
  provincialTax:        string | null;
  additionalTax:        string | null;
  totalDeductions:      string | null;
  netPay:               string | null;
}

export interface ReviewCalculationExplanation {
  algorithmVersion: string | null;
  packageVersion:   string | null;
  periodsPerYear:   number | null;
  pensionableMonths: number | null;
  earnings: {
    grossPay:            string;
    earningsTaxable:     string;
    earningsPensionable: string;
    earningsInsurable:   string;
  };
  cpp: {
    base:       string;
    firstAdd:   string;
    combined:   string;
    /** F5A: sum of first-additional CPP + CPP2 for this pay period — the deductible
     *  CPP additional-contribution amount that reduces taxable income (not a K-factor). */
    deductibleAdditional: string;
  };
  cpp2:                    string;
  ei:                      { employee: string; employer: string; };
  federal: {
    annualisedTaxableIncome:  string;
    annualisedGrossEmployment: string;
    federalClaimUsed:          string;
    claimZeroFederal:          boolean;
    bracketRate:               string;
    canadaEmploymentAmountCap: string;
    baseTax:                   string;
    additionalTax:             string;
    /** Advanced detail — bucket for founder / audit review. */
    advanced: {
      f5aAnnual: string; bpaf: string; T: string; K1: string; K2: string; K3: string; K4: string;
      T3Annual: string; T4PerPeriod: string;
    };
  };
  provincial: {
    annualisedTaxableIncome:   string;
    provincialClaimUsed:       string;
    claimZeroProvincial:       boolean;
    bracketRate:               string;
    baseTax:                   string;
    additionalTax:             string;
    /** Advanced detail. */
    advanced: {
      f5aAnnual: string; TP: string; K1P: string; K2P: string; K3P: string; K4P: string; K5P: string;
      T3PAnnual: string; T4PPerPeriod: string;
    };
  };
  totals: {
    totalEmployeeDeductions:  string;
    netPay:                   string;
  };
}

export interface ReviewEmployeeDetail extends ReviewEmployeeRow {
  earningLines: Array<{ earningType: string; label: string; quantity: string; rate: string; amount: string; }>;
  allowanceLines: Array<{ allowanceType: string; frequency: string; amount: string; taxable: boolean; pensionable: boolean; insurable: boolean; }>;
  employerContributions: {
    cppCombined: string | null;
    cpp2:        string | null;
    ei:          string | null;
  };
  exceptions: Array<{ severity: string; code: string; message: string; recommendedAction: string | null; }>;
  explanation: ReviewCalculationExplanation | null;
  ytdOpeningBalancePriorPayrollKind: string | null;
}

export interface ReviewBatch {
  header: ReviewBatchHeader;
  totals: ReviewBatchTotals;
  employees: ReviewEmployeeRow[];
  batchLevelExceptions: Array<{ severity: string; code: string; message: string; recommendedAction: string | null; }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function centsOf(d: Decimal | string | null | undefined): number {
  if (d == null) return 0;
  return Math.round(Number(toDecimal(d).toFixed(2)) * 100);
}

function statusLabelFor(status: string): string {
  switch (status) {
    case "DRAFT":                  return "Draft";
    case "PREPARED":               return "Prepared — awaiting calculation";
    case "CALCULATED":             return "Calculated — awaiting final approval";
    case "SUBMITTED_FOR_APPROVAL": return "Submitted for approval";
    case "APPROVED":               return "Approved";
    case "POSTED":                 return "Posted";
    case "VOIDED":                 return "Voided";
    default:                       return status;
  }
}

function humanEarningTypeLabel(t: string): string {
  switch (t) {
    case "REGULAR":      return "Regular hourly earnings";
    case "SALARY":       return "Salary";
    case "OVERTIME":     return "Overtime";
    case "VACATION":     return "Vacation pay";
    case "STAT_HOLIDAY": return "Statutory-holiday pay";
    case "COMMISSION":   return "Commission";
    case "BONUS":        return "Bonus";
    default:             return t;
  }
}

// ---------------------------------------------------------------------------
// Public services
// ---------------------------------------------------------------------------

/**
 * Batch review — header + Decimal-safe totals + one row per employee.
 * Requires `payroll:read`. Enforces tenant ownership on the batch.
 */
export async function getBatchReview(
  principal: Principal,
  clubId: string,
  batchId: string,
): Promise<ReviewBatch> {
  requirePermission(principal, clubId, "payroll:read");

  const batch = await prisma.payrollBatch.findUnique({
    where: { id: batchId },
    include: {
      payGroup:  true,
      payPeriod: true,
      statutoryPackage: true,
      employees: {
        include: { employee: true, exceptions: true },
        orderBy: [{ employee: { lastName: "asc" } }, { employee: { firstName: "asc" } }],
      },
      exceptions: { where: { batchEmployeeId: null } },
    },
  });
  if (!batch) throw new NotFoundError(ENTITY, batchId);
  assertTenantOwned(batch, principal);
  if (batch.clubId !== clubId) throw new NotFoundError(ENTITY, batchId);

  const header: ReviewBatchHeader = {
    batchId:                    batch.id,
    clubId:                     batch.clubId,
    payGroupId:                 batch.payGroupId,
    payGroupCode:               batch.payGroup.code,
    payGroupName:               batch.payGroup.name,
    payPeriodId:                batch.payPeriodId,
    periodStartIso:             batch.payPeriod.periodStart.toISOString(),
    periodEndInclusiveIso:      new Date(batch.payPeriod.periodEnd.getTime() - 86_400_000).toISOString(),
    payDateIso:                 batch.payPeriod.payDate.toISOString(),
    taxYear:                    batch.payPeriod.taxYear,
    status:                     batch.status,
    statusLabel:                statusLabelFor(batch.status),
    employeeCount:              batch.employees.length,
    calculatedAtIso:            batch.calculatedAt ? batch.calculatedAt.toISOString() : null,
    calculationVersion:         batch.calculationVersion,
    algorithmVersion:           batch.algorithmVersion,
    statutoryPackageVersion:    batch.statutoryPackage?.packageVersion ?? null,
    statutoryPackageChecksum:   batch.statutoryPackage?.checksum ?? null,
    workIntakeItemId:           batch.workIntakeItemId ?? null,
  };

  // Decimal-safe aggregation. Every line is a rounded persisted
  // Decimal already; sum via toDecimal → sum → toCentString for the
  // reconciliation invariant.
  const grossD    = sum(batch.employees.map((e) => toDecimal(e.grossPay ?? 0)));
  const cppEE_D   = sum(batch.employees.map((e) => toDecimal(e.deductionCppEeCombined ?? 0)));
  const cpp2EE_D  = sum(batch.employees.map((e) => toDecimal(e.deductionCpp2Ee ?? 0)));
  const eiEE_D    = sum(batch.employees.map((e) => toDecimal(e.deductionEiEe ?? 0)));
  const fedD      = sum(batch.employees.map((e) => toDecimal(e.deductionFederalTax ?? 0)));
  const provD     = sum(batch.employees.map((e) => toDecimal(e.deductionProvincialTax ?? 0)));
  const addFedD   = sum(batch.employees.map((e) => toDecimal(e.additionalFederalTax ?? 0)));
  const addProvD  = sum(batch.employees.map((e) => toDecimal(e.additionalProvincialTax ?? 0)));
  const netD      = sum(batch.employees.map((e) => toDecimal(e.netPay ?? 0)));
  const cppER_D   = sum(batch.employees.map((e) => toDecimal(e.employerCppCombined ?? 0)));
  const cpp2ER_D  = sum(batch.employees.map((e) => toDecimal(e.employerCpp2 ?? 0)));
  const eiER_D    = sum(batch.employees.map((e) => toDecimal(e.employerEi ?? 0)));

  const employeeDeductionsD = cppEE_D.plus(cpp2EE_D).plus(eiEE_D)
    .plus(fedD).plus(provD).plus(addFedD).plus(addProvD);
  const employerContributionsD = cppER_D.plus(cpp2ER_D).plus(eiER_D);

  const reconciliationLhs = roundCentsHalfUp(grossD.minus(employeeDeductionsD));
  const reconciliationRhs = roundCentsHalfUp(netD);
  const differenceCents   = centsOf(reconciliationLhs) - centsOf(reconciliationRhs);

  const totals: ReviewBatchTotals = {
    gross:                   toCentString(grossD),
    employeeDeductions:      toCentString(employeeDeductionsD),
    netPay:                  toCentString(netD),
    employerContributions:   toCentString(employerContributionsD),
    totalEmployerCost:       toCentString(grossD.plus(employerContributionsD)),
    reconciled:              differenceCents === 0,
    reconciliation: {
      grossMinusDeductions:  toCentString(reconciliationLhs),
      netPay:                toCentString(reconciliationRhs),
      differenceCents,
    },
    breakdown: {
      cppEE:         toCentString(cppEE_D),
      cpp2EE:        toCentString(cpp2EE_D),
      eiEE:          toCentString(eiEE_D),
      federalTax:    toCentString(fedD),
      provincialTax: toCentString(provD),
      additionalTax: toCentString(addFedD.plus(addProvD)),
      cppER:         toCentString(cppER_D),
      cpp2ER:        toCentString(cpp2ER_D),
      eiER:          toCentString(eiER_D),
    },
  };

  const employees: ReviewEmployeeRow[] = batch.employees.map((be) => {
    const emp = be.employee;
    const displayName = `${emp.firstName ?? ""} ${emp.lastName ?? ""}`.trim() || emp.email || emp.id;
    const additionalTax = toDecimal(be.additionalFederalTax ?? 0).plus(toDecimal(be.additionalProvincialTax ?? 0));
    return {
      batchEmployeeId:      be.id,
      employeeId:           be.employeeId,
      displayName,
      employeeNumber:       emp.employeeNumber ?? null,
      departmentLabel:      null,
      jurisdiction:         [be.jurisdictionCountry, be.jurisdictionProvince].filter(Boolean).join("/"),
      status:               be.status,
      hasBlockingException: be.exceptions.some((e) => e.severity === "BLOCKER"),
      hasWarning:           be.exceptions.some((e) => e.severity === "WARNING"),
      earningsGross:        be.grossPay ? be.grossPay.toString() : null,
      earningsTaxable:      be.earningsTaxable ? be.earningsTaxable.toString() : null,
      cppCombined:          be.deductionCppEeCombined ? be.deductionCppEeCombined.toString() : null,
      cpp2:                 be.deductionCpp2Ee ? be.deductionCpp2Ee.toString() : null,
      ei:                   be.deductionEiEe ? be.deductionEiEe.toString() : null,
      federalTax:           be.deductionFederalTax ? be.deductionFederalTax.toString() : null,
      provincialTax:        be.deductionProvincialTax ? be.deductionProvincialTax.toString() : null,
      additionalTax:        additionalTax.isZero() ? null : additionalTax.toFixed(2),
      totalDeductions:      be.totalEmployeeDeductions ? be.totalEmployeeDeductions.toString() : null,
      netPay:               be.netPay ? be.netPay.toString() : null,
    };
  });

  const batchLevelExceptions = batch.exceptions.map((e) => ({
    severity: e.severity, code: e.code, message: e.message, recommendedAction: e.recommendedAction ?? null,
  }));

  return { header, totals, employees, batchLevelExceptions };
}

/**
 * Employee-level detail — earnings, allowances, employer contributions,
 * per-employee exceptions, and a human-readable calculation explanation.
 *
 * The explanation is derived from `calculationExplanationJson` — this
 * function is the ONLY authorized surface that returns explanation
 * data to the browser. It never includes raw KMS refs, ciphertext, or
 * fields outside the sanitized DTO.
 */
export async function getBatchEmployeeReview(
  principal: Principal,
  clubId: string,
  batchEmployeeId: string,
): Promise<ReviewEmployeeDetail> {
  requirePermission(principal, clubId, "payroll:read");
  const be = await prisma.payrollBatchEmployee.findUnique({
    where: { id: batchEmployeeId },
    include: {
      employee: true, batch: true, earnings: true, allowanceSnapshots: true, exceptions: true,
    },
  });
  if (!be) throw new NotFoundError("PayrollBatchEmployee", batchEmployeeId);
  assertTenantOwned(be, principal);
  if (be.clubId !== clubId) throw new NotFoundError("PayrollBatchEmployee", batchEmployeeId);

  const emp = be.employee;
  const displayName = `${emp.firstName ?? ""} ${emp.lastName ?? ""}`.trim() || emp.email || emp.id;
  const additionalTax = toDecimal(be.additionalFederalTax ?? 0).plus(toDecimal(be.additionalProvincialTax ?? 0));

  const earningLines = be.earnings.map((r) => {
    const amount = toDecimal(r.quantity).times(toDecimal(r.rate));
    return {
      earningType: r.earningType, label: humanEarningTypeLabel(r.earningType),
      quantity: r.quantity.toString(), rate: r.rate.toString(),
      amount: amount.toFixed(2),
    };
  });
  const allowanceLines = be.allowanceSnapshots.map((a) => ({
    allowanceType: a.allowanceType, frequency: a.frequency,
    amount: a.amount.toString(),
    taxable: a.taxable, pensionable: !!a.pensionable, insurable: !!a.insurable,
  }));
  const exceptions = be.exceptions.map((e) => ({
    severity: e.severity, code: e.code, message: e.message, recommendedAction: e.recommendedAction ?? null,
  }));

  const explanation = sanitizeExplanation(be.calculationExplanationJson);

  const row: ReviewEmployeeRow = {
    batchEmployeeId: be.id, employeeId: be.employeeId, displayName,
    employeeNumber: emp.employeeNumber ?? null, departmentLabel: null,
    jurisdiction: [be.jurisdictionCountry, be.jurisdictionProvince].filter(Boolean).join("/"),
    status: be.status,
    hasBlockingException: exceptions.some((e) => e.severity === "BLOCKER"),
    hasWarning:           exceptions.some((e) => e.severity === "WARNING"),
    earningsGross:   be.grossPay ? be.grossPay.toString() : null,
    earningsTaxable: be.earningsTaxable ? be.earningsTaxable.toString() : null,
    cppCombined: be.deductionCppEeCombined ? be.deductionCppEeCombined.toString() : null,
    cpp2:        be.deductionCpp2Ee ? be.deductionCpp2Ee.toString() : null,
    ei:          be.deductionEiEe ? be.deductionEiEe.toString() : null,
    federalTax:  be.deductionFederalTax ? be.deductionFederalTax.toString() : null,
    provincialTax: be.deductionProvincialTax ? be.deductionProvincialTax.toString() : null,
    additionalTax: additionalTax.isZero() ? null : additionalTax.toFixed(2),
    totalDeductions: be.totalEmployeeDeductions ? be.totalEmployeeDeductions.toString() : null,
    netPay: be.netPay ? be.netPay.toString() : null,
  };

  return {
    ...row,
    earningLines,
    allowanceLines,
    employerContributions: {
      cppCombined: be.employerCppCombined ? be.employerCppCombined.toString() : null,
      cpp2:        be.employerCpp2        ? be.employerCpp2.toString()        : null,
      ei:          be.employerEi          ? be.employerEi.toString()          : null,
    },
    exceptions,
    explanation,
    ytdOpeningBalancePriorPayrollKind: parseYtdKind(be.ytdSnapshotJson),
  };
}

// ---------------------------------------------------------------------------
// Sanitization: never emit raw crypto refs or fields outside this DTO.
// ---------------------------------------------------------------------------

function parseYtdKind(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return j?.sources?.openingBalancePriorPayrollKind ?? null;
  } catch { return null; }
}

function sanitizeExplanation(raw: string | null | undefined): ReviewCalculationExplanation | null {
  if (!raw) return null;
  let j: any;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || j.schemaVersion !== 1) return null;
  // Pull ONLY the fields the UI needs. Never surface encrypted refs
  // or KMS material — these do not exist on this blob but the
  // sanitizer is the authorized bottleneck.
  return {
    algorithmVersion:  j.algorithmVersion ?? null,
    packageVersion:    j.packageVersion   ?? null,
    periodsPerYear:    typeof j.periodsPerYear === "number" ? j.periodsPerYear : null,
    pensionableMonths: typeof j.pensionableMonths === "number" ? j.pensionableMonths : null,
    earnings: {
      grossPay:            String(j.grossPay ?? "0"),
      earningsTaxable:     String(j.earningsTaxable ?? "0"),
      earningsPensionable: String(j.earningsPensionable ?? "0"),
      earningsInsurable:   String(j.earningsInsurable ?? "0"),
    },
    cpp: {
      base:     String(j.cpp?.base ?? "0"),
      firstAdd: String(j.cpp?.firstAdd ?? "0"),
      combined: String(j.cpp?.combined ?? "0"),
      deductibleAdditional: String(j.f5A ?? "0"),
    },
    cpp2: String(j.cpp2 ?? "0"),
    ei: {
      employee: String(j.ei?.employee ?? "0"),
      employer: String(j.ei?.employer ?? "0"),
    },
    federal: {
      annualisedTaxableIncome:   String(j.federal?.a ?? "0"),
      annualisedGrossEmployment: String(j.federal?.aStar ?? "0"),
      federalClaimUsed:          String(j.federal?.federalClaim ?? "0"),
      claimZeroFederal:          !!j.federal?.claimZeroFederal,
      bracketRate:               String(j.federal?.R ?? "0"),
      canadaEmploymentAmountCap: String(j.federal?.K4 ?? "0"),
      baseTax:                   String(j.federal?.T4PerPeriod ?? "0"),
      additionalTax:             String(j.federal?.additional ?? "0"),
      advanced: {
        f5aAnnual: String(j.federal?.f5aAnnual ?? "0"),
        bpaf:      String(j.federal?.bpaf ?? "0"),
        T:         String(j.federal?.T ?? "0"),
        K1:        String(j.federal?.K1 ?? "0"),
        K2:        String(j.federal?.K2 ?? "0"),
        K3:        String(j.federal?.K3 ?? "0"),
        K4:        String(j.federal?.K4 ?? "0"),
        T3Annual:  String(j.federal?.T3Annual ?? "0"),
        T4PerPeriod: String(j.federal?.T4PerPeriod ?? "0"),
      },
    },
    provincial: {
      annualisedTaxableIncome:  String(j.provincial?.a ?? "0"),
      provincialClaimUsed:      String(j.provincial?.provincialClaim ?? "0"),
      claimZeroProvincial:      !!j.provincial?.claimZeroProvincial,
      bracketRate:              String(j.provincial?.V ?? "0"),
      baseTax:                  String(j.provincial?.T4PPerPeriod ?? "0"),
      additionalTax:            String(j.provincial?.additional ?? "0"),
      advanced: {
        f5aAnnual: String(j.provincial?.f5aAnnual ?? "0"),
        TP:        String(j.provincial?.TP ?? "0"),
        K1P:       String(j.provincial?.K1P ?? "0"),
        K2P:       String(j.provincial?.K2P ?? "0"),
        K3P:       String(j.provincial?.K3P ?? "0"),
        K4P:       String(j.provincial?.K4P ?? "0"),
        K5P:       String(j.provincial?.K5P ?? "0"),
        T3PAnnual: String(j.provincial?.T3PAnnual ?? "0"),
        T4PPerPeriod: String(j.provincial?.T4PPerPeriod ?? "0"),
      },
    },
    totals: {
      totalEmployeeDeductions: String(j.totalEmployeeDeductions ?? "0"),
      netPay:                  String(j.netPay ?? "0"),
    },
  };
}
