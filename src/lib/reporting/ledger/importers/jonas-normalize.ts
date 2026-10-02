// TB-HIST-6 (2026-10-01) — single resolution pipeline for the
// Jonas importer. Both `previewJonasImport` and `commitJonasImport`
// consume the SAME normalized dimensional row model, so what the
// operator sees in Preview is EXACTLY what the ledger snapshot
// persists on Commit. Prior to this slice Preview resolved Jonas
// department codes → Spectre codes for display, but the Commit path
// re-parsed the raw CSV (which still carried Jonas 6-digit codes)
// and wrote those into the ReportingLedgerSnapshot — a silent
// drift the directive calls out as a release blocker.
//
// The normalizer is PURE: no Prisma, no I/O. Callers hand in the
// parsed CSV rows + the tenant's Spectre accounts + Department
// catalog + the (optional) Jonas→Spectre department mapping; the
// normalizer returns a frozen array of `NormalizedJonasRow` plus
// rolled-up counts and the ordered list of blockers.

import type {
  JonasGlCsvParseSuccess,
  JonasGlCsvRow,
  JonasSourceFormat,
} from "@/lib/reporting/ledger/importers/jonas-gl-csv";
import {
  mapJonasAccount,
  type JonasAccountMapping,
} from "@/lib/reporting/ledger/importers/jonas-gl-mapping";
import {
  DEFAULT_JONAS_DEPARTMENT_MAPPING,
  resolveJonasDepartment,
} from "@/lib/reporting/ledger/importers/jonas-department-mapping";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type NormalizedJonasRow = {
  /** 1-indexed source line number for diagnostics. */
  lineNumber: number;
  /** Resolved Spectre Account code (same as source for Format D — the
   *  real Dec 2025 workbook uses 4-digit codes that match Spectre's
   *  COA verbatim). */
  accountCode: string;
  /** Jonas-side description — for Preview display. */
  accountDescription: string;
  /** Resolved Spectre Account record fields. Null when the account
   *  is unknown to Coulee's COA. */
  spectreAccountName: string | null;
  spectreAccountId: string | null;
  spectreAccountDepartmentPolicy: "REQUIRED" | "OPTIONAL" | "NOT_APPLICABLE" | null;
  /** RESOLVED Spectre Department code — this is the dimension that
   *  will be frozen into the ReportingLedgerSnapshot. Null for the
   *  Jonas 000000 "Balance Sheet" nondepartmental marker and for
   *  rows whose account carries departmentPolicy=NOT_APPLICABLE. */
  department: string | null;
  /** Resolved Fund (from the Jonas account mapping). */
  fund: string | null;
  /** Jonas source Department Code (6-digit). Null for formats
   *  without a source dept column (Format A/B/C). Carried through
   *  for Preview display + audit; NEVER persisted into the ledger
   *  snapshot — Spectre codes are authoritative in the snapshot. */
  jonasDepartmentCode: string | null;
  jonasDepartmentDescription: string | null;
  /** Balances (ABS magnitudes for reconciliation). */
  debit: number;
  credit: number;
  periodBalance: number;
  ytdBalance: number;
  /** Period labels — Preview + Commit both read these directly. */
  fiscalYear: string;
  fiscalPeriod: number;
  /** Account-mapping status. */
  mappingStatus: "mapped" | "unmapped" | "description-conflict" | "duplicate";
  /** Dimensional-resolution status. */
  departmentStatus:
    | "ok"
    | "n/a"
    | "missing-required"
    | "unknown-dept"
    | "unknown-jonas-dept"
    | "missing-spectre-dept";
  /** Dimensional dup-key — same (accountCode, resolvedDept)
   *  canonical form that `(code, dept)` persistent uniqueness
   *  requires. */
  dimKey: string;
  isDuplicate: boolean;
};

export type NormalizationCounts = {
  rowCount: number;
  mapped: number;
  unmapped: number;
  descriptionConflicts: number;
  duplicates: number;
  missingRequiredDept: number;
  unknownDept: number;
  unknownJonasDept: number;
  missingSpectreDept: number;
  uniqueJonasDepts: number;
  subAccountPopulated: number;
};

export type NormalizationBlockerCode =
  | "UNKNOWN_ACCOUNT"
  | "DUPLICATE_ACCOUNT"
  | "UNKNOWN_DEPARTMENT"
  | "MISSING_REQUIRED_DEPARTMENT"
  | "UNKNOWN_JONAS_DEPARTMENT"
  | "MISSING_SPECTRE_DEPARTMENT"
  | "SUB_ACCOUNT_POPULATED";

export type NormalizationBlocker = {
  code: NormalizationBlockerCode;
  reason: string;
  details: string[];
};

export type NormalizationResult = {
  rows: NormalizedJonasRow[];
  counts: NormalizationCounts;
  blockers: NormalizationBlocker[];
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function descriptionsMatchNormalised(a: string, b: string): boolean {
  const normalise = (s: string): string =>
    s.trim().toLowerCase().replace(/[\s,;.]+/g, " ").replace(/[^a-z0-9 ]/g, "").trim();
  return normalise(a) === normalise(b);
}

// ---------------------------------------------------------------------------
// The normalizer
// ---------------------------------------------------------------------------

export function normalizeJonasImport(args: {
  parseResult: Pick<JonasGlCsvParseSuccess, "rows" | "detectedFormat">;
  spectreAccounts: ReadonlyArray<{
    id: string;
    accountNumber: string;
    name: string;
    departmentPolicy: string;
  }>;
  tenantDepartments: ReadonlyArray<{ code: string; name: string }>;
  jonasAccountMapping: JonasAccountMapping;
  departmentMapping?: Readonly<Record<string, string | null>>;
}): NormalizationResult {
  const {
    parseResult,
    spectreAccounts,
    tenantDepartments,
    jonasAccountMapping,
    departmentMapping = DEFAULT_JONAS_DEPARTMENT_MAPPING,
  } = args;

  const isDepartmental = parseResult.detectedFormat === "jonas-departmental";
  const spectreByCode = new Map(spectreAccounts.map((a) => [a.accountNumber, a]));
  const tenantDeptCodes = new Set(tenantDepartments.map((d) => d.code.trim().toUpperCase()));

  const rows: NormalizedJonasRow[] = [];
  let mappedCount = 0;
  let unmappedCount = 0;
  let descriptionConflicts = 0;
  let missingRequiredDeptCount = 0;
  let unknownDeptCount = 0;
  let unknownJonasDeptCount = 0;
  let missingSpectreDeptCount = 0;
  let subAccountPopulatedCount = 0;
  const uniqueJonasDepts = new Set<string>();
  const seenDimKeys = new Set<string>();
  const duplicateDimKeys = new Set<string>();
  const unknownAccounts = new Set<string>();
  const unknownJonasDepts = new Set<string>();
  const missingSpectreDepts = new Set<string>();
  const missingRequiredDeptAccounts = new Set<string>();
  const unknownSpectreDeptCodes = new Set<string>();
  const subAccountRows: string[] = [];

  for (const r of parseResult.rows as ReadonlyArray<JonasGlCsvRow>) {
    const code = r.accountNumber;
    const rawDept = r.department && r.department.trim().length > 0 ? r.department.trim() : null;
    const rawDeptDesc = r.departmentDescription ?? null;
    if (rawDept) uniqueJonasDepts.add(rawDept);
    if (r.subAccountCode && r.subAccountCode.trim().length > 0) {
      subAccountPopulatedCount++;
      subAccountRows.push(`${r.accountNumber}/${rawDept ?? ""}/${r.subAccountCode}`);
    }

    // Resolve Jonas → Spectre dept ONLY for the departmental format.
    let spectreDeptCode: string | null = rawDept;
    let resolutionStatus: "ok" | "unknown-jonas-dept" | "missing-spectre-dept" = "ok";
    if (isDepartmental && rawDept !== null) {
      const resolved = resolveJonasDepartment(rawDept, rawDeptDesc, tenantDepartments, departmentMapping);
      if (resolved.status === "ok") {
        spectreDeptCode = resolved.spectreCode;
      } else if (resolved.status === "unknown") {
        spectreDeptCode = null;
        resolutionStatus = "unknown-jonas-dept";
        unknownJonasDeptCount++;
        unknownJonasDepts.add(rawDept);
      } else {
        spectreDeptCode = resolved.spectreCode;
        resolutionStatus = "missing-spectre-dept";
        missingSpectreDeptCount++;
        missingSpectreDepts.add(resolved.spectreCode);
      }
    }

    // Dimensional dup-key — keyed on the RESOLVED Spectre code so
    // same-account/same-resolved-dept rows are flagged.
    const dimKey = `${code}\u0000${spectreDeptCode ? spectreDeptCode.toUpperCase() : ""}`;
    const isDup = seenDimKeys.has(dimKey);
    if (isDup) duplicateDimKeys.add(dimKey);
    seenDimKeys.add(dimKey);

    const spectre = spectreByCode.get(code) ?? null;
    const jonasCategory = mapJonasAccount(
      { accountNumber: code, accountDescription: r.accountDescription, jonasAccountType: r.jonasAccountType },
      jonasAccountMapping,
    );

    // Account mapping status.
    let mappingStatus: NormalizedJonasRow["mappingStatus"];
    if (isDup) {
      mappingStatus = "duplicate";
    } else if (!spectre) {
      mappingStatus = "unmapped";
      unmappedCount++;
      unknownAccounts.add(code);
    } else if (
      spectre.name.trim().toLowerCase() !== r.accountDescription.trim().toLowerCase() &&
      !descriptionsMatchNormalised(spectre.name, r.accountDescription)
    ) {
      mappingStatus = "description-conflict";
      descriptionConflicts++;
      mappedCount++;
    } else {
      mappingStatus = "mapped";
      mappedCount++;
    }

    // Department status against account policy.
    let departmentStatus: NormalizedJonasRow["departmentStatus"];
    if (resolutionStatus === "unknown-jonas-dept") {
      departmentStatus = "unknown-jonas-dept";
    } else if (resolutionStatus === "missing-spectre-dept") {
      departmentStatus = "missing-spectre-dept";
    } else if (!spectre) {
      departmentStatus = "n/a";
    } else if (spectre.departmentPolicy === "NOT_APPLICABLE") {
      // Account doesn't carry a department — null-ify any resolved
      // code (prevents a Balance Sheet row with a stale Jonas dept
      // leaking into the snapshot).
      spectreDeptCode = null;
      departmentStatus = "n/a";
    } else if (spectreDeptCode === null) {
      departmentStatus = spectre.departmentPolicy === "REQUIRED" ? "missing-required" : "n/a";
    } else if (!tenantDeptCodes.has(spectreDeptCode.toUpperCase())) {
      departmentStatus = "unknown-dept";
      unknownSpectreDeptCodes.add(spectreDeptCode);
    } else {
      departmentStatus = "ok";
    }
    if (departmentStatus === "missing-required") {
      missingRequiredDeptCount++;
      missingRequiredDeptAccounts.add(code);
    }
    if (departmentStatus === "unknown-dept") unknownDeptCount++;

    rows.push({
      lineNumber: r.lineNumber,
      accountCode: code,
      accountDescription: r.accountDescription,
      spectreAccountName: spectre?.name ?? null,
      spectreAccountId: spectre?.id ?? null,
      spectreAccountDepartmentPolicy: (spectre?.departmentPolicy as NormalizedJonasRow["spectreAccountDepartmentPolicy"]) ?? null,
      department: spectreDeptCode,
      fund: jonasCategory?.fund ?? null,
      jonasDepartmentCode: isDepartmental ? rawDept : null,
      jonasDepartmentDescription: isDepartmental ? rawDeptDesc : null,
      debit: r.debit ?? 0,
      credit: Math.abs(r.credit ?? 0),
      periodBalance: r.periodBalance,
      ytdBalance: r.ytdBalance,
      fiscalYear: r.fiscalYear,
      fiscalPeriod: r.fiscalPeriod,
      mappingStatus,
      departmentStatus,
      dimKey,
      isDuplicate: isDup,
    });
  }

  // Ordered list of blockers (same order the commit path returns).
  const blockers: NormalizationBlocker[] = [];
  if (unknownJonasDepts.size > 0) {
    blockers.push({
      code: "UNKNOWN_JONAS_DEPARTMENT",
      reason: `${unknownJonasDepts.size} source Jonas Department code(s) have no explicit mapping to a Spectre Department.`,
      details: Array.from(unknownJonasDepts),
    });
  }
  if (missingSpectreDepts.size > 0) {
    blockers.push({
      code: "MISSING_SPECTRE_DEPARTMENT",
      reason: `${missingSpectreDepts.size} Spectre Department(s) named by the Jonas mapping are not configured on the tenant.`,
      details: Array.from(missingSpectreDepts),
    });
  }
  if (subAccountRows.length > 0) {
    blockers.push({
      code: "SUB_ACCOUNT_POPULATED",
      reason: `${subAccountRows.length} source row(s) carry a non-blank G/L Sub-Account value.`,
      details: subAccountRows.slice(0, 20),
    });
  }
  if (unknownAccounts.size > 0) {
    blockers.push({
      code: "UNKNOWN_ACCOUNT",
      reason: `${unknownAccounts.size} source account(s) do not resolve to the Spectre Chart of Accounts.`,
      details: Array.from(unknownAccounts),
    });
  }
  if (duplicateDimKeys.size > 0) {
    blockers.push({
      code: "DUPLICATE_ACCOUNT",
      reason: `${duplicateDimKeys.size} duplicate (account, department) key(s) in the source file.`,
      details: Array.from(duplicateDimKeys).map((k) => k.replace(/\u0000/, "/")),
    });
  }
  if (unknownSpectreDeptCodes.size > 0) {
    blockers.push({
      code: "UNKNOWN_DEPARTMENT",
      reason: `${unknownSpectreDeptCodes.size} unknown Spectre Department code(s) in the resolved rows.`,
      details: Array.from(unknownSpectreDeptCodes),
    });
  }
  if (missingRequiredDeptAccounts.size > 0) {
    blockers.push({
      code: "MISSING_REQUIRED_DEPARTMENT",
      reason: `${missingRequiredDeptAccounts.size} source row(s) target an account whose departmentPolicy is REQUIRED but carry no Department tag.`,
      details: Array.from(missingRequiredDeptAccounts),
    });
  }

  return {
    rows,
    counts: {
      rowCount: rows.length,
      mapped: mappedCount,
      unmapped: unmappedCount,
      descriptionConflicts,
      duplicates: duplicateDimKeys.size,
      missingRequiredDept: missingRequiredDeptCount,
      unknownDept: unknownDeptCount,
      unknownJonasDept: unknownJonasDeptCount,
      missingSpectreDept: missingSpectreDeptCount,
      uniqueJonasDepts: uniqueJonasDepts.size,
      subAccountPopulated: subAccountPopulatedCount,
    },
    blockers,
  };
}

// ---------------------------------------------------------------------------
// Commit-CSV builder
// ---------------------------------------------------------------------------
//
// After the normalizer produces resolved rows (Spectre dept codes
// instead of Jonas dept codes), the commit path emits a NEW CSV that
// the existing JonasGlImporter re-parses + persists. This is the
// single bridge between the normalized dimensional model and the
// ReportingLedgerSnapshot writer — no raw Jonas 6-digit department
// code ever reaches a snapshot payload.

function csvQuote(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * Serialize normalized rows into a spectre-canonical CSV string that
 * `parseJonasGlCsv` consumes. The Department column carries the
 * RESOLVED Spectre dept code (or empty for nondepartmental rows).
 * Preserves the same column shape the normaliser's native-format
 * path emits, so the importer flows through unchanged.
 */
export function buildCommitCsvFromNormalized(rows: ReadonlyArray<NormalizedJonasRow>): string {
  const header = [
    "AccountNumber", "AccountDescription", "PeriodBalance", "YTDBalance",
    "FiscalYear", "FiscalPeriod", "Debit", "Credit", "Department",
  ];
  const out: string[][] = [header];
  for (const r of rows) {
    out.push([
      r.accountCode,
      r.accountDescription,
      String(r.periodBalance),
      String(r.ytdBalance),
      r.fiscalYear,
      String(r.fiscalPeriod),
      String(r.debit),
      String(r.credit),
      r.department ?? "",
    ]);
  }
  return out.map((row) => row.map(csvQuote).join(",")).join("\n");
}
