// BUDGET-HIST-1 (2026-10-04) — Coulee 2026 Budget COMMIT service.
//
// Writes:
//   • One Budget row per (clubId, fiscalYearId, name, version).
//   • 199 BudgetLine rows (one per source dept × account).
//
// Does NOT write:
//   • JournalEntry (budget is NOT accounting)
//   • ReportingLedgerBatch / ReportingLedgerSnapshot
//   • Account / Department / FiscalYear / FiscalPeriod
//   • Member / MemberAccount
//   • AR snapshot rows
//
// Idempotency contract:
//   • Preview-computed sourceFileHash is stored in Budget.description
//     as JSON provenance.
//   • A re-commit with the same (clubId, fiscalYearId, name) + hash
//     returns the existing Budget unchanged.
//   • A re-commit with the same (clubId, fiscalYearId, name) +
//     DIFFERENT hash creates a NEW version (Budget.version + 1) and
//     leaves the prior version intact.
//
// Scope boundaries (hard):
//   • Budget monthlyAmounts stored RAW — signs preserved, zeros
//     preserved. Reporting-layer sign semantics are applied at
//     RESOLUTION time, not persistence time (directive §4, §13).
//   • Nondepartmental rows (resolvedCode === null) land with
//     departmentId: null — this is a legitimate NULL in the schema's
//     @@unique([budgetId, accountId, departmentId]) key.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ParsedBudgetRow } from "./parse-coulee-budget-csv";
import { parseCouleeBudgetCsv } from "./parse-coulee-budget-csv";
import { mapCouleeBudget } from "./map-coulee-budget";

export type BudgetCommitRequest = {
  clubId: string;
  fiscalYear: number;
  budgetName: string;
  csvText: string;
  /** Set true to permit a new version if a prior Budget exists with a
   *  DIFFERENT source hash. False (default) returns a 409-style
   *  blocker when a different-hash prior version is found. */
  allowNewVersion?: boolean;
  importedByUserId?: string | null;
  sourceFilename?: string | null;
};

export type BudgetCommitResult = {
  outcome: "created" | "unchanged" | "versioned" | "blocked";
  budget: {
    id: string;
    version: number;
    status: string;
    sourceFileHash: string;
  } | null;
  lineCount: number;
  blockers: string[];
};

export async function commitCouleeBudget(
  req: BudgetCommitRequest,
): Promise<BudgetCommitResult> {
  const parse = parseCouleeBudgetCsv(req.csvText);
  const mapping = await mapCouleeBudget(req.clubId, parse.rows);
  const blockers: string[] = [];
  if (!mapping.isFullyResolved) {
    if (mapping.unmappedDeptCodes.length > 0) {
      blockers.push(`Unmapped dept codes: ${mapping.unmappedDeptCodes.join(", ")}`);
    }
    if (mapping.missingDeptRows.length > 0) {
      blockers.push(`Missing Spectre dept rows: ${mapping.missingDeptRows.join(", ")}`);
    }
    if (mapping.unmatchedAccountNumbers.length > 0) {
      blockers.push(`Unmatched account numbers (${mapping.unmatchedAccountNumbers.length})`);
    }
  }
  if (parse.duplicateDeptAccountKeys.length > 0) {
    blockers.push(`Duplicate (dept|account) keys in source: ${parse.duplicateDeptAccountKeys.length}`);
  }
  const fy = await prisma.fiscalYear.findFirst({
    where: {
      clubId: req.clubId,
      startDate: { gte: new Date(Date.UTC(req.fiscalYear, 0, 1)) },
      endDate: { lte: new Date(Date.UTC(req.fiscalYear + 1, 0, 1)) },
    },
    select: { id: true },
  });
  if (!fy) blockers.push(`Fiscal Year ${req.fiscalYear} not seeded.`);
  if (blockers.length > 0) {
    return { outcome: "blocked", budget: null, lineCount: 0, blockers };
  }

  // Idempotency: find the newest existing Budget with this (club, fy, name).
  const existing = await prisma.budget.findFirst({
    where: { clubId: req.clubId, fiscalYearId: fy!.id, name: req.budgetName },
    orderBy: { version: "desc" },
    select: {
      id: true, version: true, status: true, description: true,
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
  if (existing && existingHash === parse.sourceFileHash) {
    // Same file re-uploaded — no-op.
    return {
      outcome: "unchanged",
      budget: {
        id: existing.id,
        version: existing.version,
        status: existing.status,
        sourceFileHash: existingHash,
      },
      lineCount: await prisma.budgetLine.count({ where: { budgetId: existing.id } }),
      blockers: [],
    };
  }
  if (existing && !req.allowNewVersion) {
    return {
      outcome: "blocked",
      budget: null,
      lineCount: 0,
      blockers: [
        `A prior Budget "${req.budgetName}" exists at version ${existing.version} (hash ${existingHash ?? "unknown"}). Re-send with allowNewVersion=true to append version ${existing.version + 1}.`,
      ],
    };
  }
  const nextVersion = existing ? existing.version + 1 : 1;

  // Provenance JSON — stored in Budget.description so the schema is
  // not extended for a one-file-per-FY use case. Carries SHA, source
  // filename, importedAt, and the raw-row counts.
  const provenance = {
    source: req.sourceFilename ?? "2026.csv",
    sourceFileHash: parse.sourceFileHash,
    importedAt: new Date().toISOString(),
    rows: parse.rowCount,
    uniqueAccounts: parse.uniqueAccountNumbers.length,
    uniqueDeptCodes: parse.uniqueDeptCodes.length,
    monthlyTotals: parse.monthlyTotals,
    annualTotal: parse.annualTotal,
  };

  // Build the account-id map once; dept-id map likewise.
  const acctIdByNumber = new Map(
    mapping.accounts.filter((a) => a.accountId).map((a) => [a.accountNumber, a.accountId as string]),
  );
  const deptIdByJonas = new Map(
    mapping.departments.map((d) => [d.jonasDeptCode, d.departmentId]),
  );

  const budgetId = await prisma.$transaction(async (tx) => {
    const b = await tx.budget.create({
      data: {
        clubId: req.clubId,
        fiscalYearId: fy!.id,
        name: req.budgetName,
        version: nextVersion,
        status: "IMPORTED",
        description: JSON.stringify(provenance),
        createdByUserId: req.importedByUserId ?? null,
      },
      select: { id: true },
    });
    // Insert BudgetLine rows one by one (safe + simple; 199 rows).
    for (const row of parse.rows) {
      const accountId = acctIdByNumber.get(row.accountNumber);
      if (!accountId) {
        throw new Error(`internal: account ${row.accountNumber} missing after mapping passed`);
      }
      const departmentId = deptIdByJonas.get(row.jonasDeptCode) ?? null;
      await tx.budgetLine.create({
        data: {
          clubId: req.clubId,
          budgetId: b.id,
          accountId,
          departmentId,
          monthlyAmounts: JSON.stringify(row.monthlyAmounts),
          annualTotal: new Prisma.Decimal(row.annualTotal.toFixed(2)),
          notes: `source line ${row.sourceLineNumber}`,
        },
      });
    }
    return b.id;
  }, { timeout: 120_000 });

  const created = await prisma.budget.findUnique({
    where: { id: budgetId },
    select: { id: true, version: true, status: true },
  });
  const lineCount = await prisma.budgetLine.count({ where: { budgetId } });
  return {
    outcome: existing ? "versioned" : "created",
    budget: {
      id: created!.id,
      version: created!.version,
      status: created!.status,
      sourceFileHash: parse.sourceFileHash,
    },
    lineCount,
    blockers: [],
  };
}
