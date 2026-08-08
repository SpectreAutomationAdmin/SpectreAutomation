// Sprint 3 · Phase 4 Slice 5.3 (2026-08-08) — evidence-based
// capital-vs-operating decision.
//
// Founder amendments #6 + #7 + #8:
//   PurchasedItemIdentity determines WHAT the thing is.
//   CapitalEvidenceDecision determines what accounting NATURE the
//   item evidence supports. Keep the two separate.
//
//   Capital evidence remains PROBABILISTIC. Do NOT:
//     COMPLETE_ASSET + model + serial → automatically CAPITAL
//
//   Instead these are STRONG SUPPORTING signals toward
//   CAPITAL_CANDIDATE alongside:
//     - standalone functional completeness
//     - durable-use evidence
//     - replacement-of-whole-asset evidence
//     - construction / improvement context
//     - project / PO context
//     - contradictory component / repair evidence
//
//   Amendment #8: amount remains COMPLETELY PROHIBITED as evidence
//   of capital nature.

import type { PurchasedItemIdentity } from "./purchased-item-identity";
import type { ItemCompletenessResult, ItemCompleteness } from "./item-completeness";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type CapitalDecision =
  | "CAPITAL_CANDIDATE"
  | "OPERATING"
  | "REPAIR_MAINTENANCE"
  | "UNRESOLVED";

export interface CapitalEvidence {
  kind:
    | "complete_asset_with_model_serial"
    | "complete_asset_without_identifier"
    | "component_replacement"
    | "consumable_purchase"
    | "service_purchase"
    | "engine_or_assembly_body_word"
    | "seat_or_accessory_body_word"
    | "multiple_component_lines"
    | "single_high_completeness_item"
    | "construction_or_improvement_context"
    | "project_or_po_context"
    | "durable_use_indicator"
    | "no_functional_evidence"
    | "conflicting_completeness_between_items";
  detail: string;
  strength: "strong" | "medium" | "weak";
}

export interface CapitalEvidenceDecisionResult {
  decision: CapitalDecision;
  confidence: number;
  durableAssetEvidence: CapitalEvidence[];
  operatingEvidence: CapitalEvidence[];
  contradictions: CapitalEvidence[];
  diagnostic: string;
}

export interface CapitalEvidenceInput {
  items: PurchasedItemIdentity[];
  itemCompleteness: Map<number, ItemCompletenessResult>;   // keyed by sourceLineItemIndex
  /** Optional PO / requestor / project context text — checked for
   *  capital-project keywords. May be empty. */
  poRequestorText?: string | null;
  /** Optional supplier context (used only as WEAK signal). */
  supplierName?: string | null;
}

// -----------------------------------------------------------------------------
// Vocabularies (limited — every rule is generic)
// -----------------------------------------------------------------------------

const CONSTRUCTION_IMPROVEMENT_RE =
  /\b(construction|constructed|improvement|renovation|renovate|expansion|expand|build[-\s]?out|capital\s+project|capital\s+improvement)\b/i;

const DURABLE_USE_RE =
  /\b(?:useful\s+life|multi[-\s]?year|long[-\s]?term|permanent\s+install|fixed\s+installation)\b/i;

const PROJECT_PO_RE =
  /\b(?:project\s*(?:#|no\.?|number)|capital\s+project|asset\s+register)\b/i;

// -----------------------------------------------------------------------------
// Scoring weights
// -----------------------------------------------------------------------------

const W_COMPLETE_ASSET_WITH_IDENTIFIER = 30;
const W_COMPLETE_ASSET_ONLY = 15;
const W_CONSTRUCTION_IMPROVEMENT = 20;
const W_DURABLE_USE = 12;
const W_PROJECT_PO = 12;

const W_COMPONENT_STRONG = 25;
const W_CONSUMABLE_STRONG = 25;
const W_SERVICE_STRONG = 20;
const W_MULTIPLE_COMPONENTS = 12;   // bonus per additional component line

const COMMIT_MIN_CONFIDENCE = 40;

// -----------------------------------------------------------------------------
// Decision
// -----------------------------------------------------------------------------

export function evaluateCapitalEvidence(input: CapitalEvidenceInput): CapitalEvidenceDecisionResult {
  const durable: CapitalEvidence[] = [];
  const operating: CapitalEvidence[] = [];
  const contradictions: CapitalEvidence[] = [];

  let capitalScore = 0;
  let operatingScore = 0;
  let repairMaintenanceScore = 0;

  // Segment items by completeness.
  const completenessBuckets: Record<ItemCompleteness, PurchasedItemIdentity[]> = {
    COMPLETE_ASSET: [], COMPONENT: [], CONSUMABLE: [], SERVICE: [], UNKNOWN: [],
  };
  for (const item of input.items) {
    const c = input.itemCompleteness.get(item.sourceLineItemIndex);
    const bucket = c?.completeness ?? "UNKNOWN";
    completenessBuckets[bucket].push(item);
  }

  // (a) COMPLETE_ASSET items with model/serial (or SKU) → strong
  // CAPITAL_CANDIDATE evidence. Without identifier → medium.
  for (const item of completenessBuckets.COMPLETE_ASSET) {
    if (item.model || item.serialNumber || item.sku) {
      capitalScore += W_COMPLETE_ASSET_WITH_IDENTIFIER;
      durable.push({
        kind: "complete_asset_with_model_serial",
        detail: `"${item.description.slice(0, 60)}" model=${item.model} sku=${item.sku} serial=${item.serialNumber}`,
        strength: "strong",
      });
    } else {
      capitalScore += W_COMPLETE_ASSET_ONLY;
      durable.push({
        kind: "complete_asset_without_identifier",
        detail: `"${item.description.slice(0, 60)}"`,
        strength: "medium",
      });
    }
  }

  // (b) COMPONENT items → REPAIR_MAINTENANCE evidence.
  for (const item of completenessBuckets.COMPONENT) {
    repairMaintenanceScore += W_COMPONENT_STRONG;
    operating.push({
      kind: "component_replacement",
      detail: `"${item.description.slice(0, 60)}"`,
      strength: "strong",
    });
    // Amendment #5 explicit: engine/assembly body word contradicts
    // capital classification even when model/serial is present.
    const c = input.itemCompleteness.get(item.sourceLineItemIndex);
    const engineHit = c?.supporting.some((e) => e.kind === "engine_or_assembly_body_word");
    if (engineHit) {
      contradictions.push({
        kind: "engine_or_assembly_body_word",
        detail: `"${item.description.slice(0, 60)}" — engine/assembly body word suggests component replacement not standalone asset`,
        strength: "strong",
      });
    }
    const seatHit = c?.supporting.some((e) => e.kind === "seat_or_accessory_body_word");
    if (seatHit) {
      contradictions.push({
        kind: "seat_or_accessory_body_word",
        detail: `"${item.description.slice(0, 60)}" — seat/accessory body word suggests component/accessory replacement`,
        strength: "medium",
      });
    }
  }
  if (completenessBuckets.COMPONENT.length >= 2) {
    repairMaintenanceScore += W_MULTIPLE_COMPONENTS * (completenessBuckets.COMPONENT.length - 1);
    operating.push({
      kind: "multiple_component_lines",
      detail: `${completenessBuckets.COMPONENT.length} component lines`,
      strength: "medium",
    });
  }

  // (c) CONSUMABLE items → OPERATING.
  for (const item of completenessBuckets.CONSUMABLE) {
    operatingScore += W_CONSUMABLE_STRONG;
    operating.push({
      kind: "consumable_purchase",
      detail: `"${item.description.slice(0, 60)}"`,
      strength: "strong",
    });
  }

  // (d) SERVICE items → OPERATING / REPAIR_MAINTENANCE (repair
  // services lean R&M).
  for (const item of completenessBuckets.SERVICE) {
    const isRepairService = /\b(?:repair|maintenance)\b/i.test(item.description);
    if (isRepairService) {
      repairMaintenanceScore += W_SERVICE_STRONG;
    } else {
      operatingScore += W_SERVICE_STRONG;
    }
    operating.push({
      kind: "service_purchase",
      detail: `"${item.description.slice(0, 60)}"`,
      strength: "strong",
    });
  }

  // (e) Construction / improvement context (from any item's description).
  for (const item of input.items) {
    if (CONSTRUCTION_IMPROVEMENT_RE.test(item.description)) {
      capitalScore += W_CONSTRUCTION_IMPROVEMENT;
      durable.push({
        kind: "construction_or_improvement_context",
        detail: `"${item.description.slice(0, 60)}"`,
        strength: "medium",
      });
      break;
    }
  }
  if (input.poRequestorText && PROJECT_PO_RE.test(input.poRequestorText)) {
    capitalScore += W_PROJECT_PO;
    durable.push({
      kind: "project_or_po_context",
      detail: input.poRequestorText.slice(0, 80),
      strength: "medium",
    });
  }
  if (input.poRequestorText && DURABLE_USE_RE.test(input.poRequestorText)) {
    capitalScore += W_DURABLE_USE;
    durable.push({
      kind: "durable_use_indicator",
      detail: input.poRequestorText.slice(0, 80),
      strength: "weak",
    });
  }

  // (f) Amendment #8: amount is NOT evidence — do not sum extensions
  // and do not multiply by count. Every score above is a purchased-
  // item-substance signal only.

  // No functional evidence at all.
  if (input.items.length === 0 || (capitalScore === 0 && operatingScore === 0 && repairMaintenanceScore === 0)) {
    return {
      decision: "UNRESOLVED",
      confidence: 0,
      durableAssetEvidence: durable,
      operatingEvidence: operating,
      contradictions: [{ kind: "no_functional_evidence", detail: "no functional vocabulary hit on any item", strength: "medium" }],
      diagnostic: `no functional evidence; items=${input.items.length}`,
    };
  }

  // Rank the three states. Contradictions on capital lower its
  // effective score.
  const capitalContradictionPenalty = contradictions.filter((c) => c.strength === "strong").length * 15
    + contradictions.filter((c) => c.strength === "medium").length * 8;
  const effectiveCapital = Math.max(0, capitalScore - capitalContradictionPenalty);
  const ranked: Array<[CapitalDecision, number]> = [
    ["CAPITAL_CANDIDATE", effectiveCapital],
    ["REPAIR_MAINTENANCE", repairMaintenanceScore],
    ["OPERATING", operatingScore],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const [, secondScore] = ranked[1];
  const gap = topScore - secondScore;

  let decision: CapitalDecision;
  let confidence: number;
  if (topScore < COMMIT_MIN_CONFIDENCE) {
    decision = "UNRESOLVED";
    confidence = Math.min(50, topScore);
  } else if (gap < 10) {
    decision = "UNRESOLVED";
    confidence = Math.min(60, topScore);
  } else {
    decision = top;
    confidence = Math.min(95, Math.round(topScore + Math.min(5, gap)));
  }

  return {
    decision,
    confidence,
    durableAssetEvidence: durable,
    operatingEvidence: operating,
    contradictions,
    diagnostic: `capital=${effectiveCapital}(raw=${capitalScore},penalty=${capitalContradictionPenalty}) rm=${repairMaintenanceScore} op=${operatingScore} → ${decision}(${confidence})`,
  };
}
