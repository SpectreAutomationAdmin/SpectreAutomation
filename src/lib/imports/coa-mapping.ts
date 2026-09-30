// Chart-of-Accounts import — mapping support.
//
// The simplified COA upload format is just `number,name`. The
// operator then maps each row's account type, category, FS group,
// and one or more departments via the in-page mapping table.
//
// This module provides:
//   • the canonical list of valid account types (single source of
//     truth, also re-exported as `ACCOUNT_TYPES`)
//   • a per-club dropdown-options loader that returns categories,
//     financial-statement groups, and departments straight from
//     the DB so the UI never invents keys the system doesn't know
//     about
//   • a normalised row shape `CoaRowMapping` the save-mapping
//     action persists into `ImportRow.rawJson`
//   • a validator that takes a CoaRowMapping + the dropdown-options
//     and either returns a fully-resolved (categoryId, fsGroupId,
//     departmentIds[]) bundle or per-field errors
//
// Tenant safety: every lookup is `clubId`-scoped. The validator
// rejects any key the operator submits that isn't on the
// per-club lists.

import { prisma } from "@/lib/prisma";

import type { ImportDomain } from "./templates";

// Re-exported so callers don't have to know the const lives in
// accounting/types.ts.
export const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const;
export type AccountTypeKey = (typeof ACCOUNT_TYPES)[number];

export type CoaCategoryOption = {
  id: string;
  key: string;
  name: string;
  /** AccountType this category is valid for (used to filter the
   *  category dropdown when a type is already selected). */
  accountType: AccountTypeKey;
};

export type CoaFsGroupOption = {
  id: string;
  key: string;
  name: string;
  /** BALANCE_SHEET | INCOME_STATEMENT | CASH_FLOW — surfaced so
   *  the dropdown can group entries by statement. */
  statement: string;
};

export type CoaDepartmentOption = {
  id: string;
  code: string;
  name: string;
};

// DIM-2a (2026-09-29) — per-club Fund catalog for AccountFund
// applicability validation. When the operator's mapping proposes
// a Fund key that is not in this list, the resolver emits an
// UNKNOWN_FUND ImportError and the row does not commit.
export type CoaFundOption = {
  id: string;
  key: string;
  name: string;
};

export type CoaMappingOptions = {
  types: ReadonlyArray<AccountTypeKey>;
  categories: ReadonlyArray<CoaCategoryOption>;
  fsGroups: ReadonlyArray<CoaFsGroupOption>;
  departments: ReadonlyArray<CoaDepartmentOption>;
  funds: ReadonlyArray<CoaFundOption>;
};

/**
 * Fetch the per-club dropdown options the COA mapping table needs.
 * Categories come from the AccountCategory table; FS groups from
 * FinancialStatementGroup; departments from Department (active only).
 */
export async function getCoaMappingOptions(clubId: string): Promise<CoaMappingOptions> {
  const [categories, fsGroups, departments, funds] = await Promise.all([
    prisma.accountCategory.findMany({
      where: { clubId },
      orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, key: true, name: true, type: true },
    }),
    prisma.financialStatementGroup.findMany({
      where: { clubId },
      orderBy: [{ statement: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, key: true, name: true, statement: true },
    }),
    prisma.department.findMany({
      where: { clubId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, code: true, name: true },
    }),
    // DIM-2a (2026-09-29) — per-club Fund catalog. Only ACTIVE funds
    // are eligible for applicability; deactivated funds are not
    // valid AccountFund targets.
    prisma.fund.findMany({
      where: { clubId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
      select: { id: true, key: true, name: true },
    }),
  ]);

  return {
    types: ACCOUNT_TYPES,
    categories: categories.map((c) => ({
      id: c.id,
      key: c.key,
      name: c.name,
      // `type` is a String column on AccountCategory ("ASSET", etc.).
      accountType: (c.type as AccountTypeKey),
    })),
    fsGroups: fsGroups.map((g) => ({
      id: g.id,
      key: g.key,
      name: g.name,
      statement: g.statement,
    })),
    departments: departments.map((d) => ({
      id: d.id,
      code: d.code,
      name: d.name,
    })),
    funds: funds.map((f) => ({ id: f.id, key: f.key, name: f.name })),
  };
}

// ---------------------------------------------------------------------------
// Row shape persisted into ImportRow.rawJson after the operator
// maps each account.
// ---------------------------------------------------------------------------

export type CoaRowMapping = {
  number: string;
  name: string;
  type?: AccountTypeKey | null;
  categoryKey?: string | null;
  fsGroupKey?: string | null;
  /** Multi-department assignment. The legacy single-string
   *  `departmentCode` field is normalised into this array at parse
   *  time so the rest of the code only deals with one shape. */
  departmentCodes?: string[];
  /**
   * DIM-2 (2026-09-29) — canonical Fund key applicability
   * proposal set (e.g. `["OPERATING"]`, `["CAPITAL","OPERATING"]`).
   * Parsed from the predictor's `fundApplicability` CSV or from
   * an explicit workbook column; used by the commit path to
   * reconcile AccountFund rows.
   */
  fundApplicabilityKeys?: string[];
  /**
   * DIM-2 (2026-09-29) — Account.departmentPolicy proposal.
   * REQUIRED / OPTIONAL / NOT_APPLICABLE. Predicted or explicit.
   * The operator may override in the COA preview before commit.
   */
  departmentPolicy?: "REQUIRED" | "OPTIONAL" | "NOT_APPLICABLE" | null;
  /** DIM-2 — Account.fundPolicy proposal, same enum. */
  fundPolicy?: "REQUIRED" | "OPTIONAL" | "NOT_APPLICABLE" | null;
  /**
   * DIM-2 (2026-09-29) — legacy CSV, dual-write only. New consumers
   * MUST read `fundApplicabilityKeys` instead. See
   * `docs/dim-1-legacy-fund-applicability.md`.
   */
  fundApplicability?: string | null;
};

/**
 * Coerce whatever shape the parsed CSV / saved row uses into the
 * canonical CoaRowMapping shape. Handles:
 *   • Legacy COA CSVs with single-string `departmentCode`
 *   • Simple uploads with only `number`/`name`
 *   • Mid-mapping rows that have some fields filled in
 */
export function normaliseCoaRow(raw: Record<string, unknown>): CoaRowMapping {
  const number = stringOrEmpty(raw.number);
  const name = stringOrEmpty(raw.name);
  const typeRaw = stringOrEmpty(raw.type).toUpperCase();
  const type = (ACCOUNT_TYPES as readonly string[]).includes(typeRaw)
    ? (typeRaw as AccountTypeKey)
    : null;
  const categoryKey = stringOrNull(raw.categoryKey);
  const fsGroupKey = stringOrNull(raw.fsGroupKey);

  const departmentCodes: string[] = [];
  if (Array.isArray(raw.departmentCodes)) {
    for (const entry of raw.departmentCodes) {
      const s = stringOrEmpty(entry).trim();
      if (s.length > 0) departmentCodes.push(s);
    }
  } else if (typeof raw.departmentCodes === "string") {
    // Workbook path: the COA XLSX template surfaces the
    // Departments column as a single semicolon-delimited string
    // (e.g. "ADMIN;GROUNDS;F&B"). Split it and trust the
    // resolver to flag any code that isn't in the club's
    // configured department set.
    for (const entry of raw.departmentCodes.split(/[;,]/)) {
      const s = entry.trim();
      if (s.length > 0) departmentCodes.push(s);
    }
  } else if (typeof raw.departmentCode === "string" && raw.departmentCode.trim().length > 0) {
    // Legacy single-string CSV.
    departmentCodes.push(raw.departmentCode.trim());
  }

  // DIM-2 (2026-09-29) — dimensional policy + fund applicability
  // normalisation. The commit path uses these to persist
  // Account.departmentPolicy / fundPolicy and to reconcile
  // AccountFund rows. Legacy `fundApplicability` CSV is preserved
  // for dual-write compatibility.
  const fundKeysFromArray = Array.isArray(raw.fundApplicabilityKeys)
    ? raw.fundApplicabilityKeys.map((v) => stringOrEmpty(v).trim().toUpperCase()).filter((s) => s.length > 0)
    : null;
  const fundApplicabilityCsv = stringOrNull(raw.fundApplicability);
  const fundApplicabilityKeys = fundKeysFromArray && fundKeysFromArray.length > 0
    ? Array.from(new Set(fundKeysFromArray)).sort()
    : fundApplicabilityCsv
      ? Array.from(new Set(
          fundApplicabilityCsv.split(/[,;]/).map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0),
        )).sort()
      : [];

  const departmentPolicyRaw = stringOrEmpty(raw.departmentPolicy).toUpperCase();
  const departmentPolicy = (
    departmentPolicyRaw === "REQUIRED" || departmentPolicyRaw === "OPTIONAL" || departmentPolicyRaw === "NOT_APPLICABLE"
  )
    ? (departmentPolicyRaw as "REQUIRED" | "OPTIONAL" | "NOT_APPLICABLE")
    : null;

  const fundPolicyRaw = stringOrEmpty(raw.fundPolicy).toUpperCase();
  const fundPolicy = (
    fundPolicyRaw === "REQUIRED" || fundPolicyRaw === "OPTIONAL" || fundPolicyRaw === "NOT_APPLICABLE"
  )
    ? (fundPolicyRaw as "REQUIRED" | "OPTIONAL" | "NOT_APPLICABLE")
    : null;

  return {
    number,
    name,
    type,
    categoryKey: categoryKey ?? null,
    fsGroupKey: fsGroupKey ?? null,
    departmentCodes,
    fundApplicabilityKeys,
    departmentPolicy,
    fundPolicy,
    fundApplicability: fundApplicabilityCsv,
  };
}

function stringOrEmpty(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return String(v);
}

function stringOrNull(v: unknown): string | null {
  const s = stringOrEmpty(v).trim();
  return s.length === 0 ? null : s;
}

// ---------------------------------------------------------------------------
// Resolve a mapped row to FK ids. Returns the resolved bundle when
// every field is supplied + valid; otherwise a list of per-field
// errors the validator surfaces on the ImportRow.
// ---------------------------------------------------------------------------

export type CoaResolutionError = {
  code: string;
  message: string;
  columnName?: string;
};

export type CoaResolvedRow = {
  number: string;
  name: string;
  type: AccountTypeKey;
  normalBalance: "DEBIT" | "CREDIT";
  categoryId: string;
  categoryKey: string;
  fsGroupId: string;
  fsGroupKey: string;
  departmentIds: string[]; // may be empty (department is optional)
  departmentCodes: string[];
  // DIM-2 (2026-09-29) — dimensional proposals passed through to the
  // commit path. `explicitDefaultDepartmentId` remains null unless a
  // future importer surface explicitly names a primary department
  // (per DIM-2 Section 4: applicability != defaulting).
  explicitDefaultDepartmentId: string | null;
  departmentPolicy: "REQUIRED" | "OPTIONAL" | "NOT_APPLICABLE" | null;
  fundPolicy: "REQUIRED" | "OPTIONAL" | "NOT_APPLICABLE" | null;
  fundApplicabilityKeys: string[];
  fundApplicability: string | null;
  // DIM-2a (2026-09-29) — resolved AccountFund ids for the commit
  // path. Only valid tenant Fund keys make it here; unknown keys
  // are rejected upstream via UNKNOWN_FUND ImportError so the
  // commit never silently drops applicability metadata.
  fundIds: string[];
};

export type CoaResolutionResult =
  | { ok: true; resolved: CoaResolvedRow }
  | { ok: false; errors: ReadonlyArray<CoaResolutionError> };

/**
 * Validate + resolve a single COA row against the per-club options.
 *
 *   • number / name required
 *   • type required, must be one of ACCOUNT_TYPES
 *   • categoryKey required, must exist + match the selected type
 *   • fsGroupKey required, must exist on this club
 *   • departmentCodes optional, but every code provided must exist
 */
export function resolveCoaRow(
  row: CoaRowMapping,
  options: CoaMappingOptions,
): CoaResolutionResult {
  const errors: CoaResolutionError[] = [];

  if (!row.number) errors.push({ code: "REQUIRED", message: "number is required", columnName: "number" });
  if (!row.name) errors.push({ code: "REQUIRED", message: "name is required", columnName: "name" });

  const typeKey = row.type ?? null;
  if (!typeKey) {
    errors.push({ code: "REQUIRED", message: "type is required", columnName: "type" });
  } else if (!(ACCOUNT_TYPES as readonly string[]).includes(typeKey)) {
    errors.push({
      code: "INVALID_TYPE",
      message: `type "${typeKey}" is not one of ${ACCOUNT_TYPES.join(", ")}`,
      columnName: "type",
    });
  }

  // Detect the tenant-bootstrap defect: a club whose AccountCategory /
  // FinancialStatementGroup tables were never seeded will fail every
  // canonical row with "not configured for this club". Emit a more
  // truthful message pointing at the tenant configuration in that
  // state — the row itself is fine; the tenant is missing its
  // standard taxonomy. See ensureStandardAccountingConfiguration.
  const tenantMissingCategories = options.categories.length === 0;
  const tenantMissingFsGroups = options.fsGroups.length === 0;

  let category: CoaCategoryOption | undefined;
  if (!row.categoryKey) {
    errors.push({ code: "REQUIRED", message: "categoryKey is required", columnName: "categoryKey" });
  } else {
    category = options.categories.find((c) => c.key === row.categoryKey);
    if (!category) {
      errors.push({
        code: "UNKNOWN_CATEGORY",
        message: tenantMissingCategories
          ? `Chart-of-accounts categories are not installed on this club — reload the import after the standard taxonomy is bootstrapped, or contact support. (categoryKey "${row.categoryKey}")`
          : `categoryKey "${row.categoryKey}" is not configured for this club`,
        columnName: "categoryKey",
      });
    } else if (typeKey && category.accountType !== typeKey) {
      errors.push({
        code: "TYPE_CATEGORY_MISMATCH",
        message: `category "${category.name}" applies to ${category.accountType} accounts, not ${typeKey}`,
        columnName: "categoryKey",
      });
    }
  }

  let fsGroup: CoaFsGroupOption | undefined;
  if (!row.fsGroupKey) {
    errors.push({ code: "REQUIRED", message: "fsGroupKey is required", columnName: "fsGroupKey" });
  } else {
    fsGroup = options.fsGroups.find((g) => g.key === row.fsGroupKey);
    if (!fsGroup) {
      errors.push({
        code: "UNKNOWN_FS_GROUP",
        message: tenantMissingFsGroups
          ? `Chart-of-accounts financial statement groups are not installed on this club — reload the import after the standard taxonomy is bootstrapped, or contact support. (fsGroupKey "${row.fsGroupKey}")`
          : `fsGroupKey "${row.fsGroupKey}" is not configured for this club`,
        columnName: "fsGroupKey",
      });
    }
  }

  const departmentIds: string[] = [];
  const departmentCodes: string[] = [];
  for (const code of row.departmentCodes ?? []) {
    const dept = options.departments.find((d) => d.code === code);
    if (!dept) {
      errors.push({
        code: "UNKNOWN_DEPARTMENT",
        message: `department "${code}" is not configured for this club`,
        columnName: "departmentCode",
      });
      continue;
    }
    if (!departmentIds.includes(dept.id)) {
      departmentIds.push(dept.id);
      departmentCodes.push(dept.code);
    }
  }

  // DIM-2a (2026-09-29) — resolve AccountFund keys against the
  // tenant's Fund catalog. Unknown keys emit UNKNOWN_FUND per key
  // and fail the row so the commit path cannot silently discard
  // applicability metadata. Section 1 of DIM-2a.
  const fundIds: string[] = [];
  const seenFundKeys = new Set<string>();
  const validFundKeys = new Set<string>();
  for (const rawKey of row.fundApplicabilityKeys ?? []) {
    const key = rawKey.trim().toUpperCase();
    if (key.length === 0 || seenFundKeys.has(key)) continue;
    seenFundKeys.add(key);
    const fund = options.funds.find((f) => f.key === key);
    if (!fund) {
      errors.push({
        code: "UNKNOWN_FUND",
        message: `fund "${key}" is not configured for this club (or is inactive)`,
        columnName: "fundApplicability",
      });
      continue;
    }
    fundIds.push(fund.id);
    validFundKeys.add(fund.key);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const normalBalance: "DEBIT" | "CREDIT" =
    typeKey === "ASSET" || typeKey === "EXPENSE" ? "DEBIT" : "CREDIT";

  return {
    ok: true,
    resolved: {
      number: row.number,
      name: row.name,
      type: typeKey as AccountTypeKey,
      normalBalance,
      categoryId: category!.id,
      categoryKey: category!.key,
      fsGroupId: fsGroup!.id,
      fsGroupKey: fsGroup!.key,
      departmentIds,
      departmentCodes,
      // DIM-2 (2026-09-29) — DIM-2 fields passed through so the
      // commit path can persist them on Account without a second
      // predictor pass.
      explicitDefaultDepartmentId: null,
      departmentPolicy: row.departmentPolicy ?? null,
      fundPolicy: row.fundPolicy ?? null,
      // DIM-2a (2026-09-29) — only fund keys that resolved to an
      // active tenant Fund make it into the resolved bundle. The
      // matching `fundIds` array is the commit path's authoritative
      // AccountFund reconcile source.
      fundApplicabilityKeys: Array.from(validFundKeys).sort(),
      fundApplicability: validFundKeys.size > 0
        ? Array.from(validFundKeys).sort().join(",")
        : null,
      fundIds,
    },
  };
}

// ---------------------------------------------------------------------------
// Tenant-bootstrap detection
// ---------------------------------------------------------------------------

/**
 * True when the tenant is missing the minimum standard COA taxonomy
 * (no AccountCategory rows AND/OR no FinancialStatementGroup rows).
 *
 * Use this on the mapping page to render a page-level banner that
 * distinguishes a broken tenant bootstrap from a row-level operator
 * mapping error. When true, EVERY canonical categoryKey / fsGroupKey
 * on the upload will fail validation regardless of the file quality.
 */
export function isTenantMissingStandardTaxonomy(
  options: Pick<CoaMappingOptions, "categories" | "fsGroups">,
): boolean {
  return options.categories.length === 0 || options.fsGroups.length === 0;
}

// ---------------------------------------------------------------------------
// Misc — used by tests that don't want to import the full bundle.
// ---------------------------------------------------------------------------

export const COA_DOMAIN: ImportDomain = "COA";
