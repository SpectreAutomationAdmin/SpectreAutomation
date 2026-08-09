// Sprint 3 · Phase 4 Slice 5.6 (2026-08-09) — FixtureProduct
// ReferenceProvider.
//
// A deterministic in-memory provider used by unit + integration
// tests. Given a set of pre-seeded ProductReferenceEvidence records
// keyed by request fingerprint, returns them without any network I/O.
// Failure states (TIMEOUT / NO_RESULTS / CONFLICTING / rate-limit)
// are directly injectable so the test corpus can exercise §19 failure
// behaviour.

import {
  fingerprintProductRequest,
  type ProductReferenceEvidence,
  type ProductPriceObservation,
  type ProductReferenceProvider,
  type ProductReferenceRequest,
  type ProductReferenceResult,
  type ProductReferenceState,
} from "../product-reference-provider";

export interface FixtureEntry {
  state: ProductReferenceState;
  products?: ProductReferenceEvidence[];
  prices?: ProductPriceObservation[];
  diagnostic?: string;
}

export class FixtureProductReferenceProvider implements ProductReferenceProvider {
  private readonly entries = new Map<string, FixtureEntry>();
  private readonly fallback: FixtureEntry;
  public callCount = 0;

  constructor(fallback: FixtureEntry = { state: "NO_RESULTS" }) {
    this.fallback = fallback;
  }

  seed(request: ProductReferenceRequest, entry: FixtureEntry): void {
    this.entries.set(fingerprintProductRequest(request), entry);
  }

  seedByFingerprint(fingerprint: string, entry: FixtureEntry): void {
    this.entries.set(fingerprint, entry);
  }

  async resolve(request: ProductReferenceRequest): Promise<ProductReferenceResult> {
    this.callCount += 1;
    const fp = fingerprintProductRequest(request);
    const entry = this.entries.get(fp) ?? this.fallback;
    return {
      state: entry.state,
      callCount: 1,
      products: entry.products ?? [],
      prices: entry.prices ?? [],
      diagnostic: entry.diagnostic ?? `fixture entry state=${entry.state} fingerprint=${fp}`,
    };
  }
}
