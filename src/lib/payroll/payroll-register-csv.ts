// Slice E (2026-09-19) — CSV export of the Payroll Register.
// One employee per row. Numeric amounts as raw decimal strings
// (no "$1,234.56" formatting) so Excel treats them as numbers.

import type { PayrollRegisterV1 } from "./payroll-register";

const HEADERS = [
  "Employee Number",
  "Employee",
  "Department Code",
  "Department",
  "Pay Type",
  "Regular Earnings",
  "Other Earnings",
  "Taxable Benefits",
  "Gross Cash Earnings",
  "CPP",
  "CPP2",
  "EI",
  "Federal Tax",
  "Provincial Tax",
  "Other Deductions",
  "RRSP Employee Contribution",
  "Net Pay",
  "Employer CPP",
  "Employer CPP2",
  "Employer EI",
  "Employer Benefits",
  "RRSP Employer Contribution",
  "Total Employer Cost",
];

function csvField(v: string | null): string {
  if (v == null) return "";
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function renderPayrollRegisterCsv(reg: PayrollRegisterV1): string {
  const rows: string[] = [];
  rows.push(HEADERS.map(csvField).join(","));
  for (const e of reg.employees) {
    rows.push([
      csvField(e.employeeNumber ?? ""),
      csvField(e.employeeName),
      csvField(e.departmentCode),
      csvField(e.departmentName),
      csvField(e.payTypeLabel),
      e.regularEarnings,
      e.otherEarnings,
      e.taxableBenefits,
      e.grossCashEarnings,
      e.cpp,
      e.cpp2,
      e.ei,
      e.federalTax,
      e.provincialTax,
      e.otherDeductions,
      e.rrspEmployeeContribution,
      e.netPay,
      e.employerCpp,
      e.employerCpp2,
      e.employerEi,
      e.employerBenefits,
      e.rrspEmployerContribution,
      e.totalEmployerCost,
    ].join(","));
  }
  // Batch totals row
  const t = reg.totals;
  rows.push([
    "", "TOTALS", "", "", "",
    t.regularEarnings, t.otherEarnings, t.taxableBenefits, t.grossCashEarnings,
    t.cpp, t.cpp2, t.ei, t.federalTax, t.provincialTax,
    t.otherDeductions, t.rrspEmployeeContribution, t.netPay,
    t.employerCpp, t.employerCpp2, t.employerEi,
    t.employerBenefits, t.rrspEmployerContribution, t.totalEmployerCost,
  ].join(","));
  return rows.join("\n") + "\n";
}
