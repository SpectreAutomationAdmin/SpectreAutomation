// Sprint 3 · Checkpoint 15U (2026-07-28) — extract query concepts
// from analyser evidence.
//
// Per founder rule 15U §4 evidence weighting hierarchy:
//
//   Line-item descriptions              → STRONGEST
//   Dominant economic-purpose concept   → STRONG
//   Account-name-side similarity signals→ (computed at ranker time)
//   Taxonomy hints                       → (computed at ranker time)
//   Document section / recurring context → MEDIUM
//   Vendor historical coding             → SUPPORTING (0 for new vendors)
//   Tenant frequency                     → WEAK — final tie-break only
//   Supplier identity                    → WEAK context
//   Filename / sender / email subject    → ZERO

import { ACCOUNTING_CONCEPTS, CONCEPT_BY_ID, type AccountingConcept } from "./gl-concepts";
import { matchStrongestPhrase } from "./gl-similarity";
import type { PurposeCandidate } from "./economic-purpose";
import type { LineItem } from "./line-items-extract";

export type QuerySource =
  | "line_item_description"
  | "economic_purpose"
  | "document_phrase"
  | "supplier_identity"
  | "vendor_history";

// Weight multipliers by evidence source. Explicitly typed so future
// changes are visible in the diff.
export const SOURCE_WEIGHT: Record<QuerySource, number> = {
  line_item_description: 30,      // strongest
  economic_purpose: 26,           // strong
  document_phrase: 15,            // medium
  vendor_history: 8,              // supporting
  supplier_identity: 6,           // weak context
};

export interface QueryConcept {
  conceptId: string;
  concept: AccountingConcept;
  source: QuerySource;
  weight: number;                 // SOURCE_WEIGHT[source] × matchStrength/100
  matchStrength: number;          // 0..100 raw phrase match
  evidenceSnippet: string;
}

export interface QueryConceptInput {
  lineItems: LineItem[];
  economicPurposeCandidates: PurposeCandidate[] | null;
  fullDocumentText: string | null;
  supplierName: string | null;
  // 15U §11 — for new vendors this is empty; for established
  // vendors it names concepts observed in prior coding on THIS
  // tenant, used ONLY as supporting-tier evidence.
  vendorHistoryConceptIds?: string[];
}

// Purpose id → concept id mapping.
const PURPOSE_TO_CONCEPT: Record<string, string> = {
  employee_professional_membership_dues: "professional_membership_dues",
  external_accounting_or_audit_services: "external_accounting_services",
  professional_education_training: "training_and_education",
  licences_and_certifications: "licences_and_permits",
  regulatory_fees: "licences_and_permits",
  penalties_and_late_fees: "interest_and_penalties",
  member_dues_charged_by_club: "professional_membership_dues",   // supporting only
  employee_reimbursement: "professional_services",
  legal_or_consulting_services: "legal_services",
  recurring_communications_or_connectivity_service: "communications",
  recurring_utility_or_facility_service: "utilities",
  generic_supplies_or_services: "office_supplies_general",
};

export function extractQueryConcepts(input: QueryConceptInput): QueryConcept[] {
  const out: QueryConcept[] = [];

  // 1. Line-item descriptions — STRONGEST. For each line, find the
  //    strongest concept whose synonyms match the line text.
  //
  // Sprint 3 · Checkpoint 15U — line-item weight is scaled by the
  // line's AMOUNT PROPORTION of the invoice total. A small side
  // charge ("Penalty $150" on a $1,420 invoice — 11 %) contributes
  // 11 % of the base weight; a dominant line ("Internet $40" on a
  // $40 statement — 100 %) contributes the full weight. This is
  // §7's evidence hierarchy applied inside a single source: within
  // "line-item descriptions", larger lines carry more weight.
  const totalPositiveAmount = input.lineItems
    .map((l) => Math.abs(l.amount))
    .filter((a) => a > 0)
    .reduce((s, a) => s + a, 0);
  for (const l of input.lineItems) {
    const amount = Math.abs(l.amount);
    if (amount === 0) continue;
    // When we don't know the total (fixture tests with equal amounts,
    // or all-zero lines) default the proportion to 1 so single-item
    // documents behave the way tests expect.
    const proportion = totalPositiveAmount > 0
      ? amount / totalPositiveAmount
      : 1;
    // Floor so a tiny line still contributes non-zero weight and can
    // break a tie between larger lines.
    const scaledWeightMultiplier = Math.max(proportion, 0.15);
    for (const concept of ACCOUNTING_CONCEPTS) {
      const hit = matchStrongestPhrase(l.description, concept.synonyms, { minStrength: 45 });
      if (!hit) continue;
      out.push({
        conceptId: concept.id,
        concept,
        source: "line_item_description",
        matchStrength: hit.strength,
        weight: (SOURCE_WEIGHT.line_item_description * hit.strength * scaledWeightMultiplier) / 100,
        evidenceSnippet: `Line "${l.description.slice(0, 60)}" (${(proportion * 100).toFixed(0)}% of total) → ${hit.matchedPhrase} (${hit.kind})`,
      });
    }
  }

  // 2. Economic purpose — STRONG. Map top classifier candidate(s) to
  //    a concept id. Multiple candidates may fire when the classifier
  //    supports more than one branch above threshold.
  if (input.economicPurposeCandidates) {
    for (const cand of input.economicPurposeCandidates) {
      if (cand.score < 40) continue;   // §10 min-relevance for purpose
      const conceptId = PURPOSE_TO_CONCEPT[cand.purpose];
      if (!conceptId) continue;
      const concept = CONCEPT_BY_ID[conceptId];
      if (!concept) continue;
      // Purpose evidence strength scales with the classifier's score
      // (60→60%, 90→100%).
      const matchStrength = Math.min(100, Math.round((cand.score / 90) * 100));
      out.push({
        conceptId,
        concept,
        source: "economic_purpose",
        matchStrength,
        weight: (SOURCE_WEIGHT.economic_purpose * matchStrength) / 100,
        evidenceSnippet: `Economic purpose "${cand.classificationConcept}" (score ${cand.score})`,
      });
    }
  }

  // 3. Full-document phrase signals — MEDIUM. Every concept's
  //    synonyms are checked against the full document body. Only
  //    EXACT-PHRASE matches are accepted — the document body is
  //    long enough that "all-tokens-present" fires accidentally
  //    when unrelated words happen to co-occur (e.g. "account" +
  //    "fee" in an OXIO doc scores as an "accounting fee" match).
  //    Weaker than line-item evidence because it lacks per-line
  //    grounding.
  if (input.fullDocumentText) {
    for (const concept of ACCOUNTING_CONCEPTS) {
      const hit = matchStrongestPhrase(input.fullDocumentText, concept.synonyms, { minStrength: 60 });
      if (!hit || hit.kind !== "exact_phrase") continue;
      // Skip if a strong line-item match for the same concept exists —
      // avoid double-counting the same evidence.
      const existingStrong = out.find((q) => q.conceptId === concept.id && q.source === "line_item_description");
      if (existingStrong && existingStrong.matchStrength >= hit.strength) continue;
      out.push({
        conceptId: concept.id,
        concept,
        source: "document_phrase",
        matchStrength: hit.strength,
        weight: (SOURCE_WEIGHT.document_phrase * hit.strength) / 100,
        evidenceSnippet: `Document phrase "${hit.matchedPhrase}"`,
      });
    }
  }

  // 4. Vendor history — SUPPORTING. Only for established vendors.
  //    Weight is capped so it cannot overpower current invoice
  //    evidence (§11).
  for (const conceptId of input.vendorHistoryConceptIds ?? []) {
    const concept = CONCEPT_BY_ID[conceptId];
    if (!concept) continue;
    out.push({
      conceptId,
      concept,
      source: "vendor_history",
      matchStrength: 80,
      weight: (SOURCE_WEIGHT.vendor_history * 80) / 100,
      evidenceSnippet: `Vendor historically coded to "${concept.canonicalName}"`,
    });
  }

  // 5. Supplier identity — WEAK context. Only fires when the supplier
  //    name itself contains a strong industry cue (e.g. "Law
  //    Corporation" → legal_services). Deliberately narrow.
  if (input.supplierName) {
    for (const concept of ACCOUNTING_CONCEPTS) {
      const hit = matchStrongestPhrase(input.supplierName, concept.synonyms, { minStrength: 75 });
      if (!hit) continue;
      out.push({
        conceptId: concept.id,
        concept,
        source: "supplier_identity",
        matchStrength: hit.strength,
        weight: (SOURCE_WEIGHT.supplier_identity * hit.strength) / 100,
        evidenceSnippet: `Supplier "${input.supplierName}" → ${hit.matchedPhrase}`,
      });
    }
  }

  // Deterministic order — strongest evidence first, ties by concept id.
  out.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (a.conceptId !== b.conceptId) return a.conceptId.localeCompare(b.conceptId);
    return a.source.localeCompare(b.source);
  });
  return out;
}

// Dominant query concept — the concept with the highest ACCUMULATED
// weight across all its query-side evidence. Used for specificity
// checks and for the structured rationale's `selectedConcept`.
export function dominantQueryConcept(qcs: QueryConcept[]): QueryConcept | null {
  if (qcs.length === 0) return null;
  const totals = new Map<string, { weight: number; strongest: QueryConcept }>();
  for (const q of qcs) {
    const cur = totals.get(q.conceptId);
    if (!cur) totals.set(q.conceptId, { weight: q.weight, strongest: q });
    else {
      cur.weight += q.weight;
      if (q.weight > cur.strongest.weight) cur.strongest = q;
    }
  }
  const ranked = [...totals.entries()].sort((a, b) => {
    if (b[1].weight !== a[1].weight) return b[1].weight - a[1].weight;
    return a[0].localeCompare(b[0]);
  });
  return ranked[0]?.[1].strongest ?? null;
}
