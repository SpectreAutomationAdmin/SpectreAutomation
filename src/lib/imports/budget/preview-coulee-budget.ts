// BUDGET-HIST-1 (2026-10-04) — Coulee 2026 Budget PREVIEW service.
//
// Non-mutating: inspects the CSV + maps dept/account against the
// tenant's existing records and returns an aggregated preview the
// founder (or an automated gate) can review before authorizing
// Commit. Produces NO BudgetLine rows and never writes to the DB.
//
// Scope per directive §14:
//   • Club + Fiscal Year identity
//   • Budget version identity (would-be)
//   • source rows, monthly observations
//   • matched / unmatched accounts
//   • matched / unmatched departments
//   • January + Full-Year totals
//   • reconciliation by Department
//   • warnings + errors

import { prisma } from "@/lib/prisma";
import { parseCouleeBudgetCsv, type BudgetParseResult } from "./parse-coulee-budget-csv";
import { mapCouleeBudget, type MappingResult } from "./map-coulee-budget";

export type BudgetPreviewRequest = {
  clubId: string;
  fiscalYear: number;         // e.g. 2026
  budgetName: string;         // e.g. "Coulee 2026 Operating Budget"
  csvText: string;
};

export type BudgetPreviewResult = {
  club: { id: string; name: string } | null;
  fiscalYear: { id: string; label: string; startDate: string; endDate: string } | null;
  budgetName: string;
  wouldReplaceExistingBudget: boolean;
  existingBudgetSummary: null | {
    id: string;
    version: number;
    status: string;
    createdAt: string;
    sourceFileHash: string | null;
  };
  parse: {
    rowCount: number;
    uniqueAccountCount: number;
    uniqueDeptCodeCount: number;
    duplicateDeptAccountKeys: string[];
    sourceFileHash: string;
    monthlyTotals: number[];
    annualTotal: number;
  };
  mapping: MappingResult;
  perDepartment: Array<{
    jonasDeptCode: string;
    spectreCode: string | null;
    departmentName: string | null;
    rowCount: number;
    monthlyTotals: number[];
    annualTotal: number;
  }>;
  warnings: string[];
  blockers: string[];
  wouldLineCount: number;
  // Reporting-friendly derived aggregates (NOT persisted — surfaced
  // for the founder's eye only; the actual persisted values follow
  // the raw source).
  byFsGroup: Array<{ fsGroupKey: string | null; annualTotal: number; januaryTotal: number }>;
};

export async function previewCouleeBudget(
  req: BudgetPreviewRequest,
): Promise<BudgetPreviewResult> {
  const parse: BudgetParseResult = parseCouleeBudgetCsv(req.csvText);

  // Club lookup.
  const club = await prisma.club.findUnique({
    where: { id: req.clubId },
    select: { id: true, name: true },
  });

  // Fiscal Year lookup — do NOT auto-create. If missing, surface
  // as a blocker so the founder can decide.
  const fiscalYearRows = await prisma.fiscalYear.findMany({
    where: { clubId: req.clubId, startDate: { gte: new Date(Date.UTC(req.fiscalYear, 0, 1)) } },
    orderBy: { startDate: "asc" },
    select: { id: true, label: true, startDate: true, endDate: true },
  });
  const fiscalYear = fiscalYearRows.find(
    (fy) => fy.startDate.getUTCFullYear() === req.fiscalYear,
  ) ?? null;

  const existing = await prisma.budget.findFirst({
    where: {
      clubId: req.clubId,
      name: req.budgetName,
      ...(fiscalYear ? { fiscalYearId: fiscalYear.id } : {}),
    },
    orderBy: { version: "desc" },
    select: {
      id: true,
      version: true,
      status: true,
      createdAt: true,
      description: true,
    },
  });
  let existingHash: string | null = null;
  if (existing?.description) {
    try {
      const parsed = JSON.parse(existing.description) as { sourceFileHash?: string };
      existingHash = parsed.sourceFileHash ?? null;
    } catch {
      existingHash = null;
    }
  }

  const mapping = await mapCouleeBudget(req.clubId, parse.rows);

  // Per-department aggregates.
  const deptBuckets = new Map<string, {
    jonasDeptCode: string;
    spectreCode: string | null;
    departmentName: string | null;
    rowCount: number;
    monthlyTotals: number[];
    annualTotal: number;
  }>();
  for (const r of parse.rows) {
    const dep = mapping.departments.find((d) => d.jonasDeptCode === r.jonasDeptCode);
    const key = r.jonasDeptCode;
    let b = deptBuckets.get(key);
    if (!b) {
      b = {
        jonasDeptCode: r.jonasDeptCode,
        spectreCode: dep?.spectreCode ?? null,
        departmentName: dep?.departmentName ?? null,
        rowCount: 0,
        monthlyTotals: Array(12).fill(0),
        annualTotal: 0,
      };
      deptBuckets.set(key, b);
    }
    b.rowCount++;
    for (let m = 0; m < 12; m++) b.monthlyTotals[m] += r.monthlyAmounts[m];
    b.annualTotal += r.annualTotal;
  }

  // Per-fs-group aggregates (derived from the account mapping).
  const fsBuckets = new Map<string | null, { annualTotal: number; januaryTotal: number }>();
  for (const r of parse.rows) {
    const acct = mapping.accounts.find((a) => a.accountNumber === r.accountNumber);
    const fs = acct?.fsGroupKey ?? null;
    const b = fsBuckets.get(fs) ?? { annualTotal: 0, januaryTotal: 0 };
    b.annualTotal += r.annualTotal;
    b.januaryTotal += r.monthlyAmounts[0];
    fsBuckets.set(fs, b);
  }

  // Blockers + warnings.
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!club) blockers.push(`Club ${req.clubId} not found.`);
  if (!fiscalYear) blockers.push(`Fiscal Year ${req.fiscalYear} not seeded for this club.`);
  if (parse.duplicateDeptAccountKeys.length > 0) {
    blockers.push(`${parse.duplicateDeptAccountKeys.length} duplicate (dept|account) row(s) in source.`);
  }
  if (mapping.unmappedDeptCodes.length > 0) {
    blockers.push(`Dept code(s) not in Jonas→Spectre mapping: ${mapping.unmappedDeptCodes.join(", ")}.`);
  }
  if (mapping.missingDeptRows.length > 0) {
    blockers.push(`Spectre dept row(s) missing on tenant: ${mapping.missingDeptRows.join(", ")}.`);
  }
  if (mapping.unmatchedAccountNumbers.length > 0) {
    blockers.push(`${mapping.unmatchedAccountNumbers.length} account number(s) not on Coulee COA (first 10: ${mapping.unmatchedAccountNumbers.slice(0, 10).join(", ")}).`);
  }
  if (existing && existingHash && existingHash === parse.sourceFileHash) {
    warnings.push(`Identical source already imported as Budget ${existing.id} (v${existing.version}, status ${existing.status}). Commit will be a no-op.`);
  } else if (existing) {
    warnings.push(`A prior Budget "${req.budgetName}" exists at version ${existing.version}; commit will create version ${existing.version + 1} and leave the prior version untouched.`);
  }

  return {
    club,
    fiscalYear: fiscalYear
      ? {
          id: fiscalYear.id,
          label: fiscalYear.label,
          startDate: fiscalYear.startDate.toISOString(),
          endDate: fiscalYear.endDate.toISOString(),
        }
      : null,
    budgetName: req.budgetName,
    wouldReplaceExistingBudget: existing != null,
    existingBudgetSummary: existing
      ? {
          id: existing.id,
          version: existing.version,
          status: existing.status,
          createdAt: existing.createdAt.toISOString(),
          sourceFileHash: existingHash,
        }
      : null,
    parse: {
      rowCount: parse.rowCount,
      uniqueAccountCount: parse.uniqueAccountNumbers.length,
      uniqueDeptCodeCount: parse.uniqueDeptCodes.length,
      duplicateDeptAccountKeys: parse.duplicateDeptAccountKeys,
      sourceFileHash: parse.sourceFileHash,
      monthlyTotals: parse.monthlyTotals,
      annualTotal: parse.annualTotal,
    },
    mapping,
    perDepartment: Array.from(deptBuckets.values()).sort(
      (a, b) => Number(a.jonasDeptCode) - Number(b.jonasDeptCode),
    ),
    warnings,
    blockers,
    wouldLineCount: parse.rowCount,
    byFsGroup: Array.from(fsBuckets.entries()).map(([k, v]) => ({
      fsGroupKey: k,
      annualTotal: v.annualTotal,
      januaryTotal: v.januaryTotal,
    })).sort((a, b) => (a.fsGroupKey ?? "").localeCompare(b.fsGroupKey ?? "")),
  };
}
