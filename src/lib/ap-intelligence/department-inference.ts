// Sprint 3 · Checkpoint 16B (2026-08-04) — department inference
// module.
//
// Founder rule §10: infer the operational department separately
// from the account. Signals combined:
//   * line-item descriptions
//   * equipment/service type
//   * ship-to / service-location text
//   * project references
//   * tenant's existing Club departments (loaded, not hardcoded)
//   * supplier history as WEAK evidence only
//
// GENERAL logic. No supplier / SKU / filename specificity.

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface DepartmentCandidate {
  key: string;                 // department key/slug (from tenant taxonomy)
  displayName: string;
  score: number;               // 0..100
  evidence: string[];
  isDefensible: boolean;
}

export interface DepartmentInferenceInput {
  supplierName: string | null;
  lineItemDescriptions: string[];
  fullDocumentText: string | null;
  // Tenant department taxonomy — loaded, not hardcoded.
  clubDepartments: Array<{ key: string; displayName: string; lexicon?: RegExp[] }>;
}

export interface DepartmentInferenceResult {
  leader: DepartmentCandidate | null;
  ranked: DepartmentCandidate[];
  isDefensible: boolean;
}

// -----------------------------------------------------------------------------
// Default department lexicons — used when a tenant department has no
// lexicon override. Every lexicon matches phrasing common to that
// operational area; no supplier or SKU specificity.
// -----------------------------------------------------------------------------

const DEFAULT_LEXICONS: Record<string, RegExp[]> = {
  kitchen: [/\bkitchen\b/i, /\bculinary\b/i, /\bpastry\b/i, /\bchef\b/i, /\bfood\s+prep\b/i, /\bwalk[-\s]?in\b/i],
  food_beverage: [/\bfood\b/i, /\bbeverage\b/i, /\bcatering\b/i, /\brestaurant\b/i, /\bdining\b/i, /\bbanquet\b/i],
  bar: [/\bbar\b/i, /\blounge\b/i, /\bdraft\b/i, /\bwine\b/i, /\bspirits?\b/i, /\bbartender\b/i],
  grounds: [/\bgrounds\b/i, /\bturf\b/i, /\bfairway\b/i, /\bgreen(?:s)?\b/i, /\brough\b/i, /\btee\s*box(?:es)?\b/i, /\birrigation\b/i],
  golf_shop: [/\bpro\s*shop\b/i, /\bgolf\s*shop\b/i, /\bmerchandise\b/i, /\bapparel\b/i, /\btees?\b/i, /\bballs?\b/i, /\bgloves?\b/i],
  golf_operations: [/\btee\s*sheet\b/i, /\bgolf\s+cart\b/i, /\brange\s+ball\b/i, /\bstarter\b/i, /\bmarshal\b/i, /\bhandicap\b/i],
  events: [/\bevent(?:s)?\b/i, /\bwedding\b/i, /\bfunction\b/i, /\bhospitality\b/i, /\bconference\b/i, /\breception\b/i],
  housekeeping: [/\bhousekeeping\b/i, /\bcleaning\b/i, /\bjanitorial\b/i, /\blinen\b/i, /\blaundry\b/i],
  maintenance: [/\bmaintenance\b/i, /\brepair\b/i, /\bhvac\b/i, /\bplumb(?:ing|er)\b/i, /\belectrician\b/i, /\bhandyman\b/i],
  administration: [/\boffice\b/i, /\badministration\b/i, /\baccounting\b/i, /\bpayroll\b/i, /\bhuman\s+resources\b/i, /\bmanagement\b/i],
  it: [/\bit\b/i, /\btechnology\b/i, /\bnetwork\b/i, /\binternet\b/i, /\bphone\b/i, /\bcomputer\b/i, /\btelecom\b/i, /\bsoftware\b/i],
  member_services: [/\bmember\s+service(?:s)?\b/i, /\bmembership\b/i, /\breception(?:ist)?\b/i],
  utilities: [/\butilit(?:y|ies)\b/i, /\bhydro\b/i, /\bwater\s+service\b/i, /\bgas\s+service\b/i, /\belectricity\b/i, /\bnatural\s+gas\b/i],
  clubhouse: [/\bclubhouse\b/i, /\bmain\s+building\b/i, /\bfront\s+of\s+house\b/i],
};

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

const STRONG_MATCH = 25;
const WEAK_MATCH = 8;
const DEFENSIBLE_THRESHOLD = 25;

export function inferDepartment(input: DepartmentInferenceInput): DepartmentInferenceResult {
  // §10 rule: supplier alone is WEAK evidence. Split the surface
  // into document-body vs supplier-name so supplier-only matches
  // never cross the defensibility bar on their own.
  const documentSurface = [
    ...(input.lineItemDescriptions ?? []),
    input.fullDocumentText ?? "",
  ].filter(Boolean).join("\n");
  const supplierSurface = input.supplierName ?? "";

  const ranked: DepartmentCandidate[] = input.clubDepartments.map((d) => {
    const lex = d.lexicon ?? DEFAULT_LEXICONS[d.key] ?? DEFAULT_LEXICONS[d.key.toLowerCase()] ?? [];
    let score = 0;
    const evidence: string[] = [];
    // Pass 1 — STRONG match against document body only.
    for (const pattern of lex) {
      if (pattern.test(documentSurface)) {
        score += STRONG_MATCH;
        evidence.push(`match:${pattern.source}`);
      }
    }
    // Pass 2 — WEAK match against supplier name, only when no body
    // match already fired. Supplier alone must not be defensible.
    if (score === 0 && supplierSurface) {
      for (const pattern of lex) {
        if (pattern.test(supplierSurface)) {
          score += WEAK_MATCH;
          evidence.push(`supplier_only:${pattern.source}`);
          break;
        }
      }
    }
    return {
      key: d.key,
      displayName: d.displayName,
      score: Math.min(100, score),
      evidence,
      isDefensible: score >= DEFENSIBLE_THRESHOLD,
    };
  });

  ranked.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const leader = ranked.length > 0 && ranked[0].score >= DEFENSIBLE_THRESHOLD ? ranked[0] : null;

  return {
    leader,
    ranked,
    isDefensible: leader != null,
  };
}

// -----------------------------------------------------------------------------
// Tenant default departments — a starter taxonomy for clubs that
// haven't configured their own. Values match the DEFAULT_LEXICONS
// keys so lookup works without an override.
// -----------------------------------------------------------------------------

export const DEFAULT_CLUB_DEPARTMENTS: Array<{ key: string; displayName: string }> = [
  { key: "kitchen", displayName: "Kitchen" },
  { key: "food_beverage", displayName: "Food & Beverage" },
  { key: "bar", displayName: "Bar / Lounge" },
  { key: "grounds", displayName: "Grounds / Course" },
  { key: "golf_shop", displayName: "Golf Shop" },
  { key: "golf_operations", displayName: "Golf Operations" },
  { key: "events", displayName: "Events / Banquet" },
  { key: "housekeeping", displayName: "Housekeeping" },
  { key: "maintenance", displayName: "Maintenance" },
  { key: "administration", displayName: "Administration" },
  { key: "it", displayName: "IT / Technology" },
  { key: "member_services", displayName: "Member Services" },
  { key: "utilities", displayName: "Utilities" },
];

/**
 * Sprint 3 · Checkpoint 16D (2026-08-04) — return the account-name
 * regexes that identify accounts belonging to a given department.
 * Used by the nature-scoped ranker to boost department-compatible
 * account names.
 *
 * These are DIFFERENT from the department-lexicon match patterns
 * (which infer department FROM invoice text). These match
 * department-qualifying tokens IN ACCOUNT NAMES so accounts like
 * "R & M - Ground Equip" or "Equipment & Fixtures - Grounds"
 * receive a boost when the invoice department is "grounds".
 */
export function departmentAccountNamePatterns(deptKey: string): RegExp[] {
  const map: Record<string, RegExp[]> = {
    kitchen: [/\bkitchen\b/i, /\bculinary\b/i],
    food_beverage: [/\bf\s*&\s*b\b/i, /\bfood\b/i, /\bbeverage\b/i, /\brestaurant\b/i, /\bdining\b/i],
    bar: [/\bbar\b/i, /\blounge\b/i],
    grounds: [
      /\bgrounds?\b/i,                          // "Ground" / "Grounds"
      /\bcourse\b/i,                            // "Course Equipment"
      /\bturf\b/i,
      /\bfairway\b/i,
      /\bgreen(?:s)?\b/i,
      /\birrigat(?:ion|e)?\b/i,
    ],
    golf_shop: [/\bpro\s*shop\b/i, /\bgolf\s*shop\b/i, /\bmerchandise\b/i, /\bapparel\b/i, /\bbackshop\b/i],
    golf_operations: [/\btee\s*sheet\b/i, /\brange\b/i, /\bcart\s+fleet\b/i, /\bstarter\b/i],
    events: [/\bevent(?:s)?\b/i, /\bwedding\b/i, /\bbanquet\b/i, /\breception\b/i],
    housekeeping: [/\bhousekeeping\b/i, /\bjanitorial\b/i, /\blinen\b/i],
    maintenance: [/\bmaintenance\b/i, /\brepair\b/i, /\bhvac\b/i, /\bfacilit(?:y|ies)\b/i],
    administration: [/\badmin\b/i, /\boffice\b/i, /\bmanagement\b/i],
    it: [/\bit\b/i, /\btechnolog(?:y|ies)\b/i, /\bcomputer\b/i, /\bnetwork\b/i, /\bsoftware\b/i, /\btelephone\b/i, /\binternet\b/i],
    member_services: [/\bmember\s+service(?:s)?\b/i, /\bmembership\b/i],
    utilities: [/\butilit(?:y|ies)\b/i, /\bhydro\b/i, /\bgas\b/i, /\bwater\b/i, /\belectricity\b/i],
    clubhouse: [/\bclubhouse\b/i],
  };
  return map[deptKey] ?? map[deptKey.toLowerCase()] ?? [];
}
