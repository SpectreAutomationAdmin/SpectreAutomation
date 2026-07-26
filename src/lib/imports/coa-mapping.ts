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

export type CoaMappingOptions = {
  types: ReadonlyArray<AccountTypeKey>;
  categories: ReadonlyArray<CoaCategoryOption>;
  fsGroups: ReadonlyArray<CoaFsGroupOption>;
  departments: ReadonlyArray<CoaDepartmentOption>;
};

/**
 * Fetch the per-club dropdown options the COA mapping table needs.
 * Categories come from the AccountCategory table; FS groups from
 * FinancialStatementGroup; departments from Department (active only).
 */
export async function getCoaMappingOptions(clubId: string): Promise<CoaMappingOptions> {
  const [categories, fsGroups, departments] = await Promise.all([
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

  return {
    number,
    name,
    type,
    categoryKey: categoryKey ?? null,
    fsGroupKey: fsGroupKey ?? null,
    departmentCodes,
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
