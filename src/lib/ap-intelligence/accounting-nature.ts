// Sprint 3 · Checkpoint 16A (2026-08-04) — accounting-nature
// classifier. First-stage classification BEFORE account selection.
//
// Founder rule §2: do not rank all expense + asset accounts from
// one undifferentiated text bag. An asset-like purchase should not
// compete equally against office supplies, subscriptions, utilities
// and delivery expenses merely because all are debit accounts.
//
// This module returns a ranked list of AccountingNature candidates
// with per-nature confidence and cited supporting evidence. The GL
// ranker then filters/weights accounts within the top-ranked
// nature branch(es) — rather than scoring all accounts equally.
//
// GENERAL logic — no supplier / SKU / invoice specificity. All
// signals are lexicon-driven and shape-based.

import type { ExtractedInvoice, CapitalVsOperatingState } from "./types";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type AccountingNature =
  | "CAPITAL_ASSET"
  | "OPERATING_EXPENSE"
  | "INVENTORY"
  | "COST_OF_SALES"
  | "PREPAID_EXPENSE"
  | "REPAIR_AND_MAINTENANCE"
  | "PROFESSIONAL_SERVICE"
  | "UTILITY_OR_RECURRING_SERVICE"
  | "TAX_OR_REGULATORY"
  | "INTEREST_OR_PENALTY"
  | "UNKNOWN";

export interface AccountingNatureCandidate {
  nature: AccountingNature;
  score: number;                 // 0..100
  supportingEvidence: string[];  // human-readable phrases that fired
  contradictingEvidence: string[];
}

export interface AccountingNatureInput {
  extraction: Pick<
    ExtractedInvoice,
    "vendor" | "lineItems" | "total" | "subtotal" | "taxTotal" | "description" | "invoiceNumber" | "paymentTerms" | "purchaseOrder"
  > | null;
  supplierName: string | null;
  lineItemDescriptions: string[];  // may include recovered items from positioned layout
  fullDocumentText: string | null;
  capitalStateFromClassifier: CapitalVsOperatingState | null;
  // Sprint 3 · Phase 4 Slice 5.2 (2026-08-08, amendment #3) —
  // capital threshold + totalCents preserved on the input for
  // backward compatibility but NEVER used to classify nature.
  // Amount is a review-policy signal, not accounting-nature
  // evidence. Kept in the type so removing them is a no-op for
  // callers.
  capitalThresholdCents: number | null;
  totalCents: number | null;
  /** Sprint 3 · Phase 4 Slice 5.2 (2026-08-08, amendment #4) — the
   *  DOCUMENT-ROLE-AWARE transactional text (from
   *  transactional-text.ts). When provided, this replaces
   *  `fullDocumentText` as the scan source for nature evidence so
   *  supplier/recipient address, footer, policy and boilerplate
   *  regions cannot contribute (fixes street-name false positives
   *  in supplier addresses and policy-footer regex false positives
   *  such as "finance charge" appearing in terms-and-conditions
   *  paragraphs). When absent, falls back to fullDocumentText for
   *  compatibility. */
  transactionalText?: string | null;
}

export interface AccountingNatureAssessment {
  ranked: AccountingNatureCandidate[];
  leader: AccountingNature;
  leaderConfidence: number;
  isDefensible: boolean;
  contradictedPurposes: string[];
}

// -----------------------------------------------------------------------------
// Lexicons — closed word-lists for each nature
// -----------------------------------------------------------------------------

interface NatureLexicon {
  nature: AccountingNature;
  strongTerms: RegExp[];          // firing any → strong evidence (+3)
  weakTerms: RegExp[];            // firing any → weak evidence (+1)
  antiTerms?: RegExp[];           // firing any → contradicts nature (-2)
  amountSensitivity?: "high" | "low"; // does dollar amount matter?
  /** Sprint 3 · Phase 4 Slice 5.2 completion (2026-08-08, amendment
   *  #6) — when true, `strongTerms` must match a LINE-ITEM
   *  description (not the aggregate `surface` which includes
   *  document-body text). Prevents capital-nature signals from
   *  firing on street-name matches ("17 Capital Circle" in a
   *  supplier address) or column headings ("MODEL #" as a table
   *  header) that are provenance, not transactional evidence.
   *  Currently applied to CAPITAL_ASSET only. */
  strongTermsRequireLineItem?: boolean;
}

// GENERAL — used for any tenant with a chart of accounts.
const NATURE_LEXICONS: NatureLexicon[] = [
  {
    nature: "CAPITAL_ASSET",
    // Amendment #6: capital-signal terms must anchor on the PURCHASED
    // ITEM, not on ambient document surface. A supplier address
    // containing "17 Capital Circle" or a column heading "MODEL #"
    // does not establish that this transaction is a capital purchase.
    // The `strongTermsRequireLineItem: true` flag below enforces that
    // these regexes only fire against `lineItemDescriptions`.
    strongTerms: [
      /\b(?:equipment|machinery|vehicle|appliance)\b/i,
      /\b(?:install(?:ation)?|installed)\b/i,
      /\bmodel\s*(?:#|no\.?)/i,
      /\bserial\s*(?:#|no\.?)/i,
      /\bmanufacturer\b/i,
      /\bwarranty\b/i,
      /\bcapital\b/i,
      /\bnew\s+(?:mower|tractor|vehicle|cooler|oven|dishwasher|hvac|server|pump)\b/i,
      /\basset\s+(?:acquisition|purchase|register)\b/i,
      /\buseful\s+life\b/i,
      /\bpurchase\s+order\s*(?:#|no\.?)?/i,
    ],
    strongTermsRequireLineItem: true,
    weakTerms: [
      /\b(?:acquisition|acquire|purchase)\b/i,
      /\breplace(?:ment)?\b/i,
      /\bupgrade\b/i,
      /\bfreight\b/i,
      /\bshipping\b/i,   // may support asset acquisition
    ],
    antiTerms: [
      /\bmonthly\s+(?:fee|charge|subscription)\b/i,
      /\brecurring\b/i,
      /\brepair\b/i,
      /\brental\b/i,
      // 16C — replacement-component wording contradicts complete-
      // unit acquisition. A "SEAL", "SPACER", "GASKET", "FILTER",
      // "ASSEMBLY (ASM)" line is a subcomponent used to service an
      // existing asset — NOT the acquisition of a new capital asset.
      /\breplacement\s+parts?\b/i,
      /\brepair\s+kit\b/i,
      /\bservice\s+kit\b/i,
    ],
    amountSensitivity: "high",
  },
  {
    nature: "REPAIR_AND_MAINTENANCE",
    strongTerms: [
      /\brepair(?:s|ed|ing)?\b/i,
      /\bmaintenance\b/i,
      /\bservice\s+call\b/i,
      /\btroubleshoot(?:ing)?\b/i,
      /\bpreventive\s+maintenance\b/i,
      /\btune[-\s]?up\b/i,
      /\brebuild\b/i,
      /\bcalibrat(?:e|ion|ing)\b/i,
      /\breplace(?:ment)?\s+part(?:s)?\b/i,
      /\brepair\s+kit\b/i,
      /\bservice\s+kit\b/i,
    ],
    weakTerms: [
      /\bfilter\b/i,
      /\bseal\b/i,
      /\bbearing\b/i,
      /\bgasket\b/i,
      /\bbelt\b/i,
      /\bhose\b/i,
      // 16C — expanded component vocabulary. Individual tokens
      // remain WEAK; the concept-family cluster bonus below
      // aggregates coherent multi-signal evidence.
      /\bspacer\b/i,
      /\bassembly\b/i,
      /\basm\b/i,
      /\bwasher\b/i,
      /\bfitting\b/i,
      /\bvalve\b/i,
      /\bpump\b/i,
      /\bmotor\b/i,
      /\bblade\b/i,
      /\bspring\b/i,
      /\bbolt\b/i,
      /\bnut\b/i,
      /\bnozzle\b/i,
      /\bcoupler\b/i,
      /\bcoupling\b/i,
      /\bo[-\s]?ring\b/i,
      /\bbushing\b/i,
      /\bpiston\b/i,
      /\bcylinder\b/i,
      /\bshaft\b/i,
      /\bpulley\b/i,
      /\bblade\s*(?:assembly|kit)\b/i,
    ],
    antiTerms: [
      /\bmodel\s*(?:#|no\.?)\s*[A-Z0-9\-]+.*(?:new|complete\s+unit)/i,
    ],
    amountSensitivity: "low",
  },
  {
    nature: "INVENTORY",
    strongTerms: [
      /\bfor\s+resale\b/i,
      /\binventory\b/i,
      /\bstock\s+(?:order|item)\b/i,
      /\bwholesale\b/i,
      /\bcase(?:s)?\s+of\b/i,
      /\bpallet(?:s)?\b/i,
    ],
    weakTerms: [
      /\bbeverage(?:s)?\b/i,
      /\bpackaged\s+(?:beer|wine|spirits)\b/i,
      /\bdraft\b/i,
      /\bmerchandise\b/i,
      /\bapparel\b/i,
    ],
    amountSensitivity: "low",
  },
  {
    nature: "COST_OF_SALES",
    strongTerms: [
      /\bcost\s+of\s+(?:goods|sales)\b/i,
      /\bfood\s+cost\b/i,
      /\bbeverage\s+cost\b/i,
      /\bkitchen\s+supplies\b/i,
      /\bproduce\b/i,
      /\bseafood\b/i,
      /\bmeat\b/i,
      /\bdairy\b/i,
    ],
    weakTerms: [
      /\bculinary\b/i,
      /\brestaurant\b/i,
      /\bcatering\b/i,
    ],
    amountSensitivity: "low",
  },
  {
    nature: "UTILITY_OR_RECURRING_SERVICE",
    strongTerms: [
      /\bmonthly\s+(?:service|fee|charge|subscription)\b/i,
      /\butilit(?:y|ies)\b/i,
      /\bhydro\b/i,
      /\belectric(?:ity)?\b/i,
      /\bwater\s+(?:bill|service)\b/i,
      /\bgas\s+(?:bill|service)\b/i,
      /\bnatural\s+gas\b/i,
      /\binternet\s+(?:service|access|plan)\b/i,
      /\bphone\s+(?:service|bill|plan)\b/i,
      /\bcable\s+service\b/i,
      /\bwaste\s+(?:collection|removal)\b/i,
      /\bsubscription\b/i,
      // 16B — common billing-language patterns.
      /\bongoing\s+charges?\b/i,          // "Ongoing charges" recurring section
      /\bbilling\s+cycle\b/i,              // "Billing cycle YYYY-MM-DD - YYYY-MM-DD"
      /\bservice\s+period\b/i,
      /\brenewal\s+date\b/i,
      /\baccount\s+summary\b/i,            // recurring-service invoice format
      /\bplan\s+(?:fee|charge)\b/i,
    ],
    weakTerms: [
      /\brecurring\b/i,
      /\bmonthly\b/i,
      /\bbilling\s+period\b/i,
      // 16B — telecom-specific signals surfaced by document text.
      /\b\d+(?:\.\d+)?\s*mbit\s*\/\s*s\b/i,     // "25 mbit/s"
      /\b\d+(?:\.\d+)?\s*mbps\b/i,
      /\b\d+(?:\.\d+)?\s*gbit\s*\/\s*s\b/i,
      /\b\d+(?:\.\d+)?\s*gbps\b/i,
      /\bwireless\b/i,
      /\bbroadband\b/i,
      /\bfiber(?:\s*optic)?\b/i,
      /\bwifi\b/i,
      /\bstatement\s+number\b/i,            // recurring-service statement style
      /\bautomated\s+payment\b/i,
      /\bpre[-\s]?authorized\s+debit\b/i,
    ],
    amountSensitivity: "low",
  },
  {
    nature: "PROFESSIONAL_SERVICE",
    strongTerms: [
      /\baudit\b/i,
      /\baccounting\s+service(?:s)?\b/i,
      /\blegal\s+service(?:s)?\b/i,
      /\bconsult(?:ing|ant|ancy)\b/i,
      /\bengineer(?:ing)?\s+service(?:s)?\b/i,
      /\barchitect(?:ural)?\s+service(?:s)?\b/i,
      /\btax\s+preparation\b/i,
      /\bappraisal\b/i,
      /\bprofessional\s+membership\b/i,
      /\bcpa\b/i,
    ],
    weakTerms: [
      /\bfees?\b/i,
      /\breview\b/i,
      /\bopinion\b/i,
    ],
    amountSensitivity: "low",
  },
  {
    nature: "TAX_OR_REGULATORY",
    strongTerms: [
      /\bproperty\s+tax\b/i,
      /\bmunicipal\s+tax\b/i,
      /\blicense\s+fee\b/i,
      /\bpermit\s+fee\b/i,
      /\bregulatory\s+fee\b/i,
      /\bwithholding\s+tax\b/i,
      /\bfranchise\s+tax\b/i,
    ],
    weakTerms: [],
    amountSensitivity: "low",
  },
  {
    nature: "INTEREST_OR_PENALTY",
    strongTerms: [
      /\binterest\s+charge(?:s)?\b/i,
      /\bfinance\s+charge(?:s)?\b/i,
      /\blate\s+(?:fee|charge|payment)\b/i,
      /\bpenalt(?:y|ies)\b/i,
      /\bnsf\b/i,
      /\boverdue\s+charge\b/i,
    ],
    weakTerms: [],
    amountSensitivity: "low",
  },
  {
    nature: "PREPAID_EXPENSE",
    strongTerms: [
      /\bannual\s+(?:premium|fee|renewal)\b/i,
      /\bprepaid\s+expense\b/i,
      /\binsurance\s+premium\b/i,
      /\bannual\s+subscription\b/i,
      /\bpolicy\s+period\b/i,
    ],
    weakTerms: [
      /\bcoverage\s+period\b/i,
    ],
    amountSensitivity: "low",
  },
  {
    nature: "OPERATING_EXPENSE",
    // The base state — fires when none of the more-specific natures do.
    strongTerms: [
      /\boffice\s+supplies\b/i,
      /\bcleaning\s+supplies\b/i,
      /\bpaper\b/i,
      /\bink\s+cartridge(?:s)?\b/i,
      /\bpostage\b/i,
      /\bsmall\s+tools?\b/i,
    ],
    weakTerms: [
      /\bsupplies\b/i,
      /\bconsumables?\b/i,
    ],
    amountSensitivity: "low",
  },
];

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

const STRONG_WEIGHT = 3;
const WEAK_WEIGHT = 1;
const ANTI_WEIGHT = -2;
// Max score is capped so amount-sensitivity boosts are bounded.
const RAW_SCORE_CAP = 15;

// 16C — concept-family cluster bonus. When ≥2 weak terms of the
// same nature-branch fire on separate line items, add a cluster
// bonus. This aggregates coherent multi-signal evidence (e.g. a
// repair invoice with SEAL + BEARING + SPACER all across different
// lines) into a defensible confidence, rather than treating each
// token as an isolated weak match.
//
// The cluster bonus is applied ONCE per nature per document and
// scales with distinct-line coverage, not raw term count.
const CLUSTER_BONUS_2_LINES = 4;   // ≥2 distinct-line component matches
const CLUSTER_BONUS_3_LINES = 6;   // ≥3 distinct-line component matches
const CLUSTER_BONUS_5_LINES = 8;   // ≥5 distinct-line component matches

export function classifyAccountingNature(input: AccountingNatureInput): AccountingNatureAssessment {
  // Sprint 3 · Phase 4 Slice 5.2 (2026-08-08, amendment #4) — prefer
  // the DOCUMENT-ROLE-AWARE transactional text when provided AND
  // non-empty. When transactionalText is present but empty (e.g.
  // image-only PDF with no positional regions), we do NOT starve the
  // classifier of evidence by refusing the fullDocumentText fallback;
  // amendment #4 is about region-role provenance, not about muting
  // the classifier when regions couldn't be detected.
  const hasTransactionalText = input.transactionalText != null && input.transactionalText.trim().length > 0;
  const documentSurfaceText = hasTransactionalText
    ? input.transactionalText!
    : input.fullDocumentText ?? "";
  const surfaceLines = [
    ...input.lineItemDescriptions,
    documentSurfaceText,
    input.extraction?.description ?? "",
  ].filter(Boolean);
  const surface = surfaceLines.join("\n");

  const ranked: AccountingNatureCandidate[] = [];
  for (const lex of NATURE_LEXICONS) {
    const supporting: string[] = [];
    const contradicting: string[] = [];
    let raw = 0;

    // Amendment #6: capital-signal strong terms require a line-item
    // hit (not aggregate surface). This prevents street-name and
    // column-header leakage from producing false CAPITAL_ASSET
    // scores.
    const strongScanSurface = lex.strongTermsRequireLineItem
      ? input.lineItemDescriptions.join("\n")
      : surface;
    for (const p of lex.strongTerms) {
      if (p.test(strongScanSurface)) {
        raw += STRONG_WEIGHT;
        supporting.push(`strong:${p.source}`);
      }
    }
    // Per-line weak-term evidence — count DISTINCT lines that fire
    // at least one weak term. Same term firing on multiple lines is
    // one hit per line; different terms on the same line count as
    // one hit for that line.
    const linesWithWeakHit = new Set<number>();
    for (let i = 0; i < input.lineItemDescriptions.length; i++) {
      const line = input.lineItemDescriptions[i];
      if (lex.weakTerms.some((p) => p.test(line))) {
        linesWithWeakHit.add(i);
      }
    }
    for (const p of lex.weakTerms) {
      if (p.test(surface)) {
        raw += WEAK_WEIGHT;
        supporting.push(`weak:${p.source}`);
      }
    }
    // 16C — cluster bonus for coherent multi-line component evidence.
    // Distinguishes "one stray token" from "an invoice full of
    // durable-component replacement lines". Rejects capital-asset
    // classification on this signal alone by only firing for
    // REPAIR_AND_MAINTENANCE + OPERATING_EXPENSE natures whose weak
    // vocabularies are dominated by physical-component tokens.
    if ((lex.nature === "REPAIR_AND_MAINTENANCE" || lex.nature === "OPERATING_EXPENSE") && linesWithWeakHit.size >= 2) {
      if (linesWithWeakHit.size >= 5) {
        raw += CLUSTER_BONUS_5_LINES;
        supporting.push(`cluster_bonus_5+_lines(${linesWithWeakHit.size})`);
      } else if (linesWithWeakHit.size >= 3) {
        raw += CLUSTER_BONUS_3_LINES;
        supporting.push(`cluster_bonus_3+_lines(${linesWithWeakHit.size})`);
      } else {
        raw += CLUSTER_BONUS_2_LINES;
        supporting.push(`cluster_bonus_2+_lines(${linesWithWeakHit.size})`);
      }
    }
    for (const p of lex.antiTerms ?? []) {
      if (p.test(surface)) {
        raw += ANTI_WEIGHT;
        contradicting.push(`anti:${p.source}`);
      }
    }

    // Sprint 3 · Phase 4 Slice 5.2 (2026-08-08, amendment #3) —
    // amount is REMOVED entirely from accounting-nature evidence.
    // A high invoice total may affect REVIEW POLICY elsewhere but
    // it cannot be evidence that a purchase is capital. The old
    // `amount_above_capital_threshold(...)` supporting signal was
    // the smoking-gun defect on large-value equipment invoices
    // (elected CAPITAL_ASSET on amount alone). Keeping it silently
    // would let the classifier continue laundering money-magnitude
    // into accounting nature.
    void lex.amountSensitivity;

    // External classifier alignment.
    if (input.capitalStateFromClassifier === "CAPITAL" && lex.nature === "CAPITAL_ASSET" && supporting.length > 0) {
      raw += 2;
      supporting.push("aligned_with_capital_vs_operating_classifier");
    }
    if (input.capitalStateFromClassifier === "OPERATING" && lex.nature === "OPERATING_EXPENSE") {
      raw += 1;
      supporting.push("aligned_with_capital_vs_operating_classifier");
    }

    // Cap + normalise to 0..100
    const capped = Math.max(0, Math.min(RAW_SCORE_CAP, raw));
    const score = Math.round((capped / RAW_SCORE_CAP) * 100);

    ranked.push({ nature: lex.nature, score, supportingEvidence: supporting, contradictingEvidence: contradicting });
  }

  ranked.sort((a, b) => b.score - a.score);
  const leader = ranked[0];
  const leaderConfidence = leader?.score ?? 0;

  // Defensibility — leader must have at least one supporting piece
  // of evidence AND score ≥ 20. Otherwise we return UNKNOWN.
  const isDefensible = leaderConfidence >= 20 && leader && leader.supportingEvidence.length > 0;
  const finalLeader: AccountingNature = isDefensible ? leader.nature : "UNKNOWN";

  // Contradicted-purposes list surfaces where the ranker rejected
  // an otherwise-plausible nature.
  const contradicted = ranked
    .filter((r) => r.score > 0 && r.contradictingEvidence.length > 0)
    .map((r) => `${r.nature}:${r.contradictingEvidence.join(",")}`);

  return {
    ranked,
    leader: finalLeader,
    leaderConfidence,
    isDefensible,
    contradictedPurposes: contradicted,
  };
}

// -----------------------------------------------------------------------------
// Bridge — map AccountingNature to the account-type / category shape
// the GL ranker uses. Keeps the ranker unchanged; adds a filtering
// hint the ranker can weight positively.
// -----------------------------------------------------------------------------

/**
 * Return the account types that ARE consistent with a given nature.
 * Used by the ranker to boost accounts whose type matches the
 * leader nature and penalise those that don't.
 */
export function accountTypesForNature(nature: AccountingNature): string[] {
  switch (nature) {
    case "CAPITAL_ASSET":            return ["ASSET"];
    case "INVENTORY":                return ["ASSET"];
    case "PREPAID_EXPENSE":          return ["ASSET"];
    case "OPERATING_EXPENSE":        return ["EXPENSE"];
    case "REPAIR_AND_MAINTENANCE":   return ["EXPENSE"];
    case "PROFESSIONAL_SERVICE":     return ["EXPENSE"];
    case "UTILITY_OR_RECURRING_SERVICE": return ["EXPENSE"];
    case "TAX_OR_REGULATORY":        return ["EXPENSE"];
    case "INTEREST_OR_PENALTY":      return ["EXPENSE"];
    case "COST_OF_SALES":            return ["EXPENSE"];
    case "UNKNOWN":                  return ["EXPENSE", "ASSET"];
  }
}

/**
 * Category keys that should be preferred inside a given nature.
 * These MUST match the tenant COA category slugs — the ranker
 * uses these as soft boosts, never hard filters.
 */
export function categoryHintsForNature(nature: AccountingNature): string[] {
  switch (nature) {
    case "CAPITAL_ASSET":            return ["fixed_assets", "equipment", "vehicles", "buildings", "leasehold_improvements"];
    case "REPAIR_AND_MAINTENANCE":   return ["repair_maintenance", "maintenance", "grounds_maintenance", "building_maintenance"];
    case "INVENTORY":                return ["inventory", "merchandise", "stock"];
    case "COST_OF_SALES":            return ["cost_of_sales", "cogs", "food_cost", "beverage_cost"];
    case "UTILITY_OR_RECURRING_SERVICE": return ["utilities", "telephone_internet", "telecommunications", "subscriptions", "recurring_services"];
    case "PROFESSIONAL_SERVICE":     return ["professional_services", "accounting_services", "legal_services", "consulting", "memberships"];
    case "PREPAID_EXPENSE":          return ["prepaid_expenses", "prepaids"];
    case "TAX_OR_REGULATORY":        return ["taxes_licenses", "licenses_permits"];
    case "INTEREST_OR_PENALTY":      return ["interest_expense", "finance_charges", "penalties"];
    case "OPERATING_EXPENSE":        return ["office_expenses", "supplies", "operating_expenses"];
    case "UNKNOWN":                  return [];
  }
}
