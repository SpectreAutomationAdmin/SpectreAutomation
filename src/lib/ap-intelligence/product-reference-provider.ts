// Sprint 3 · Phase 4 Slice 5.4 (2026-08-08) — ProductReferenceProvider
// interface + null/stub provider + ProductReference cache model.
//
// The provider interface (§34) is the boundary between the accounting
// pipeline and any future external product-identity resolver
// (curated catalog, controlled web search, OEM API, manufacturer
// database, constrained multimodal model). Downstream accounting
// code (capital-evidence, department, ranker) must consume ONLY the
// structured facts this interface produces — never raw webpage text
// (§19).
//
// This slice ships the interface, a NullProductReferenceProvider
// that always returns NO_RESULTS, and an in-memory ProductReference
// cache (§15). NO live external calls. Enabling a real external
// provider requires founder sign-off per §43.
//
// Security (§35): the request contract deliberately carries ONLY
// product-resolution facts (manufacturer / model / SKU / description
// excerpt / observed price). No member data, no banking data, no
// unrelated invoice content, no credentials.

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type ProductReferenceState =
  | "RESOLVED"
  | "PARTIAL"
  | "NO_RESULTS"
  | "CONFLICTING_RESULTS"
  | "LOW_QUALITY_RESULTS"
  | "TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_DISABLED";

export type ProductEvidenceType =
  | "OEM_PRODUCT_MATCH"
  | "OEM_PART_MATCH"
  | "OEM_SPECIFICATION"
  | "AUTHORIZED_DEALER_MATCH"
  | "MARKET_COMPARABLE"
  | "PRICE_PLAUSIBILITY";

export interface ProductReferenceEvidence {
  evidenceType: ProductEvidenceType;
  sourceDomain: string | null;
  sourceTitle: string | null;
  retrievedAt: string;
  queryFingerprint: string;
  matchedManufacturer: string | null;
  matchedModel: string | null;
  matchedPartNumber: string | null;
  matchedProductFamily: string | null;
  observedPrice: number | null;
  currency: string | null;
  confidence: number;
  /** Short structured fact — NEVER a full webpage. */
  evidenceSnippet: string;
}

export interface ProductPriceObservation {
  sourceDomain: string | null;
  sourceTitle: string | null;
  retrievedAt: string;
  matchedManufacturer: string | null;
  matchedModel: string | null;
  observedPrice: number;
  currency: string | null;
  observedAt: string;
  isNew: boolean | null;
  modelYear: number | null;
  isTaxInclusive: boolean | null;
  confidence: number;
}

export interface ProductReferenceRequest {
  brandCandidates: string[];
  modelCandidates: string[];
  skuCandidates: string[];
  serialCandidates: string[];
  descriptionExcerpt: string;
  observedUnitPrice: number | null;
  currency: string | null;
  maxCalls: number;
}

export interface ProductReferenceResult {
  state: ProductReferenceState;
  callCount: number;
  products: ProductReferenceEvidence[];
  prices: ProductPriceObservation[];
  diagnostic: string;
}

export interface ProductReferenceProvider {
  resolve(request: ProductReferenceRequest): Promise<ProductReferenceResult>;
}

// -----------------------------------------------------------------------------
// Null provider — always PROVIDER_DISABLED. Scaffolding default.
// -----------------------------------------------------------------------------

export class NullProductReferenceProvider implements ProductReferenceProvider {
  async resolve(_request: ProductReferenceRequest): Promise<ProductReferenceResult> {
    return {
      state: "PROVIDER_DISABLED",
      callCount: 0,
      products: [],
      prices: [],
      diagnostic: "no product-reference provider configured (Slice 5.4 scaffolding default)",
    };
  }
}

// -----------------------------------------------------------------------------
// ProductReference cache model (§15)
// -----------------------------------------------------------------------------

export interface ProductReference {
  manufacturer: string;
  model: string;
  partNumber?: string | null;
  productFamily: string;
  objectType: string;
  sourceEvidence: ProductReferenceEvidence[];
  confidence: number;
  firstSeenAt: string;
  lastVerifiedAt: string;
  expiresAt: string | null;
}

/** In-memory cache. A production deployment can swap this for a
 *  DB-backed store — the interface stays the same. */
export class InMemoryProductReferenceCache {
  private entries = new Map<string, ProductReference>();

  key(manufacturer: string, model: string, partNumber?: string | null): string {
    return `${manufacturer.trim().toUpperCase()}|${model.trim().toUpperCase()}|${(partNumber ?? "").trim().toUpperCase()}`;
  }

  get(manufacturer: string, model: string, partNumber?: string | null): ProductReference | null {
    const ref = this.entries.get(this.key(manufacturer, model, partNumber));
    if (!ref) return null;
    // Respect expiresAt if set.
    if (ref.expiresAt && new Date(ref.expiresAt).getTime() < Date.now()) {
      this.entries.delete(this.key(manufacturer, model, partNumber));
      return null;
    }
    return ref;
  }

  put(ref: ProductReference): void {
    this.entries.set(this.key(ref.manufacturer, ref.model, ref.partNumber), ref);
  }

  size(): number {
    return this.entries.size;
  }
}

// -----------------------------------------------------------------------------
// Query fingerprint — deterministic key for dedupe / caching (§14)
// -----------------------------------------------------------------------------

/** Deterministic fingerprint of a resolve request, used to dedupe
 *  identical lookups across invoices within a session and to key the
 *  cache. Fingerprint is normalized: uppercased, trimmed, ordered. */
export function fingerprintProductRequest(req: ProductReferenceRequest): string {
  const norm = (arr: string[]) => [...new Set(arr.map((s) => s.trim().toUpperCase()))].sort().join(",");
  return [
    norm(req.brandCandidates),
    norm(req.modelCandidates),
    norm(req.skuCandidates),
    norm(req.serialCandidates),
  ].join("|");
}
