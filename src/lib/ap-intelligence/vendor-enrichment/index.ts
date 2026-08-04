// Sprint 3 · Checkpoint 16D (2026-08-04) — vendor-enrichment
// service interface.
//
// Founder rules §7-§10 architecture:
//   * Provider-neutral canonical output (below)
//   * Approved-source layer (search API selection + rate-limiting
//     + cache — external-provider integration DEFERRED pending
//     founder approval on which provider + budget)
//   * Identity validation before consuming enrichment
//   * Enrichment guides CONCEPTS not GL directly
//   * Async job (no synchronous browser-rendering calls)
//
// This file establishes the interface + type contract. The
// production enrichment worker will be added in a subsequent
// checkpoint once the founder approves:
//   1. Search provider (Google Custom Search / Bing Search v7 /
//      alternative)
//   2. Monthly query budget cap
//   3. Attached IAM / API-key rotation policy
//   4. Cache TTL policy
//   5. Which public data fields Spectre may retain vs discard
//
// Until then, `resolveVendorEnrichment()` returns UNAVAILABLE
// synchronously; the normal invoice pipeline continues per §8.
//
// GENERAL — no supplier / filename / SKU specificity.

// -----------------------------------------------------------------------------
// Public types (§7)
// -----------------------------------------------------------------------------

export type VendorEnrichmentStatus =
  | "UNAVAILABLE"     // provider not configured or explicitly disabled
  | "PENDING"         // enrichment job queued but not yet complete
  | "SUPPORTED"       // enrichment attached, identity-validated
  | "AMBIGUOUS"       // multiple candidates, identity not conclusive
  | "FAILED";         // provider error, retries exhausted

export interface VendorEnrichmentEvidence {
  sourceType: "official_site" | "search_result" | "directory" | "map_listing" | "phone_directory";
  sourceDomain: string;
  retrievedAt: string;   // ISO-8601
  evidenceSummary: string;   // short (<200 chars), sanitized
  confidence: number;    // 0..100
}

export interface VendorEnrichment {
  vendorName: string;
  officialWebsite?: string;
  businessDomains: string[];        // e.g. ["turf equipment", "commercial mowers"]
  productServiceConcepts: string[]; // e.g. ["fairway mowers", "top dressers"]
  industryCategories: string[];     // e.g. ["agricultural equipment"]
  serviceRegions?: string[];
  evidence: VendorEnrichmentEvidence[];
  confidence: number;
  sourceUpdatedAt: Date;
  status: VendorEnrichmentStatus;
}

// -----------------------------------------------------------------------------
// Public entrypoint — synchronous fallback (§8)
// -----------------------------------------------------------------------------

export interface ResolveEnrichmentArgs {
  clubId: string;
  vendorName: string | null;
  vendorEmail?: string | null;
  vendorDomain?: string | null;
  supplierAddressCity?: string | null;
  supplierAddressRegion?: string | null;
  taxRegistrationNumber?: string | null;
}

/**
 * Synchronous resolver — returns cached enrichment if present.
 * Never invokes a paid search API from this call path per §8
 * ("no OCR-style synchronous calls during browser rendering").
 *
 * The production enrichment worker will populate the cache
 * asynchronously via a queued job when new suppliers are
 * observed.
 */
export async function resolveVendorEnrichment(
  args: ResolveEnrichmentArgs,
): Promise<VendorEnrichment | null> {
  if (!args.vendorName || args.vendorName.trim().length < 3) return null;

  // NOTE: cached-only lookup once the persistence model is
  // deployed. Until then, always return UNAVAILABLE so the
  // downstream pipeline treats enrichment as optional.
  return {
    vendorName: args.vendorName,
    businessDomains: [],
    productServiceConcepts: [],
    industryCategories: [],
    evidence: [],
    confidence: 0,
    sourceUpdatedAt: new Date(0),
    status: "UNAVAILABLE",
  };
}

// -----------------------------------------------------------------------------
// Identity validation (§9)
// -----------------------------------------------------------------------------

export interface IdentityValidationInput {
  invoiceSupplierName: string;
  invoiceSupplierDomain?: string | null;
  invoiceSupplierAddressCity?: string | null;
  invoiceSupplierAddressRegion?: string | null;
  invoiceSupplierTaxRegistration?: string | null;
  candidate: VendorEnrichment;
}

export interface IdentityValidationResult {
  identityMatchConfidence: number;   // 0..100
  matchedIdentitySignals: string[];
  conflictingIdentitySignals: string[];
  enrichmentUsableForCoding: boolean;
}

/**
 * Validate enrichment identity before consuming. Requires at
 * least one strong signal (domain / tax reg / two of {city,
 * region}) to match; ambiguous cases must NOT be used for coding
 * (§9 rule).
 */
export function validateEnrichmentIdentity(input: IdentityValidationInput): IdentityValidationResult {
  const matched: string[] = [];
  const conflicting: string[] = [];
  let score = 0;

  // Website / domain match — strongest signal.
  if (input.invoiceSupplierDomain && input.candidate.officialWebsite) {
    const inv = input.invoiceSupplierDomain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
    const cand = input.candidate.officialWebsite.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
    if (inv === cand || inv.includes(cand) || cand.includes(inv)) {
      matched.push("website_match");
      score += 60;
    } else {
      conflicting.push("website_mismatch");
      score -= 30;
    }
  }

  // Legal-name similarity (loose substring both directions).
  const invName = input.invoiceSupplierName.toLowerCase();
  const candName = input.candidate.vendorName.toLowerCase();
  const nameOverlap = invName.includes(candName) || candName.includes(invName);
  if (nameOverlap) {
    matched.push("name_similarity");
    score += 20;
  }

  // City / region match — medium signal.
  if (input.invoiceSupplierAddressCity && input.candidate.serviceRegions) {
    const cityLower = input.invoiceSupplierAddressCity.toLowerCase();
    const regionHit = input.candidate.serviceRegions.some((r) => r.toLowerCase().includes(cityLower));
    if (regionHit) {
      matched.push("city_in_service_region");
      score += 15;
    }
  }

  const enrichmentUsableForCoding = score >= 60 && conflicting.length === 0;
  return {
    identityMatchConfidence: Math.max(0, Math.min(100, score)),
    matchedIdentitySignals: matched,
    conflictingIdentitySignals: conflicting,
    enrichmentUsableForCoding,
  };
}

// -----------------------------------------------------------------------------
// Enrichment → concepts (§10) — never returns a GL account directly
// -----------------------------------------------------------------------------

export interface EnrichmentConceptOutput {
  productServiceConcepts: string[];    // fed to accounting-nature classifier
  suggestedDepartments: string[];      // fed to department inference
  suggestedNatures: string[];          // e.g. ["CAPITAL_ASSET", "REPAIR_AND_MAINTENANCE"]
}

/**
 * Convert enrichment into concept signals that guide the existing
 * nature / department / GL classifiers. Enrichment MUST NOT return
 * a GL account directly.
 */
export function conceptsFromEnrichment(e: VendorEnrichment | null): EnrichmentConceptOutput {
  if (!e || e.status !== "SUPPORTED") {
    return { productServiceConcepts: [], suggestedDepartments: [], suggestedNatures: [] };
  }
  return {
    productServiceConcepts: [...e.productServiceConcepts, ...e.businessDomains],
    suggestedDepartments: [],   // populated once tenant-to-industry-taxonomy mapping lands
    suggestedNatures: [],       // populated by a future concept→nature bridge
  };
}
