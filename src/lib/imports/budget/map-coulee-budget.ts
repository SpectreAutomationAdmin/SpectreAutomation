// BUDGET-HIST-1 (2026-10-04) — department + account resolver for the
// Coulee 2026 Budget import.
//
// Mapping evidence (per TB-HIST):
//   • Jonas dept codes in the budget CSV are UNPADDED ("1".."7","20").
//   • The canonical Jonas → Spectre mapping lives in
//     `src/lib/reporting/ledger/importers/jonas-department-mapping.ts`
//     and keys are 6-digit zero-padded ("000001".."000020").
//   • AccountBalance.dimensional[].department on committed TB snapshots
//     carries the already-resolved Spectre code (GROUNDS, F&B, etc.),
//     NOT the Jonas code — so the budget must land under the same
//     Spectre code so the reporting layer joins Actual + Budget by
//     the identical dimension.
//
// Account resolution: single bulk `prisma.account.findMany({IN: […]})`
// against the Coulee tenant — never N findFirst calls.

import { prisma } from "@/lib/prisma";
import {
  resolveJonasDepartment,
} from "@/lib/reporting/ledger/importers/jonas-department-mapping";
import type { ParsedBudgetRow } from "./parse-coulee-budget-csv";

export type DepartmentResolution = {
  jonasDeptCode: string;
  /** Spectre code written to Department.code (null = nondepartmental). */
  spectreCode: string | null;
  /** Resolved Department.id. Null for nondepartmental or if the
   *  Spectre Department row is missing. */
  departmentId: string | null;
  /** Display name from the Spectre Department row, when found. */
  departmentName: string | null;
  /** Match evidence: "mapping-table" | "mapping-table+db" | "unknown". */
  evidence: "mapping-table" | "mapping-table+db" | "nondepartmental" | "unmapped";
};

export type AccountResolution = {
  accountNumber: string;
  accountId: string | null;
  accountName: string | null;
  accountType: string | null;
  fsGroupKey: string | null;
};

export type MappingResult = {
  /** Per-source-code resolution + Spectre Department row match. */
  departments: DepartmentResolution[];
  /** Codes present in source but not resolvable via the Jonas mapping. */
  unmappedDeptCodes: string[];
  /** Spectre dept codes resolved by mapping but with no matching
   *  Department row on this tenant. */
  missingDeptRows: string[];

  /** Per-account-number resolution. */
  accounts: AccountResolution[];
  /** Accounts present in source but not found on this tenant's COA. */
  unmatchedAccountNumbers: string[];

  /** True iff every row's dept + account resolves deterministically. */
  isFullyResolved: boolean;
};

/** Pad a raw Jonas dept code to 6 digits so it matches the mapping
 *  table's keys. "1" → "000001", "20" → "000020". */
export function padJonasDeptCode(code: string): string {
  return code.trim().padStart(6, "0");
}

/** Resolve one source dept code → Spectre code + Department row.
 *  Accepts the pre-fetched tenant Department catalog so a batch call
 *  can resolve all 8 codes with a single prisma read. */
export function resolveBudgetDepartmentPure(
  jonasDeptCode: string,
  tenantDepartments: ReadonlyArray<{ id: string; code: string; name: string }>,
): DepartmentResolution {
  const padded = padJonasDeptCode(jonasDeptCode);
  const r = resolveJonasDepartment(padded, null, tenantDepartments);
  if (r.status === "unknown") {
    return {
      jonasDeptCode,
      spectreCode: null,
      departmentId: null,
      departmentName: null,
      evidence: "unmapped",
    };
  }
  if (r.status === "missing-spectre-dept") {
    return {
      jonasDeptCode,
      spectreCode: r.spectreCode,
      departmentId: null,
      departmentName: null,
      evidence: "mapping-table",
    };
  }
  // r.status === "ok"
  if (r.spectreCode === null) {
    return {
      jonasDeptCode,
      spectreCode: null,
      departmentId: null,
      departmentName: null,
      evidence: "nondepartmental",
    };
  }
  const row = tenantDepartments.find((d) => d.code === r.spectreCode);
  if (!row) {
    return {
      jonasDeptCode,
      spectreCode: r.spectreCode,
      departmentId: null,
      departmentName: null,
      evidence: "mapping-table",
    };
  }
  return {
    jonasDeptCode,
    spectreCode: row.code,
    departmentId: row.id,
    departmentName: row.name,
    evidence: "mapping-table+db",
  };
}

/** Resolve the full mapping for a parsed budget. Returns a report
 *  the preview layer can render verbatim. Does NOT write anything. */
export async function mapCouleeBudget(
  clubId: string,
  rows: ParsedBudgetRow[],
): Promise<MappingResult> {
  // -------- Departments (one bulk prisma read) --------
  const uniqueDeptCodes = Array.from(new Set(rows.map((r) => r.jonasDeptCode)))
    .sort((a, b) => Number(a) - Number(b));
  const tenantDepts = await prisma.department.findMany({
    where: { clubId },
    select: { id: true, code: true, name: true },
  });
  const departments: DepartmentResolution[] = uniqueDeptCodes.map((code) =>
    resolveBudgetDepartmentPure(code, tenantDepts),
  );
  const unmappedDeptCodes = departments
    .filter((d) => d.evidence === "unmapped")
    .map((d) => d.jonasDeptCode);
  const missingDeptRows = departments
    .filter((d) => d.evidence === "mapping-table" && d.spectreCode)
    .map((d) => d.spectreCode as string);

  // -------- Accounts (one bulk query) --------
  const uniqueAccountNumbers = Array.from(new Set(rows.map((r) => r.accountNumber)));
  const matched = await prisma.account.findMany({
    where: { clubId, accountNumber: { in: uniqueAccountNumbers } },
    select: {
      id: true,
      accountNumber: true,
      name: true,
      type: true,
      fsGroup: { select: { key: true } },
    },
  });
  const byNumber = new Map(matched.map((a) => [a.accountNumber, a]));
  const accounts: AccountResolution[] = uniqueAccountNumbers
    .sort()
    .map((num) => {
      const row = byNumber.get(num);
      return {
        accountNumber: num,
        accountId: row?.id ?? null,
        accountName: row?.name ?? null,
        accountType: row?.type ?? null,
        fsGroupKey: row?.fsGroup?.key ?? null,
      };
    });
  const unmatchedAccountNumbers = accounts
    .filter((a) => a.accountId == null)
    .map((a) => a.accountNumber);

  const isFullyResolved =
    unmappedDeptCodes.length === 0 &&
    missingDeptRows.length === 0 &&
    unmatchedAccountNumbers.length === 0;

  return {
    departments,
    unmappedDeptCodes,
    missingDeptRows,
    accounts,
    unmatchedAccountNumbers,
    isFullyResolved,
  };
}
