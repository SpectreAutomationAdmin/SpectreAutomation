// TB-HIST-5 (2026-10-01) — Jonas → Spectre Department resolver.
//
// The real Jonas departmental Trial Balance (8 columns) ships a
// per-row "G/L Department Code" + "G/L Department Description". The
// snapshot grain Spectre persists is (Account × Spectre Department ×
// Fund × Period), so every source dept code must resolve to EITHER
// a Spectre Department code OR null (for genuinely nondepartmental
// rows such as the Jonas 000000 "Balance Sheet" marker).
//
// Design rules the resolver enforces:
//   1. Resolution is EXPLICIT. The 6-digit Jonas code maps through a
//      static table — no fuzzy name matching, no silent guesses, no
//      per-tenant auto-create.
//   2. The 000000 "Balance Sheet" code is NOT a real operating
//      department; it is Jonas's marker for genuinely nondepartmental
//      rows (Assets, Liabilities, Equity). Resolver returns null;
//      the downstream row carries department=null and the existing
//      departmentPolicy check decides whether the account allows it.
//   3. If a Jonas code has no mapping → `unknown` → commit blocks.
//   4. If a Jonas code maps to a Spectre dept the tenant doesn't
//      have → `missing-spectre-dept` → commit blocks (operator must
//      add the Department to the tenant before importing).
//   5. If a Jonas DESCRIPTION disagrees with the mapped Spectre
//      department's name → the resolver still succeeds (name
//      drift is normal) but the preview can flag it informationally.
//
// The mapping is tenant-agnostic because the Jonas department code
// space is a de-facto industry convention (0000NN). If a tenant uses
// non-standard Jonas codes, extend the mapping explicitly.

/** Result of resolving a single Jonas source department code against
 *  a Spectre tenant's Department catalog. */
export type JonasDepartmentResolution =
  /** Successful resolution. `spectreCode` is null for genuinely
   *  nondepartmental rows (the Jonas 000000 "Balance Sheet" marker). */
  | { status: "ok"; spectreCode: string | null; descriptionDrift: boolean }
  /** No mapping exists for this Jonas code at all. */
  | { status: "unknown"; jonasCode: string; jonasDescription: string | null }
  /** Mapping exists but the resolved Spectre dept isn't configured
   *  on the tenant yet. */
  | { status: "missing-spectre-dept"; jonasCode: string; spectreCode: string };

/**
 * TB-HIST-5 — default Jonas → Spectre department mapping.
 *
 * Keys are the 6-digit Jonas Department Code. Values are the Spectre
 * Department.code the tenant must have configured. A `null` value
 * means the Jonas code is a "nondepartmental marker" and the row
 * should carry department=null into the snapshot.
 *
 * The 12 codes below are the complete set in the Dec 31 2025
 * departmental workbook. If a future workbook introduces a new
 * Jonas code, add it here explicitly rather than fuzzy-matching
 * the description.
 */
export const DEFAULT_JONAS_DEPARTMENT_MAPPING: Readonly<Record<string, string | null>> = {
  "000000": null,                     // Balance Sheet — nondepartmental
  "000001": "GROUNDS",                // Grounds              → Coulee "Course & Grounds" (code match, name drift)
  "000002": "GOLF_SHOP",              // Golf Shop
  "000003": "CLUBHOUSE",              // Clubhouse
  // TB-HIST-6 (post-conflict adjustment, 2026-10-01) — Coulee's
  // existing Department catalog already carries "Food & Beverage"
  // under the code `F&B` and "Administration" under `ADMIN`. Per
  // directive §1 we must NOT create a duplicate; the mapping is
  // adapted to reuse the existing Coulee codes rather than inventing
  // `FOOD_BEVERAGE` / `ADMINISTRATION` siblings.
  "000004": "F&B",                    // Food & Beverage      → existing Coulee code
  "000005": "ADMIN",                  // Administration       → existing Coulee code
  "000006": "DUES_AND_CHARGES",       // Dues & Charges
  "000007": "LONG_RANGE_PLAN",        // Long Range Plan & Renovation
  "000011": "MENS_SECTION",           // Mens Section
  "000012": "LADIES_SECTION",         // Ladies Section
  "000013": "TOURNAMENTS",            // Tournament Accounts
  "000020": "CORPORATE",              // Corporate Income & Expenses
};

/** Normalise a Spectre department code for case-insensitive compare. */
function norm(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Resolve a single Jonas source department code against the tenant's
 * configured Department catalog.
 *
 * @param jonasCode         6-digit Jonas Department Code from the source row
 * @param jonasDescription  Jonas Department Description from the source row (used only for drift detection)
 * @param tenantDepartments Tenant's Department records ({code, name})
 * @param mapping           Optional override of the default mapping
 */
export function resolveJonasDepartment(
  jonasCode: string,
  jonasDescription: string | null,
  tenantDepartments: ReadonlyArray<{ code: string; name: string }>,
  mapping: Readonly<Record<string, string | null>> = DEFAULT_JONAS_DEPARTMENT_MAPPING,
): JonasDepartmentResolution {
  // The mapping lookup is case-sensitive on the Jonas code (6-digit
  // string); normalise to a trimmed string in case the source pads
  // with whitespace.
  const key = jonasCode.trim();
  if (!(key in mapping)) {
    return { status: "unknown", jonasCode: key, jonasDescription: jonasDescription ?? null };
  }
  const spectreCode = mapping[key];
  if (spectreCode === null) {
    // Nondepartmental marker (000000 Balance Sheet).
    return { status: "ok", spectreCode: null, descriptionDrift: false };
  }
  const tenantMatch = tenantDepartments.find((d) => norm(d.code) === norm(spectreCode));
  if (!tenantMatch) {
    return { status: "missing-spectre-dept", jonasCode: key, spectreCode };
  }
  // Description drift is informational only — Spectre's dept name
  // may differ from Jonas's by convention.
  const drift =
    jonasDescription != null &&
    jonasDescription.trim().toLowerCase() !== tenantMatch.name.trim().toLowerCase();
  return { status: "ok", spectreCode: tenantMatch.code, descriptionDrift: drift };
}
