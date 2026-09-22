// FPP-9C (2026-09-22) — Original vs Corrected vs Change comparison service.
//
// Derives a single canonical comparison structure from the ORIGINAL and
// CORRECTION batches. Reusable by the Payroll Admin preparation surface,
// the Controller Work Intake surface, and the correction detail view.
//
// Read-only. Never mutates either batch. Uses Decimal arithmetic
// throughout — no JavaScript floating-point payroll math.

"use server";

import { prisma } from "../prisma";
import { Prisma } from "@prisma/client";
import { NotFoundError } from "../errors";

type Money = Prisma.Decimal;
const zero = () => new Prisma.Decimal(0);
const d = (v: Money | string | number | null | undefined): Money =>
  v == null ? zero() : v instanceof Prisma.Decimal ? v : new Prisma.Decimal(v);
const fmt = (v: Money | null | undefined): string => (v ?? zero()).toFixed(2);

export interface EmployeeComparisonRow {
  employeeId: string;
  employeeName: string;
  employeeNumber: string | null;
  changed: boolean;  // did ANY material field differ?
  fields: Record<string, { original: string; corrected: string; change: string; changed: boolean }>;
}

export interface ComponentComparisonRow {
  employeeId: string;
  componentCode: string;
  displayName: string;
  operation: "UNCHANGED" | "ADDED" | "REMOVED" | "CHANGED";
  originalAmount: string;
  correctedAmount: string;
  change: string;
}

export interface CorrectionComparison {
  original: { batchId: string; status: string; totalGross: string; totalNet: string };
  correction: { batchId: string; status: string; totalGross: string; totalNet: string };
  employees: EmployeeComparisonRow[];
  changedEmployeeCount: number;
  unchangedEmployeeCount: number;
  components: ComponentComparisonRow[];
  totals: {
    grossChange: string;
    totalDeductionsChange: string;
    netChange: string;
    employerCostChange: string;
  };
}

const FIELDS: Array<{ key: string; label: string; extractor: (e: any) => Money | null | undefined }> = [
  { key: "gross",        label: "Gross",             extractor: e => e.grossPay },
  { key: "taxable",      label: "Taxable",           extractor: e => e.earningsTaxable },
  { key: "pensionable",  label: "Pensionable",       extractor: e => e.earningsPensionable },
  { key: "insurable",    label: "Insurable",         extractor: e => e.earningsInsurable },
  { key: "cppEE",        label: "CPP EE",            extractor: e => e.deductionCppEeCombined },
  { key: "cpp2EE",       label: "CPP2 EE",           extractor: e => e.deductionCpp2Ee },
  { key: "eiEE",         label: "EI EE",             extractor: e => e.deductionEiEe },
  { key: "fedTax",       label: "Federal Tax",       extractor: e => e.deductionFederalTax },
  { key: "provTax",      label: "Provincial Tax",    extractor: e => e.deductionProvincialTax },
  { key: "totalEEDeds",  label: "EE deductions",     extractor: e => e.totalEmployeeDeductions },
  { key: "netPay",       label: "Net Pay",           extractor: e => e.netPay },
  { key: "cppER",        label: "Employer CPP",      extractor: e => e.employerCppCombined },
  { key: "eiER",         label: "Employer EI",       extractor: e => e.employerEi },
];

export async function buildCorrectionComparison(correctionBatchId: string): Promise<CorrectionComparison> {
  const correctionBatch = await prisma.payrollBatch.findUnique({
    where: { id: correctionBatchId },
    select: { id: true, status: true, transactionType: true, correctsPayrollBatchId: true },
  });
  if (!correctionBatch) throw new NotFoundError("PayrollBatch", correctionBatchId);
  if (correctionBatch.transactionType !== "CORRECTION" || !correctionBatch.correctsPayrollBatchId) {
    throw new Error("Batch is not a CORRECTION — cannot build correction comparison.");
  }
  const originalBatchId = correctionBatch.correctsPayrollBatchId;
  const originalBatch = await prisma.payrollBatch.findUniqueOrThrow({
    where: { id: originalBatchId },
    select: { id: true, status: true },
  });

  const [origEmps, corrEmps, origComps, corrComps] = await Promise.all([
    prisma.payrollBatchEmployee.findMany({
      where: { batchId: originalBatchId },
      include: { employee: { select: { firstName: true, lastName: true, employeeNumber: true } } },
    }),
    prisma.payrollBatchEmployee.findMany({
      where: { batchId: correctionBatchId },
      include: { employee: { select: { firstName: true, lastName: true, employeeNumber: true } } },
    }),
    prisma.payrollBatchComponentSnapshot.findMany({
      where: { batchId: originalBatchId },
      select: { employeeId: true, componentCode: true, displayName: true, resolvedAmount: true },
    }),
    prisma.payrollBatchComponentSnapshot.findMany({
      where: { batchId: correctionBatchId },
      select: { employeeId: true, componentCode: true, displayName: true, resolvedAmount: true },
    }),
  ]);

  // Employee-level comparison.
  const origByEmp = new Map(origEmps.map(e => [e.employeeId, e]));
  const corrByEmp = new Map(corrEmps.map(e => [e.employeeId, e]));
  const allEmployeeIds = new Set<string>([...origByEmp.keys(), ...corrByEmp.keys()]);
  const employeeRows: EmployeeComparisonRow[] = [];
  let grossChange = zero(), totalDeductionsChange = zero(), netChange = zero(), employerCostChange = zero();
  let changedCount = 0;
  for (const empId of allEmployeeIds) {
    const o = origByEmp.get(empId);
    const c = corrByEmp.get(empId);
    const name = c?.employee ?? o?.employee;
    const fields: EmployeeComparisonRow["fields"] = {};
    let rowChanged = false;
    for (const f of FIELDS) {
      const ov = d(f.extractor(o));
      const cv = d(f.extractor(c));
      const changed = !ov.equals(cv);
      if (changed) rowChanged = true;
      fields[f.key] = {
        original: fmt(ov), corrected: fmt(cv),
        change: fmt(cv.minus(ov)),
        changed,
      };
    }
    if (rowChanged) changedCount++;
    // Roll up totals.
    grossChange = grossChange.plus(d(c?.grossPay).minus(d(o?.grossPay)));
    totalDeductionsChange = totalDeductionsChange.plus(d(c?.totalEmployeeDeductions).minus(d(o?.totalEmployeeDeductions)));
    netChange = netChange.plus(d(c?.netPay).minus(d(o?.netPay)));
    const employerCostO = d(o?.grossPay).plus(d(o?.employerCppCombined)).plus(d(o?.employerEi));
    const employerCostC = d(c?.grossPay).plus(d(c?.employerCppCombined)).plus(d(c?.employerEi));
    employerCostChange = employerCostChange.plus(employerCostC.minus(employerCostO));
    employeeRows.push({
      employeeId: empId,
      employeeName: `${name?.firstName ?? ""} ${name?.lastName ?? ""}`.trim(),
      employeeNumber: name?.employeeNumber ?? null,
      changed: rowChanged,
      fields,
    });
  }

  // Component-level comparison.
  const key = (r: { employeeId: string; componentCode: string }) => `${r.employeeId}|${r.componentCode}`;
  const origByKey = new Map(origComps.map(r => [key(r), r]));
  const corrByKey = new Map(corrComps.map(r => [key(r), r]));
  const allKeys = new Set<string>([...origByKey.keys(), ...corrByKey.keys()]);
  const componentRows: ComponentComparisonRow[] = [];
  for (const k of allKeys) {
    const o = origByKey.get(k);
    const c = corrByKey.get(k);
    const oAmt = d(o?.resolvedAmount);
    const cAmt = d(c?.resolvedAmount);
    const operation: ComponentComparisonRow["operation"] =
      !o ? "ADDED" : !c ? "REMOVED" : oAmt.equals(cAmt) ? "UNCHANGED" : "CHANGED";
    componentRows.push({
      employeeId: (o ?? c)!.employeeId,
      componentCode: (o ?? c)!.componentCode,
      displayName: (o ?? c)!.displayName,
      operation,
      originalAmount: fmt(oAmt),
      correctedAmount: fmt(cAmt),
      change: fmt(cAmt.minus(oAmt)),
    });
  }

  // Batch totals.
  const sumGross = (list: typeof origEmps) => list.reduce((s, e) => s.plus(d(e.grossPay)), zero());
  const sumNet = (list: typeof origEmps) => list.reduce((s, e) => s.plus(d(e.netPay)), zero());
  return {
    original: { batchId: originalBatch.id, status: originalBatch.status, totalGross: fmt(sumGross(origEmps)), totalNet: fmt(sumNet(origEmps)) },
    correction: { batchId: correctionBatch.id, status: correctionBatch.status, totalGross: fmt(sumGross(corrEmps)), totalNet: fmt(sumNet(corrEmps)) },
    employees: employeeRows.sort((a, b) => a.employeeName.localeCompare(b.employeeName)),
    changedEmployeeCount: changedCount,
    unchangedEmployeeCount: employeeRows.length - changedCount,
    components: componentRows
      .filter(r => r.operation !== "UNCHANGED")  // only surface the diff
      .sort((a, b) => a.employeeId.localeCompare(b.employeeId) || a.componentCode.localeCompare(b.componentCode)),
    totals: {
      grossChange: fmt(grossChange),
      totalDeductionsChange: fmt(totalDeductionsChange),
      netChange: fmt(netChange),
      employerCostChange: fmt(employerCostChange),
    },
  };
}
