// Sprint 3 · Checkpoint 15V (2026-07-29) — multi-GL allocation
// engine.
//
// Founder rule 15V §1: preserve the 15U full-tenant deterministic
// ranker. Every allocation runs the same ranking pipeline over the
// same eligible tenant COA. This module CLUSTERS invoice lines into
// economic-purpose groups and asks the 15U ranker for the best
// account per group.
//
// Groups are formed by:
//   1. Extracting the dominant concept per line from the line's own
//      description (matchStrongestPhrase across the whole catalog).
//   2. When a line has NO strong per-line concept, falling back to
//      the DOCUMENT-level dominant concept (invoice header context —
//      e.g. "Member Dues for [Name]" in the CPA doc lifts otherwise
//      opaque lines like "CPA Alberta Fee" into the membership-dues
//      bucket).
//   3. Optionally, when a line has NEITHER a per-line concept nor a
//      document-level fallback, treating it as UNRESOLVED — an
//      allocation that requiresReview.
//
// Two clusters are MERGED after ranking when both select the same
// tenant account — a tenant COA that doesn't split e.g. draft vs
// packaged beer naturally collapses to one allocation without any
// explicit rule.
//
// Materiality (§6): interest, tax, credits, and separately stated
// ancillary charges (delivery / freight / surcharge / penalty)
// retain their own allocation regardless of amount. Other concepts
// use a small de-minimis threshold ($1) to avoid emitting spurious
// allocations from rounding noise.
//
// Amount-weighted evidence (§7): the DOMINANT invoice concept
// (single-concept classification, display summary, card confidence)
// uses amount-weighted evidence. Per-line ALLOCATION decisions are
// grounded in the line's own text — a small side charge retains its
// own allocation even when it's a small fraction of the invoice.

import { rankAccountsPure, type PostingBlocker } from "./gl-recommend";
import type { AccountView } from "./gl-account-concepts";
import { extractQueryConcepts, dominantQueryConcept, type QueryConcept } from "./gl-query-concepts";
import { ACCOUNTING_CONCEPTS, CONCEPT_BY_ID } from "./gl-concepts";
import { matchStrongestPhrase } from "./gl-similarity";
import type { LineItem, LineTaxTreatment } from "./line-items-extract";
import type { PurposeCandidate } from "./economic-purpose";

export type AllocationTaxTreatment =
  | "TAXABLE"
  | "EXEMPT"
  | "ZERO_RATED"
  | "OUT_OF_SCOPE"
  | "MIXED"
  | "UNKNOWN";

export interface AllocationRecommendedAccount {
  accountId: string;
  accountNumber: string;
  accountName: string;
  confidence: number;                 // 0..100
  requiresReview: boolean;
  postingBlockers: PostingBlocker[];
}

export interface AllocationAlternative {
  accountId: string;
  accountNumber: string;
  accountName: string;
  score: number;
}

export interface ApGlAllocation {
  id: string;                         // deterministic — hash of concept + accountNumber + line ids
  sourceLineItemIds: string[];        // stringified lineNo indices
  descriptions: string[];
  economicPurpose: {
    concept: string;                  // AccountingConcept.id or "unresolved"
    confidence: number;
    supportingEvidence: string[];
  };
  amount: number;                     // sum of positive line amounts in this group
  taxTreatment: AllocationTaxTreatment;
  taxRate: number | null;
  taxAmount: number | null;
  recommendedAccount: AllocationRecommendedAccount | null;   // null when unresolved
  alternatives: AllocationAlternative[];
}

export interface AllocationTotals {
  allocationsSubtotal: number;        // sum of positive allocation amounts
  taxTotal: number;                   // recoverable + non-recoverable tax on taxable allocations
  creditTotal: number;                // sum of |negative line amounts| across the invoice
  grossTotal: number;                 // printed gross payable
  allocationVariance: number;         // gross - (subtotal + tax - credits)
}

export interface AllocationResult {
  allocations: ApGlAllocation[];
  totals: AllocationTotals;
  // Derived Category cell value per §8. "Multiple" when >=2 material
  // GL allocations; single account name when 1; null when nothing
  // was resolvable.
  cardCategory: string | null;
  requiresReview: boolean;
  // Sprint 3 · Post-16H Phase 2.1 (2026-08-06) — allocation
  // eligibility mode.
  //   PER_ALLOCATION    — each allocation was evaluated with its own
  //                       AccountingTransactionContext derived from its
  //                       own line-item / purpose evidence.
  //   DOCUMENT_FALLBACK — one document-level context reused across
  //                       every allocation (current Phase 2 wiring).
  //   NOT_EVALUATED     — eligibility service was not consulted for
  //                       this allocation set (e.g. legacy path).
  // Only PER_ALLOCATION may qualify for AUTO_APPROVAL_ELIGIBLE
  // (Phase 3 §B3). Multi-allocation invoices under DOCUMENT_FALLBACK
  // must remain requiresReview=true — Phase 2.1 §A5.
  allocationEligibilityMode: "PER_ALLOCATION" | "DOCUMENT_FALLBACK" | "NOT_EVALUATED";
}

export interface AllocationInput {
  lineItems: LineItem[];
  accounts: AccountView[];
  postingBlockersByAccount: Map<string, PostingBlocker[]>;
  economicPurposeCandidates: PurposeCandidate[] | null;
  fullDocumentText: string | null;
  supplierName: string | null;
  vendorHistoryConceptIds?: string[];
  printedSubtotal: number | null;
  printedTax: number | null;
  printedTotal: number | null;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Materiality threshold (§6). Amounts below this are still assigned
// to their own allocation IF the concept is in the SPECIAL_HANDLING
// set below (interest, penalty, credit, ancillary charges) —
// otherwise merged into the nearest sibling by concept relatedness.
const DE_MINIMIS_AMOUNT = 1.00;

// Concepts that ALWAYS retain their own allocation regardless of
// amount (§6). The founder's rule: interest, tax, credits, and
// separately stated ancillary charges may require their own
// accounting treatment regardless of materiality.
const SPECIAL_HANDLING_CONCEPTS = new Set<string>([
  "interest_and_penalties",
  "finance_interest_charge",
  "late_payment_penalty",
  "delivery_and_freight",
  "fuel_surcharge",
  "environmental_surcharge",
]);

// Per-line minimum evidence to accept a per-line concept assignment.
// Below this, the line falls back to the document-level dominant
// concept.
const PER_LINE_CONCEPT_MIN_STRENGTH = 55;

// Recommendation confidence gate (§13). Alignment with the 15U min-
// relevance threshold.
const RECOMMENDATION_MIN_SCORE = 40;

// -----------------------------------------------------------------------------
// Per-line concept assignment
// -----------------------------------------------------------------------------

interface LineAssignment {
  line: LineItem;
  conceptId: string | null;
  conceptSource: "line_description" | "document_fallback" | "unresolved";
  matchStrength: number;              // 0..100
  matchedPhrase: string;
}

function assignConceptToLine(line: LineItem, docFallbackConceptId: string | null): LineAssignment {
  // Search the whole catalog for the strongest per-line concept match.
  let best: { conceptId: string; strength: number; phrase: string; depth: number } | null = null;
  for (const concept of ACCOUNTING_CONCEPTS) {
    const hit = matchStrongestPhrase(line.description, concept.synonyms, { minStrength: PER_LINE_CONCEPT_MIN_STRENGTH });
    if (!hit) continue;
    // Specificity tie-break — deeper concept wins when strengths are close.
    if (!best
        || hit.strength > best.strength + 3
        || (Math.abs(hit.strength - best.strength) <= 3 && concept.depth > best.depth)) {
      best = { conceptId: concept.id, strength: hit.strength, phrase: hit.matchedPhrase, depth: concept.depth };
    }
  }
  if (best) {
    return { line, conceptId: best.conceptId, conceptSource: "line_description", matchStrength: best.strength, matchedPhrase: best.phrase };
  }
  if (docFallbackConceptId) {
    return { line, conceptId: docFallbackConceptId, conceptSource: "document_fallback", matchStrength: 40, matchedPhrase: "" };
  }
  return { line, conceptId: null, conceptSource: "unresolved", matchStrength: 0, matchedPhrase: "" };
}

// -----------------------------------------------------------------------------
// Determine the document-level fallback concept
// -----------------------------------------------------------------------------

function documentFallbackConcept(args: {
  economicPurposeCandidates: PurposeCandidate[] | null;
  fullDocumentText: string | null;
}): { conceptId: string; supportingEvidence: string[] } | null {
  const purpose = args.economicPurposeCandidates?.[0];
  if (purpose && purpose.score >= 40) {
    const conceptId = PURPOSE_TO_CONCEPT[purpose.purpose];
    if (conceptId) {
      return {
        conceptId,
        supportingEvidence: [`Document purpose "${purpose.classificationConcept}" (score ${purpose.score})`],
      };
    }
  }
  return null;
}

// Duplicate of the mapping in gl-query-concepts.ts, kept local so
// this module can be tested in isolation without imports cycles.
const PURPOSE_TO_CONCEPT: Record<string, string> = {
  employee_professional_membership_dues: "professional_membership_dues",
  external_accounting_or_audit_services: "external_accounting_services",
  professional_education_training: "training_and_education",
  licences_and_certifications: "licences_and_permits",
  regulatory_fees: "licences_and_permits",
  penalties_and_late_fees: "late_payment_penalty",
  member_dues_charged_by_club: "professional_membership_dues",
  employee_reimbursement: "professional_services",
  legal_or_consulting_services: "legal_services",
  recurring_communications_or_connectivity_service: "communications",
  recurring_utility_or_facility_service: "utilities",
  generic_supplies_or_services: "office_supplies_general",
};

// -----------------------------------------------------------------------------
// Cluster lines by concept
// -----------------------------------------------------------------------------

interface RawCluster {
  conceptId: string | null;           // null = unresolved cluster
  assignments: LineAssignment[];
  totalAmount: number;
}

function buildClusters(assignments: LineAssignment[]): RawCluster[] {
  const clusters = new Map<string, RawCluster>();
  for (const a of assignments) {
    const key = a.conceptId ?? "__unresolved__";
    let c = clusters.get(key);
    if (!c) {
      c = { conceptId: a.conceptId, assignments: [], totalAmount: 0 };
      clusters.set(key, c);
    }
    c.assignments.push(a);
    c.totalAmount += a.line.amount;   // may be negative for credits
  }
  return [...clusters.values()];
}

// -----------------------------------------------------------------------------
// Rank each cluster against the full tenant COA
// -----------------------------------------------------------------------------

interface RankedCluster {
  cluster: RawCluster;
  rankedTop: ReturnType<typeof rankAccountsPure>;
}

function rankClusters(args: {
  clusters: RawCluster[];
  accounts: AccountView[];
  postingBlockersByAccount: Map<string, PostingBlocker[]>;
  vendorHistoryConceptIds?: string[];
}): RankedCluster[] {
  return args.clusters.map((cluster) => {
    if (!cluster.conceptId) {
      return { cluster, rankedTop: [] };
    }
    // Sprint 3 · Checkpoint 15V — per-cluster ranking is grounded in
    // the cluster's own CONCEPT + its own line evidence. The
    // cluster's conceptId (from per-line evidence OR from document-
    // level fallback) becomes a synthetic query concept so lines
    // like "CPA Alberta Fee" that carry no per-line synonym match
    // still steer their cluster toward the right membership-dues
    // account. The document-WIDE purpose (which spans ALL clusters
    // and would drag the interest allocation back onto membership)
    // is NOT replayed here.
    const clusterLines = cluster.assignments.map((a) => a.line);
    const queryConcepts = extractQueryConcepts({
      lineItems: clusterLines,
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      vendorHistoryConceptIds: args.vendorHistoryConceptIds,
    });
    // Synthetic cluster-concept evidence — always add the cluster's
    // dominant concept as a supporting query signal so the ranker
    // can route an opaque line to the semantically correct account.
    const clusterConcept = CONCEPT_BY_ID[cluster.conceptId];
    if (clusterConcept) {
      queryConcepts.push({
        conceptId: cluster.conceptId,
        concept: clusterConcept,
        source: "economic_purpose",
        matchStrength: 85,
        weight: 20,
        evidenceSnippet: `Cluster concept "${clusterConcept.canonicalName}"`,
      });
    }
    const ranked = rankAccountsPure({
      accounts: args.accounts,
      queryConcepts,
      postingBlockersByAccount: args.postingBlockersByAccount,
    });
    return { cluster, rankedTop: ranked };
  });
}

// -----------------------------------------------------------------------------
// Merge clusters that select the same account
// -----------------------------------------------------------------------------

function mergeSameAccountClusters(ranked: RankedCluster[]): RankedCluster[] {
  const byAccount = new Map<string, RankedCluster[]>();
  const unresolved: RankedCluster[] = [];
  for (const r of ranked) {
    const top = r.rankedTop[0];
    if (!top || top.semanticScore < RECOMMENDATION_MIN_SCORE) {
      // No confident recommendation — retain as its own cluster (may
      // be merged into unresolved allocation later).
      unresolved.push(r);
      continue;
    }
    const key = top.accountNumber;
    let list = byAccount.get(key);
    if (!list) { list = []; byAccount.set(key, list); }
    list.push(r);
  }
  const merged: RankedCluster[] = [];
  for (const [_accountNumber, list] of byAccount) {
    if (list.length === 1) {
      merged.push(list[0]);
      continue;
    }
    // Merge: combine cluster line assignments into one.
    const combined: RawCluster = {
      // Concept id becomes the dominant one across the merged list.
      conceptId: pickDominantConcept(list),
      assignments: list.flatMap((r) => r.cluster.assignments),
      totalAmount: list.reduce((s, r) => s + r.cluster.totalAmount, 0),
    };
    // Reuse the ranker top from the highest-scoring input.
    const best = list.reduce((a, b) => (a.rankedTop[0]?.semanticScore ?? 0) >= (b.rankedTop[0]?.semanticScore ?? 0) ? a : b);
    merged.push({ cluster: combined, rankedTop: best.rankedTop });
  }
  // Concatenate unresolved separately so they don't merge into
  // account clusters.
  merged.push(...unresolved);
  return merged;
}

function pickDominantConcept(list: RankedCluster[]): string {
  // Amount-weighted vote across concepts within the merged list.
  const totals = new Map<string, number>();
  for (const r of list) {
    if (!r.cluster.conceptId) continue;
    totals.set(r.cluster.conceptId, (totals.get(r.cluster.conceptId) ?? 0) + Math.abs(r.cluster.totalAmount));
  }
  const ranked = [...totals.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  return ranked[0]?.[0] ?? "unresolved";
}

// -----------------------------------------------------------------------------
// Materiality: apply §6 rules to keep or merge small allocations
// -----------------------------------------------------------------------------

function applyMateriality(clusters: RankedCluster[]): RankedCluster[] {
  return clusters.filter((r) => {
    const positiveAmount = r.cluster.assignments
      .filter((a) => a.line.amount > 0)
      .reduce((s, a) => s + a.line.amount, 0);
    if (Math.abs(r.cluster.totalAmount) < DE_MINIMIS_AMOUNT && positiveAmount < DE_MINIMIS_AMOUNT) return false;
    if (positiveAmount >= DE_MINIMIS_AMOUNT) return true;
    // Below de-minimis. Keep only if special-handling concept.
    if (r.cluster.conceptId && SPECIAL_HANDLING_CONCEPTS.has(r.cluster.conceptId)) return true;
    return false;
  });
}

// -----------------------------------------------------------------------------
// Convert clusters into ApGlAllocation objects
// -----------------------------------------------------------------------------

function toAllocations(clusters: RankedCluster[]): ApGlAllocation[] {
  return clusters.map((r) => {
    const positiveLines = r.cluster.assignments.filter((a) => a.line.amount > 0);
    const amount = round2(positiveLines.reduce((s, a) => s + a.line.amount, 0));
    const taxTreatment = aggregateTaxTreatment(r.cluster.assignments.map((a) => a.line.taxTreatment));
    const taxRate = pickTaxRate(r.cluster.assignments);
    const taxAmount = pickTaxAmount(r.cluster.assignments);
    const top = r.rankedTop[0] ?? null;
    const recommendedAccount: AllocationRecommendedAccount | null = top
      ? {
          accountId: `a-${top.accountNumber}`,
          accountNumber: top.accountNumber,
          accountName: top.accountName,
          confidence: Math.min(95, top.semanticScore),
          requiresReview: top.semanticScore < RECOMMENDATION_MIN_SCORE,
          postingBlockers: top.postingBlockers,
        }
      : null;
    const alternatives: AllocationAlternative[] = r.rankedTop.slice(1, 4).map((c) => ({
      accountId: `a-${c.accountNumber}`,
      accountNumber: c.accountNumber,
      accountName: c.accountName,
      score: c.semanticScore,
    }));
    return {
      id: allocationId(r.cluster.conceptId ?? "unresolved", top?.accountNumber ?? "0000", r.cluster.assignments.map((a) => a.line.lineNo)),
      sourceLineItemIds: r.cluster.assignments.map((a) => String(a.line.lineNo)),
      descriptions: r.cluster.assignments.map((a) => a.line.description),
      economicPurpose: {
        concept: r.cluster.conceptId ?? "unresolved",
        confidence: r.cluster.conceptId
          ? Math.min(95, Math.round(r.cluster.assignments.reduce((s, a) => s + a.matchStrength, 0) / r.cluster.assignments.length))
          : 0,
        supportingEvidence: r.cluster.assignments
          .filter((a) => a.matchedPhrase)
          .map((a) => `Line "${a.line.description.slice(0, 60)}" → ${a.matchedPhrase} (${a.conceptSource})`)
          .slice(0, 6),
      },
      amount,
      taxTreatment,
      taxRate,
      taxAmount,
      recommendedAccount,
      alternatives,
    };
  });
}

function aggregateTaxTreatment(treatments: LineTaxTreatment[]): AllocationTaxTreatment {
  const distinct = new Set(treatments);
  if (distinct.size === 0) return "UNKNOWN";
  if (distinct.size === 1) {
    const only = [...distinct][0];
    switch (only) {
      case "taxable": return "TAXABLE";
      case "exempt": return "EXEMPT";
      case "zero_rated": return "ZERO_RATED";
      case "out_of_scope": return "OUT_OF_SCOPE";
      case "unknown": return "UNKNOWN";
    }
  }
  return "MIXED";
}

function pickTaxRate(assignments: LineAssignment[]): number | null {
  for (const a of assignments) {
    if (a.line.taxRate != null) return a.line.taxRate;
  }
  return null;
}

function pickTaxAmount(assignments: LineAssignment[]): number | null {
  const taxable = assignments
    .filter((a) => a.line.taxAmount != null)
    .reduce((s, a) => s + (a.line.taxAmount ?? 0), 0);
  return taxable > 0 ? round2(taxable) : null;
}

function allocationId(conceptId: string, accountNumber: string, lineNos: number[]): string {
  const lines = lineNos.slice().sort((a, b) => a - b).join(",");
  // Simple deterministic hash — good enough for test IDs; not a
  // cryptographic identifier.
  let hash = 0;
  const raw = `${conceptId}|${accountNumber}|${lines}`;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return `alloc_${(hash >>> 0).toString(36)}`;
}

// -----------------------------------------------------------------------------
// Deterministic sort of allocations (§1)
// -----------------------------------------------------------------------------

function sortAllocations(allocations: ApGlAllocation[]): ApGlAllocation[] {
  return [...allocations].sort((a, b) => {
    if (b.amount !== a.amount) return b.amount - a.amount;
    if ((b.economicPurpose.confidence) !== (a.economicPurpose.confidence)) {
      return b.economicPurpose.confidence - a.economicPurpose.confidence;
    }
    const aAcct = a.recommendedAccount?.accountNumber ?? "9999";
    const bAcct = b.recommendedAccount?.accountNumber ?? "9999";
    return aAcct.localeCompare(bAcct);
  });
}

// -----------------------------------------------------------------------------
// Reconciliation totals + card category derivation
// -----------------------------------------------------------------------------

function computeTotals(args: {
  allocations: ApGlAllocation[];
  lineItems: LineItem[];
  printedSubtotal: number | null;
  printedTax: number | null;
  printedTotal: number | null;
}): AllocationTotals {
  const allocationsSubtotal = round2(args.allocations.reduce((s, a) => s + a.amount, 0));
  const creditTotal = round2(
    args.lineItems
      .filter((l) => l.amount < 0)
      .reduce((s, l) => s + Math.abs(l.amount), 0),
  );
  const taxTotal = args.printedTax ?? 0;
  const grossTotal = args.printedTotal ?? (args.printedSubtotal ?? allocationsSubtotal) + taxTotal - creditTotal;
  const derived = round2(allocationsSubtotal + taxTotal - creditTotal);
  const allocationVariance = round2(grossTotal - derived);
  return { allocationsSubtotal, taxTotal, creditTotal, grossTotal, allocationVariance };
}

function deriveCardCategory(allocations: ApGlAllocation[]): string | null {
  // §8: Multiple specifically means more than one PROPOSED expense/
  // asset GL allocation. Tax splits alone do NOT trigger Multiple.
  const withAccount = allocations.filter((a) => a.recommendedAccount != null && !a.recommendedAccount.requiresReview);
  if (withAccount.length === 0) return null;
  if (withAccount.length === 1) return withAccount[0].recommendedAccount!.accountName;
  return "Multiple";
}

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export function computeAllocations(input: AllocationInput): AllocationResult {
  const positiveLines = input.lineItems.filter((l) => l.amount > 0);
  if (positiveLines.length === 0) {
    return {
      allocations: [],
      totals: computeTotals({
        allocations: [],
        lineItems: input.lineItems,
        printedSubtotal: input.printedSubtotal,
        printedTax: input.printedTax,
        printedTotal: input.printedTotal,
      }),
      cardCategory: null,
      requiresReview: true,
      allocationEligibilityMode: "NOT_EVALUATED",
    };
  }

  // Step 1: document-level fallback concept.
  const docFallback = documentFallbackConcept({
    economicPurposeCandidates: input.economicPurposeCandidates,
    fullDocumentText: input.fullDocumentText,
  });

  // Step 2: per-line concept assignment.
  const assignments = positiveLines.map((line) =>
    assignConceptToLine(line, docFallback?.conceptId ?? null),
  );

  // Step 3: raw clustering by concept.
  const rawClusters = buildClusters(assignments);

  // Step 4: rank each cluster against the full tenant COA.
  const ranked = rankClusters({
    clusters: rawClusters,
    accounts: input.accounts,
    postingBlockersByAccount: input.postingBlockersByAccount,
    vendorHistoryConceptIds: input.vendorHistoryConceptIds,
  });

  // Step 5: merge clusters that select the same account.
  const merged = mergeSameAccountClusters(ranked);

  // Step 6: materiality filter (keeps special-handling small
  // allocations; drops others below de-minimis).
  const material = applyMateriality(merged);

  // Step 7: build allocations.
  const allocations = sortAllocations(toAllocations(material));

  // Step 8: reconciliation totals.
  const totals = computeTotals({
    allocations,
    lineItems: input.lineItems,
    printedSubtotal: input.printedSubtotal,
    printedTax: input.printedTax,
    printedTotal: input.printedTotal,
  });

  // Step 9: derive card category + requiresReview.
  const cardCategory = deriveCardCategory(allocations);
  // Phase 2.1 (2026-08-06) §A5 — until per-allocation eligibility
  // context wiring lands, multi-allocation invoices are always
  // requiresReview=true. The current Phase 2 wire threads one
  // document-level `expectedDebitRole` through recommendGlAccount,
  // which the ranker reuses for every candidate; each allocation
  // has NOT been evaluated with its own transaction context yet.
  // Report the mode explicitly so the workflow layer (Phase 3) can
  // block AUTO_APPROVAL_ELIGIBLE on anything other than
  // PER_ALLOCATION.
  const materialAllocations = allocations.filter((a) => Math.abs(a.amount) >= 0.01).length;
  // NOTE: DOCUMENT_FALLBACK is currently the only mode this function
  // emits — per-allocation contexts are threaded end-to-end in Phase 3.
  // Widening `allocationEligibilityMode` to a broader union here
  // avoids a spurious TS "no overlap" check on the requiresReview
  // guard below and keeps the invariant explicit.
  const allocationEligibilityMode: AllocationResult["allocationEligibilityMode"] = "DOCUMENT_FALLBACK";
  const multiAllocationBlocked =
    materialAllocations >= 2 && (allocationEligibilityMode as string) !== "PER_ALLOCATION";
  const requiresReview =
    allocations.length === 0
    || allocations.some((a) => a.recommendedAccount == null || a.recommendedAccount.requiresReview)
    || Math.abs(totals.allocationVariance) > 0.02
    || multiAllocationBlocked;

  return { allocations, totals, cardCategory, requiresReview, allocationEligibilityMode };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
