// Sprint 3 Checkpoint 15I-4 (2026-07-27) — Source-contract locks for the
// tenant accounting bootstrap:
//   • ensureStandardAccountingConfiguration exists as a named export and
//     is idempotent + non-destructive by contract (never DELETEs / never
//     overwrites existing rows).
//   • The COA import server action (both the CoA-workspace modal and
//     the generic /app/admin/imports action) calls ensure() BEFORE
//     parsing the file, so a bare tenant is auto-repaired instead of
//     producing 237 misleading "not configured for this club" rows.
//   • The COA row validator emits a bootstrap-aware error message when
//     the tenant has zero categories / zero FS groups, without changing
//     the emitted error codes (UNKNOWN_CATEGORY / UNKNOWN_FS_GROUP).
//   • isTenantMissingStandardTaxonomy is exposed for page-level banners.
//   • The ensure service does NOT auto-seed DEFAULT_ACCOUNTS (the
//     founder imports these) or fiscal years (owned by periods.ts).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isTenantMissingStandardTaxonomy,
  resolveCoaRow,
  type CoaMappingOptions,
} from "@/lib/imports/coa-mapping";

function read(p: string) {
  return readFileSync(join(process.cwd(), p), "utf8");
}

const ENSURE       = read("src/lib/accounting/ensure-standard-configuration.ts");
const COA_MODAL_ACT = read("src/app/app/admin/coa/_import-actions.ts");
const GENERIC_ACT   = read("src/app/app/admin/imports/_actions.ts");
const COA_MAPPING   = read("src/lib/imports/coa-mapping.ts");

describe("ensureStandardAccountingConfiguration — contract", () => {
  it("exports the named function and its boolean helper", () => {
    expect(ENSURE).toMatch(/export async function ensureStandardAccountingConfiguration\(\s*clubId: string,?\s*\)/);
    expect(ENSURE).toMatch(/export async function clubHasStandardAccountingConfiguration\(\s*clubId: string,?\s*\)/);
  });

  it("returns a structured result with before/after counts + inserted keys", () => {
    expect(ENSURE).toMatch(/insertedCategoryKeys: string\[\]/);
    expect(ENSURE).toMatch(/insertedFsGroupKeys: string\[\]/);
    expect(ENSURE).toMatch(/insertedDepartmentCodes: string\[\]/);
    expect(ENSURE).toMatch(/before: \{ categories: number; fsGroups: number; departments: number \}/);
    expect(ENSURE).toMatch(/after: \{ categories: number; fsGroups: number; departments: number \}/);
    expect(ENSURE).toMatch(/elapsedMs: number/);
  });

  it("pre-snapshots the existing tenant keys (idempotency guard)", () => {
    // The service must read the existing keys BEFORE inserting so
    // it only inserts missing rows.
    expect(ENSURE).toMatch(/prisma\.accountCategory\.findMany\(\s*\{\s*where: \{ clubId \}/);
    expect(ENSURE).toMatch(/prisma\.financialStatementGroup\.findMany\(\s*\{\s*where: \{ clubId \}/);
    expect(ENSURE).toMatch(/prisma\.department\.findMany\(\s*\{\s*where: \{ clubId \}/);
    expect(ENSURE).toMatch(/const existingCategoryKeys = new Set/);
    expect(ENSURE).toMatch(/const existingFsGroupKeys = new Set/);
    expect(ENSURE).toMatch(/const existingDepartmentCodes = new Set/);
  });

  it("filters DEFAULT_* against the existing-keys sets before inserting", () => {
    expect(ENSURE).toMatch(/DEFAULT_CATEGORIES\.filter\(\s*\(c\) => !existingCategoryKeys\.has\(c\.key\)/);
    expect(ENSURE).toMatch(/DEFAULT_FS_GROUPS\.filter\(\s*\(g\) => !existingFsGroupKeys\.has\(g\.key\)/);
    expect(ENSURE).toMatch(/DEFAULT_DEPARTMENTS\.filter\(\s*\(d\) => !existingDepartmentCodes\.has\(d\.code\)/);
  });

  it("is non-destructive — no delete / deleteMany / updateMany on the taxonomy tables", () => {
    // Guardrail: the service must never overwrite or destroy existing
    // founder-customised rows on these tables.
    expect(ENSURE).not.toMatch(/prisma\.accountCategory\.delete/);
    expect(ENSURE).not.toMatch(/prisma\.accountCategory\.deleteMany/);
    expect(ENSURE).not.toMatch(/prisma\.accountCategory\.updateMany/);
    expect(ENSURE).not.toMatch(/prisma\.financialStatementGroup\.delete/);
    expect(ENSURE).not.toMatch(/prisma\.financialStatementGroup\.deleteMany/);
    expect(ENSURE).not.toMatch(/prisma\.financialStatementGroup\.updateMany/);
    expect(ENSURE).not.toMatch(/prisma\.department\.delete/);
    expect(ENSURE).not.toMatch(/prisma\.department\.deleteMany/);
    expect(ENSURE).not.toMatch(/prisma\.department\.updateMany/);
  });

  it("only opens update-empty upsert branches for child FS groups (parent FK resolution) — no other upsert path can rewrite founder data", () => {
    // The only upsert path is the child-FS-groups block for parent FK
    // resolution, and its update payload is empty (preserves founder
    // customisation on race). Assert exactly one upsert call, and that
    // it targets the tenant-scoped composite unique.
    const upsertMatches = ENSURE.match(/\.upsert\(/g) ?? [];
    expect(upsertMatches.length).toBe(1);
    expect(ENSURE).toMatch(/prisma\.financialStatementGroup\.upsert\(\s*\{\s*where: \{ clubId_key: \{ clubId, key: g\.key \} \}/);
    expect(ENSURE).toMatch(/update: \{\},/);
  });

  it("does NOT seed DEFAULT_ACCOUNTS (founder imports these)", () => {
    // Auto-seeding accounts would collide with imported rows and
    // duplicate the founder's Chart of Accounts. The header comment
    // may mention DEFAULT_ACCOUNTS to explain the exclusion — assert
    // the module does not IMPORT it, and never writes to the
    // Account table.
    expect(ENSURE).not.toMatch(/import[\s\S]{0,80}DEFAULT_ACCOUNTS/);
    expect(ENSURE).not.toMatch(/prisma\.account\.create/);
    expect(ENSURE).not.toMatch(/prisma\.account\.upsert/);
  });

  it("does NOT seed fiscal years (owned by periods.ts / ensureFiscalYear)", () => {
    // Period bootstrap lives elsewhere; this service must stay narrow.
    expect(ENSURE).not.toMatch(/fiscalYear\.create/);
    expect(ENSURE).not.toMatch(/fiscalYear\.upsert/);
    expect(ENSURE).not.toMatch(/period\.create/);
  });

  it("scopes every insert with clubId (tenant safety)", () => {
    // Every insert data object must carry clubId; no cross-tenant leak.
    expect(ENSURE).toMatch(/data: categoriesToInsert\.map\(\(c\) => \(\{\s*clubId,/);
    expect(ENSURE).toMatch(/data: rootFsGroups\.map\(\(g\) => \(\{\s*clubId,/);
    expect(ENSURE).toMatch(/data: departmentsToInsert\.map\(\(d, i\) => \(\{\s*clubId,/);
  });

  it("emits a completion log line for staging correlation", () => {
    expect(ENSURE).toMatch(/logger\.info\("ensure-standard-accounting\.completed"/);
    expect(ENSURE).toMatch(/elapsedMs: result\.elapsedMs/);
  });
});

describe("COA import server actions — wire ensure() BEFORE parsing the file", () => {
  it("the CoA-workspace modal action calls ensureStandardAccountingConfiguration before touching the upload", () => {
    // Import present.
    expect(COA_MODAL_ACT).toMatch(/import \{ ensureStandardAccountingConfiguration \} from "@\/lib\/accounting\/ensure-standard-configuration"/);
    // Called with the resolved clubId.
    expect(COA_MODAL_ACT).toMatch(/await ensureStandardAccountingConfiguration\(clubId\);/);
    // Must run BEFORE the file bytes are pulled off the form. Guard
    // against a future refactor that moves the call after parsing.
    const ensureIdx = COA_MODAL_ACT.indexOf("await ensureStandardAccountingConfiguration(clubId)");
    const parseIdx  = COA_MODAL_ACT.indexOf("formData.get(\"file\")");
    expect(ensureIdx).toBeGreaterThan(0);
    expect(parseIdx).toBeGreaterThan(ensureIdx);
  });

  it("the generic imports action calls ensure() only for COA domain, before parsing", () => {
    expect(GENERIC_ACT).toMatch(/import \{ ensureStandardAccountingConfiguration \} from "@\/lib\/accounting\/ensure-standard-configuration"/);
    // Gated on isCoa so TB / other domains aren't slowed by an
    // unrelated tenant-taxonomy bootstrap.
    expect(GENERIC_ACT).toMatch(/if \(isCoa\) \{\s*await ensureStandardAccountingConfiguration\(clubId\);\s*\}/);
    // Must run BEFORE parsing the file bytes.
    const ensureIdx = GENERIC_ACT.indexOf("await ensureStandardAccountingConfiguration(clubId)");
    const parseIdx  = GENERIC_ACT.indexOf("createBatch(principal,");
    expect(ensureIdx).toBeGreaterThan(0);
    expect(parseIdx).toBeGreaterThan(ensureIdx);
  });
});

describe("COA row validator — bootstrap-aware error messaging", () => {
  it("emits UNKNOWN_CATEGORY code but with a bootstrap-diagnostic message when the tenant has zero categories", () => {
    const options: CoaMappingOptions = {
      types: ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const,
      categories: [],
      fsGroups: [{ id: "g1", key: "BS_CASH_EQUIVALENTS", name: "Cash & equivalents", statement: "BALANCE_SHEET" }],
      departments: [],
    };
    const result = resolveCoaRow(
      { number: "1000", name: "Operating Cash", type: "ASSET", categoryKey: "CURRENT_ASSETS", fsGroupKey: "BS_CASH_EQUIVALENTS" },
      options,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const catError = result.errors.find((e) => e.code === "UNKNOWN_CATEGORY");
    expect(catError).toBeDefined();
    // Code must NOT change (existing tests + UI branches rely on it).
    expect(catError!.code).toBe("UNKNOWN_CATEGORY");
    // Message must clearly point at the tenant taxonomy, not the row.
    expect(catError!.message).toMatch(/categories are not installed on this club/);
    expect(catError!.message).toMatch(/CURRENT_ASSETS/);
  });

  it("emits UNKNOWN_FS_GROUP code with a bootstrap-diagnostic message when the tenant has zero FS groups", () => {
    const options: CoaMappingOptions = {
      types: ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const,
      categories: [{ id: "c1", key: "CURRENT_ASSETS", name: "Current assets", accountType: "ASSET" }],
      fsGroups: [],
      departments: [],
    };
    const result = resolveCoaRow(
      { number: "1000", name: "Operating Cash", type: "ASSET", categoryKey: "CURRENT_ASSETS", fsGroupKey: "BS_CASH_EQUIVALENTS" },
      options,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const fsError = result.errors.find((e) => e.code === "UNKNOWN_FS_GROUP");
    expect(fsError).toBeDefined();
    expect(fsError!.code).toBe("UNKNOWN_FS_GROUP");
    expect(fsError!.message).toMatch(/financial statement groups are not installed on this club/);
    expect(fsError!.message).toMatch(/BS_CASH_EQUIVALENTS/);
  });

  it("emits the original per-row 'not configured for this club' message when the tenant IS bootstrapped and a row references an unknown key", () => {
    // Guard: bootstrap-aware branch fires ONLY on empty taxonomy —
    // a genuine mapping typo on a configured tenant keeps the
    // pre-existing operator-facing message.
    const options: CoaMappingOptions = {
      types: ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const,
      categories: [{ id: "c1", key: "CURRENT_ASSETS", name: "Current assets", accountType: "ASSET" }],
      fsGroups: [{ id: "g1", key: "BS_CASH_EQUIVALENTS", name: "Cash & equivalents", statement: "BALANCE_SHEET" }],
      departments: [],
    };
    const result = resolveCoaRow(
      { number: "1000", name: "Operating Cash", type: "ASSET", categoryKey: "MADE_UP_KEY", fsGroupKey: "MADE_UP_FS" },
      options,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const catError = result.errors.find((e) => e.code === "UNKNOWN_CATEGORY");
    const fsError = result.errors.find((e) => e.code === "UNKNOWN_FS_GROUP");
    expect(catError!.message).toBe('categoryKey "MADE_UP_KEY" is not configured for this club');
    expect(fsError!.message).toBe('fsGroupKey "MADE_UP_FS" is not configured for this club');
  });

  it("resolves cleanly on a bootstrapped tenant with the canonical keys the CSV uses", () => {
    // The exact keys the Coulee Ridge CSV uses — after ensure() runs,
    // these must validate.
    const options: CoaMappingOptions = {
      types: ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const,
      categories: [{ id: "c1", key: "CURRENT_ASSETS", name: "Current assets", accountType: "ASSET" }],
      fsGroups: [{ id: "g1", key: "BS_CASH_EQUIVALENTS", name: "Cash & equivalents", statement: "BALANCE_SHEET" }],
      departments: [],
    };
    const result = resolveCoaRow(
      { number: "1000", name: "Operating Cash", type: "ASSET", categoryKey: "CURRENT_ASSETS", fsGroupKey: "BS_CASH_EQUIVALENTS" },
      options,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.resolved.categoryKey).toBe("CURRENT_ASSETS");
    expect(result.resolved.fsGroupKey).toBe("BS_CASH_EQUIVALENTS");
  });
});

describe("isTenantMissingStandardTaxonomy helper", () => {
  const baseOptions = {
    categories: [{ id: "c1", key: "CURRENT_ASSETS", name: "Current assets", accountType: "ASSET" as const }],
    fsGroups: [{ id: "g1", key: "BS_CASH_EQUIVALENTS", name: "Cash & equivalents", statement: "BALANCE_SHEET" }],
  };

  it("returns true when categories are empty", () => {
    expect(isTenantMissingStandardTaxonomy({ ...baseOptions, categories: [] })).toBe(true);
  });

  it("returns true when FS groups are empty", () => {
    expect(isTenantMissingStandardTaxonomy({ ...baseOptions, fsGroups: [] })).toBe(true);
  });

  it("returns true when both are empty (the current Coulee Ridge state)", () => {
    expect(isTenantMissingStandardTaxonomy({ categories: [], fsGroups: [] })).toBe(true);
  });

  it("returns false when both taxonomy tables have rows", () => {
    expect(isTenantMissingStandardTaxonomy(baseOptions)).toBe(false);
  });
});

describe("Placeholder scan — the new files carry no forbidden markers", () => {
  it("ensure-standard-configuration.ts", () => {
    expect(ENSURE).not.toMatch(/TODO|coming soon|not implemented|placeholder|scaffold only|future implementation|temporary/i);
  });
  it("coa-mapping.ts (edited region)", () => {
    // The new bootstrap-aware branch must not carry any placeholder markers.
    const region = COA_MAPPING.slice(COA_MAPPING.indexOf("Detect the tenant-bootstrap defect"));
    expect(region).not.toMatch(/TODO|coming soon|not implemented|placeholder|scaffold only|future implementation|temporary/i);
  });
});
