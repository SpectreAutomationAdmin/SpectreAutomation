// Sprint 3 · Phase 4 Slice 5.4 (2026-08-08) — Price-plausibility
// interface.
//
// Founder §6 + §18: price plausibility is BAND-based (VERY_LOW / LOW
// / PLAUSIBLE / HIGH / VERY_HIGH), not threshold-based. And the
// bands MUST come from structured reference evidence — NOT
// hardcoded rules like "engines cost < $20,000".
//
// This module defines the interface + a NullPricePlausibilityProvider
// that always returns UNKNOWN. A future ReferenceCatalogProvider (fed
// by curated product-reference cache) or ExternalMarketProvider will
// implement the same interface. The interface stays out of the
// accounting boundary — capital-evidence.ts must not use price
// plausibility directly (§1 invariant).

import type { ProductObjectType } from "./product-identity-resolution";

export type PricePlausibilityBand =
  | "VERY_LOW"
  | "LOW"
  | "PLAUSIBLE"
  | "HIGH"
  | "VERY_HIGH"
  | "UNKNOWN";

export interface PricePlausibilityRequest {
  objectType: ProductObjectType;
  brandCandidates: string[];
  modelCandidates: string[];
  observedUnitPrice: number;
  currency: string | null;
  quantity: number;
  unit: string | null;
}

export interface PricePlausibilityResult {
  band: PricePlausibilityBand;
  /** Optional reference range if the provider computed one. */
  referenceLow?: number;
  referenceHigh?: number;
  /** Diagnostic reason — e.g. "OEM catalog $60k-$80k new" or "no
   *  reference data available for objectType". */
  reason?: string;
  /** Source domain / provenance for evidence traceability. */
  sourceDomain?: string;
  /** Observation date for market-comparable evidence (§16 caching
   *  policy). */
  observedAt?: string;
}

export interface PricePlausibilityProvider {
  classify(request: PricePlausibilityRequest): Promise<PricePlausibilityResult>;
}

// -----------------------------------------------------------------------------
// Null provider — always UNKNOWN
// -----------------------------------------------------------------------------

/** Default provider. Always returns UNKNOWN band with no side effects.
 *  Slice 5.4 scaffolding ships with this provider active. When a
 *  reference-catalog or external-market provider is authorised (§43
 *  sign-off), swap it in via the analyse.ts caller. */
export class NullPricePlausibilityProvider implements PricePlausibilityProvider {
  async classify(_request: PricePlausibilityRequest): Promise<PricePlausibilityResult> {
    return {
      band: "UNKNOWN",
      reason: "no reference data provider configured",
    };
  }
}
