// Payroll Admin Slice 3F (2026-09-13) — payroll journal preview.
//
// Reuses the SAME statutory + component aggregation and the SAME
// account-mapping resolution logic that `postPayrollBatch` uses at
// commit time — extracted here as a PURE READ-SIDE function. The
// preview and the actual post are guaranteed to produce the same
// journal lines because they consume the identical persisted
// PayrollBatchEmployee + PayrollBatchComponentSnapshot rows and the
// same `PayrollGlAccountingProfile`.
//
// Refuses under the same conditions as post: readiness blockers,
// missing profile, empty batch, wrong lifecycle status.
//
// This service NEVER writes. It never opens a transaction. It is
// safe to call from the Payroll Admin's Post confirmation UI.

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";
import { ConflictError, NotFoundError } from "../errors";
import { assertTenantOwned } from "../services/tenant";
import { Prisma } from "@prisma/client";
import { componentRequiresExpense, componentRequiresLiability } from "./gl-readiness";

const PAYROLL_ENTITY = "PayrollBatch";

export interface PayrollJournalPreviewLine {
  lineNumber: number;
  accountNumber: string;
  accountName: string;
  debit: string | null;
  credit: string | null;
  description: string;
}

export interface PayrollJournalPreviewResult {
  batchId: string;
  status: string;
  calculationVersion: number;
  approvedAt: string | null;
  approvedByUserId: string | null;
  submittedByUserId: string | null;
  payDate: string | null;
  entryDate: string;
  memo: string;
  description: string;
  lines: PayrollJournalPreviewLine[];
  totalDebits: string;
  totalCredits: string;
  balanced: boolean;
  differenceCents: number;
  readinessBlockers: Array<{ code: string; message: string }>;
}

/** Build a canonical journal preview for a payroll batch. Refuses
 *  when readiness gates fail; those failures are the same ones that
 *  would refuse a real Post. */
export async function previewPayrollJournal(
  principal: Principal,
  clubId: string,
  batchId: string,
): Promise<PayrollJournalPreviewResult> {
  requirePermission(principal, clubId, "payroll:read");

  const batch = await prisma.payrollBatch.findFirst({
    where: { id: batchId, clubId },
    include: { payGroup: true, payPeriod: true },
  });
  if (!batch) throw new NotFoundError(PAYROLL_ENTITY, batchId);
  assertTenantOwned(batch, principal);
  if (batch.status !== "APPROVED" && batch.status !== "POSTED") {
    throw new ConflictError(
      `Payroll journal preview requires APPROVED (or POSTED) batch; current status is ${batch.status}.`,
    );
  }

  // GL readiness check — reuse the exact same validator the real Post
  // uses.
  const { evaluatePayrollGlReadiness } = await import("./gl-readiness");
  const readiness = await evaluatePayrollGlReadiness(principal, clubId, batchId);

  // Load profile + employees + snapshots (identical to postPayrollBatch).
  const config = await prisma.payrollClubConfig.findUnique({
    where: { clubId },
    include: { glAccountingProfile: true },
  });
  const profile = config?.glAccountingProfile;
  if (!profile) {
    return {
      batchId, status: batch.status,
      calculationVersion: batch.calculationVersion,
      approvedAt: batch.approvedAt?.toISOString() ?? null,
      approvedByUserId: batch.approvedByUserId ?? null,
      submittedByUserId: batch.submittedByUserId ?? null,
      payDate: batch.payPeriod.payDate.toISOString() ?? null,
      entryDate: batch.payPeriod.payDate.toISOString(),
      memo: "",
      description: "",
      lines: [],
      totalDebits: "0.00", totalCredits: "0.00",
      balanced: true, differenceCents: 0,
      readinessBlockers: [{
        code: "PAYROLL_GL_PROFILE_MISSING",
        message: "This Club has no PayrollGlAccountingProfile configured.",
      }],
    };
  }
  if (!readiness.ready) {
    return {
      batchId, status: batch.status,
      calculationVersion: batch.calculationVersion,
      approvedAt: batch.approvedAt?.toISOString() ?? null,
      approvedByUserId: batch.approvedByUserId ?? null,
      submittedByUserId: batch.submittedByUserId ?? null,
      payDate: batch.payPeriod.payDate.toISOString() ?? null,
      entryDate: batch.payPeriod.payDate.toISOString(),
      memo: "",
      description: "",
      lines: [],
      totalDebits: "0.00", totalCredits: "0.00",
      balanced: true, differenceCents: 0,
      readinessBlockers: readiness.blockers.map((b) => ({
        code: b.code,
        message: (b as { message?: string }).message ?? `Readiness blocker: ${b.code}`,
      })),
    };
  }

  const emps = await prisma.payrollBatchEmployee.findMany({
    where: { batchId, clubId },
    select: {
      id: true, employeeId: true,
      grossPay: true, netPay: true,
      deductionCppEeCombined: true, deductionCpp2Ee: true,
      deductionEiEe: true,
      deductionFederalTax: true, deductionProvincialTax: true,
      employerCppCombined: true, employerCpp2: true,
      employerEi: true,
    },
  });
  const sumDec = (rows: Array<Record<string, unknown>>, field: string): Prisma.Decimal => {
    let acc = new Prisma.Decimal(0);
    for (const r of rows) {
      const v = r[field];
      if (v == null) continue;
      acc = acc.plus(v as Prisma.Decimal);
    }
    return acc;
  };
  const gross      = sumDec(emps, "grossPay");
  const netPay     = sumDec(emps, "netPay");
  const eeCpp      = sumDec(emps, "deductionCppEeCombined").plus(sumDec(emps, "deductionCpp2Ee"));
  const eeEi       = sumDec(emps, "deductionEiEe");
  const fedTax     = sumDec(emps, "deductionFederalTax");
  const provTax    = sumDec(emps, "deductionProvincialTax");
  const erCpp      = sumDec(emps, "employerCppCombined").plus(sumDec(emps, "employerCpp2"));
  const erEi       = sumDec(emps, "employerEi");
  const cppPayable = eeCpp.plus(erCpp);
  const eiPayable  = eeEi.plus(erEi);

  const snaps = await prisma.payrollBatchComponentSnapshot.findMany({
    where: { batchId, clubId },
    select: {
      componentCode: true, displayName: true,
      side: true, cashEffect: true, category: true, provenance: true,
      resolvedAmount: true,
      expenseAccountIdSnapshot: true, liabilityAccountIdSnapshot: true,
    },
  });

  interface Bucket { total: Prisma.Decimal; sources: string[] }
  const debitBuckets  = new Map<string, Bucket>();
  const creditBuckets = new Map<string, Bucket>();
  const addBucket = (m: Map<string, Bucket>, acctId: string, amt: Prisma.Decimal, src: string) => {
    const b = m.get(acctId);
    if (b) {
      b.total = b.total.plus(amt);
      if (!b.sources.includes(src)) b.sources.push(src);
    } else {
      m.set(acctId, { total: amt, sources: [src] });
    }
  };
  let componentCashInGross = new Prisma.Decimal(0);
  for (const s of snaps) {
    if (s.resolvedAmount == null || (s.resolvedAmount as Prisma.Decimal).isZero()) continue;
    const amt = s.resolvedAmount as Prisma.Decimal;
    const src = `${s.displayName} (${s.componentCode})`;
    if (componentRequiresExpense(s) && s.expenseAccountIdSnapshot) {
      addBucket(debitBuckets, s.expenseAccountIdSnapshot, amt, src);
    }
    if (componentRequiresLiability(s) && s.liabilityAccountIdSnapshot) {
      addBucket(creditBuckets, s.liabilityAccountIdSnapshot, amt, src);
    }
    if (s.side === "EMPLOYEE" && s.cashEffect === "INCREASES_NET_PAY") {
      componentCashInGross = componentCashInGross.plus(amt);
    }
  }
  const residualSalaryExpense = gross.minus(componentCashInGross);

  const componentAcctIds = new Set<string>();
  for (const id of debitBuckets.keys())  componentAcctIds.add(id);
  for (const id of creditBuckets.keys()) componentAcctIds.add(id);
  const accountIds = [
    profile.salaryExpenseAccountId, profile.employerCppExpenseAccountId, profile.employerEiExpenseAccountId,
    profile.netPayPayableAccountId, profile.cppPayableAccountId, profile.eiPayableAccountId,
    profile.federalTaxPayableAccountId, profile.provincialTaxPayableAccountId,
    ...componentAcctIds,
  ];
  const acctRows = await prisma.account.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, accountNumber: true, name: true },
  });
  const acctById = new Map(acctRows.map((a) => [a.id, a]));
  const num  = (id: string): string => acctById.get(id)?.accountNumber ?? `?${id}`;
  const name = (id: string): string => acctById.get(id)?.name ?? "(unknown)";

  const lines: PayrollJournalPreviewLine[] = [];
  let ln = 1;
  const addDebit = (accountId: string, amount: Prisma.Decimal, description: string) => {
    if (amount.isZero()) return;
    lines.push({
      lineNumber: ln++,
      accountNumber: num(accountId), accountName: name(accountId),
      debit: amount.toFixed(2), credit: null, description,
    });
  };
  const addCredit = (accountId: string, amount: Prisma.Decimal, description: string) => {
    if (amount.isZero()) return;
    lines.push({
      lineNumber: ln++,
      accountNumber: num(accountId), accountName: name(accountId),
      debit: null, credit: amount.toFixed(2), description,
    });
  };
  const label = `Payroll ${batch.payGroup.code} ${batch.payPeriod.periodStart.toISOString().slice(0, 10)} → ${batch.payPeriod.payDate.toISOString().slice(0, 10)}`;

  addDebit(profile.salaryExpenseAccountId,       residualSalaryExpense, `${label} — regular salary expense`);
  addDebit(profile.employerCppExpenseAccountId,  erCpp,   `${label} — employer CPP expense`);
  addDebit(profile.employerEiExpenseAccountId,   erEi,    `${label} — employer EI expense`);
  for (const [acctId, b] of debitBuckets) {
    const sources = b.sources.length <= 3 ? b.sources.join(" + ") : `${b.sources.length} components`;
    addDebit(acctId, b.total, `${label} — ${sources}`);
  }
  for (const [acctId, b] of creditBuckets) {
    const sources = b.sources.length <= 3 ? b.sources.join(" + ") : `${b.sources.length} components`;
    addCredit(acctId, b.total, `${label} — ${sources} payable`);
  }
  addCredit(profile.netPayPayableAccountId,        netPay,     `${label} — net pay payable`);
  addCredit(profile.cppPayableAccountId,           cppPayable, `${label} — CPP payable (ee + er)`);
  addCredit(profile.eiPayableAccountId,            eiPayable,  `${label} — EI payable (ee + er)`);
  addCredit(profile.federalTaxPayableAccountId,    fedTax,     `${label} — federal income tax payable`);
  addCredit(profile.provincialTaxPayableAccountId, provTax,    `${label} — provincial income tax payable`);

  const debitTotal  = lines.reduce((s, l) => s.plus(l.debit  ?? "0"), new Prisma.Decimal(0));
  const creditTotal = lines.reduce((s, l) => s.plus(l.credit ?? "0"), new Prisma.Decimal(0));
  const diffCents = Math.round(Number(debitTotal.minus(creditTotal).toFixed(2)) * 100);

  return {
    batchId, status: batch.status,
    calculationVersion: batch.calculationVersion,
    approvedAt: batch.approvedAt?.toISOString() ?? null,
    approvedByUserId: batch.approvedByUserId ?? null,
    submittedByUserId: batch.submittedByUserId ?? null,
    payDate: batch.payPeriod.payDate.toISOString(),
    entryDate: batch.payPeriod.payDate.toISOString(),
    memo: `Auto-generated from PayrollBatch ${batch.id}`,
    description: `${label} — Payroll batch ${batch.id.slice(-8)}`,
    lines,
    totalDebits: debitTotal.toFixed(2),
    totalCredits: creditTotal.toFixed(2),
    balanced: diffCents === 0,
    differenceCents: diffCents,
    readinessBlockers: [],
  };
}
