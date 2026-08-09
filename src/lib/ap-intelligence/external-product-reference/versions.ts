// Sprint 3 · Phase 4 Slice 5.7B (2026-08-09) — version parity
// contract between web + worker + durable DB rows.
//
// §12 versioning + §13 web/worker version parity.
//
// These constants MUST bump together on any breaking change to the
// evidence structure OR the provider contract. The worker refuses to
// process jobs whose `researchVersion` != PRODUCT_REFERENCE_RESEARCH_VERSION;
// the web tier refuses to seed cached evidence whose
// `evidenceSchemaVersion` != PRODUCT_REFERENCE_EVIDENCE_SCHEMA_VERSION.
// /api/health surfaces both so a mismatched deploy is observable.
//
// Bump policy:
//   - PRODUCT_REFERENCE_EVIDENCE_SCHEMA_VERSION: any breaking change to
//     ProductReferenceEvidence or ProductReference JSON columns.
//   - PRODUCT_REFERENCE_RESEARCH_VERSION: any semantically-meaningful
//     change to how the provider is invoked (new query strategy, new
//     source-tier weighting, new privacy filter). Old evidence with the
//     prior version is still usable for identity — new research reruns.

export const PRODUCT_REFERENCE_EVIDENCE_SCHEMA_VERSION = "1" as const;
export const PRODUCT_REFERENCE_RESEARCH_VERSION = "1" as const;

// Compat check used by the worker + web-side reader. Returns whether
// stored evidence at `evidenceSchemaVersion` can still be interpreted
// safely by the current runtime.
export function isEvidenceSchemaCompatible(evidenceSchemaVersion: string | null | undefined): boolean {
  if (!evidenceSchemaVersion) return false;
  return evidenceSchemaVersion === PRODUCT_REFERENCE_EVIDENCE_SCHEMA_VERSION;
}

export function isResearchVersionCurrent(researchVersion: string | null | undefined): boolean {
  if (!researchVersion) return false;
  return researchVersion === PRODUCT_REFERENCE_RESEARCH_VERSION;
}

export function currentProductReferenceVersions(): {
  researchVersion: string;
  evidenceSchemaVersion: string;
} {
  return {
    researchVersion: PRODUCT_REFERENCE_RESEARCH_VERSION,
    evidenceSchemaVersion: PRODUCT_REFERENCE_EVIDENCE_SCHEMA_VERSION,
  };
}
