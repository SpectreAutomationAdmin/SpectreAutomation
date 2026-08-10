// Sprint 3 · Checkpoint 15S (2026-07-29) — composite AP analysis
// version fingerprint.
//
// Founder rule (architectural reset, §Analysis-version requirements):
//   Persist at minimum: extraction-rule version, line-item/tax
//   version, economic-purpose version, GL-recommendation version,
//   composite AP-analysis version. Web and worker must report the
//   same current composite analysis version.
//
// This module is a pure function of module-level integer version
// constants declared next to each analyser primitive. Bump the
// component integer inside the corresponding module whenever its
// behaviour changes; the composite recomputes automatically and
// projections re-run on stale.

import { EXTRACTION_RULE_VERSION } from "./types";

// Component versions. Bump the integer inside the corresponding
// primitive module when its output could change for the same input.
//
// SUPPLIER_EXTRACT_VERSION lives here (rather than inside
// supplier-extract.ts) because supplier-extract exports a lot of
// helpers and we don't want to churn its public API; but the number
// MUST be bumped in this file whenever supplier-extract.ts changes.
export const SUPPLIER_EXTRACT_VERSION      = 3;   // 15Q rev + 15R rev + person-with-credential + region suffix + two-word min
export const LINE_ITEMS_EXTRACT_VERSION    = 5;   // 15Q rev + summary-tail refactor + 221178 follow-on generalized totals-block classifier + Ranker Authority slice: empty-description fallback + carry-forward rejection
export const TAX_RECONCILE_VERSION         = 2;   // 15Q rev
export const IDENTIFIER_TAXONOMY_VERSION   = 1;
export const ECONOMIC_PURPOSE_VERSION      = 2;   // + 221178 IT-taxonomy slice: CYBERSECURITY_SERVICE concept + backup/storage cues on SOFTWARE_SUBSCRIPTION
export const GL_RECOMMEND_VERSION          = 5;   // 15Q rev + IS_MEMBERSHIPS_SUBS taxonomy + posting-eligibility separation + threshold 60 + 221178 IT-taxonomy: it_services / software_subscription synonym expansion + cybersecurity_service concept + document-level IT coherence + Ranker Authority: family-incompatibility matrix (symmetric) with payroll gate at composer level

/**
 * The composite AP analysis version. Written to
 * WorkIntakeItem.analysisVersion at analysis time and to
 * ApIntakeSource.analysisVersionAtLink at ingestion time.
 *
 * When the projection reads a WorkIntakeItem whose analysisVersion
 * does not match this value, it triggers a controlled reanalysis
 * rather than mixing old + new logic silently.
 *
 * Format: `ap-v1:extract=<n>:supplier=<n>:lines=<n>:tax=<n>:ids=<n>:purpose=<n>:gl=<n>`
 *
 * The format is intentionally human-readable so the audit log +
 * diagnostic route can render it in plain text and an operator can
 * spot at a glance which component changed.
 */
export function currentAnalysisVersion(): string {
  return `ap-v1`
    + `:extract=${EXTRACTION_RULE_VERSION}`
    + `:supplier=${SUPPLIER_EXTRACT_VERSION}`
    + `:lines=${LINE_ITEMS_EXTRACT_VERSION}`
    + `:tax=${TAX_RECONCILE_VERSION}`
    + `:ids=${IDENTIFIER_TAXONOMY_VERSION}`
    + `:purpose=${ECONOMIC_PURPOSE_VERSION}`
    + `:gl=${GL_RECOMMEND_VERSION}`;
}

/**
 * Utility for the projection: given a stored version tag, return
 * whether it matches the CURRENT composite. Mismatch → stale,
 * reanalyse.
 */
export function isAnalysisVersionCurrent(stored: string | null | undefined): boolean {
  if (!stored) return false;
  return stored === currentAnalysisVersion();
}
