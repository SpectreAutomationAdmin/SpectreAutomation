// Sprint 3 · Phase 4 Slice 5.3 completion pass (2026-08-08) —
// capital-vs-operating decision.
//
// Founder amendments (completion pass §9–§14):
//   • Consume PurchasedObjectIdentity[] and object relationships —
//     NOT flat descriptions.
//   • "engine" is evidence, not a verdict. Treat COMPONENT vocabulary
//     as one signal among several.
//   • Zero-dollar bundled accessory of a higher-value primary object
//     is contextual evidence for a COMPLETE_MACHINE interpretation.
//   • Amount remains COMPLETELY PROHIBITED as capital evidence (§8
//     of prior slice, §25 of completion pass).
//   • UNRESOLVED remains the honest default when evidence is
//     genuinely ambiguous (§20 + §31 Outcome B).
//
// Legacy CapitalEvidenceInput remains supported for callers still on
// PurchasedItemIdentity. The completion-pass caller supplies
// PurchasedObjectIdentity[] which carries richer object-role +
// relationship information.

import type { PurchasedItemIdentity } from "./purchased-item-identity";
import type { ItemCompletenessResult, ItemCompleteness } from "./item-completeness";
import type { PurchasedObjectIdentity } from "./purchased-object-identity";

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
    | "complete_machine_with_identifier"
    | "complete_machine_without_identifier"
    | "serialized_component"
    | "component_replacement"
    | "consumable_purchase"
    | "service_purchase"
    | "accessory_bundled_zero_cost"
    | "assembly_body_word_ambiguous"
    | "seat_or_accessory_body_word"
    | "multiple_component_lines"
    | "construction_or_improvement_context"
    | "project_or_po_context"
    | "durable_use_indicator"
    | "no_functional_evidence"
    | "conflicting_completeness_between_items"
    | "replacement_language";
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

// ---- Legacy input (kept for prior test / call sites) ----
export interface CapitalEvidenceInput {
  items: PurchasedItemIdentity[];
  itemCompleteness: Map<number, ItemCompletenessResult>;
  poRequestorText?: string | null;
  supplierName?: string | null;
}

// ---- New object-aware input ----
export interface CapitalObjectEvidenceInput {
  objects: PurchasedObjectIdentity[];
  poRequestorText?: string | null;
  supplierName?: string | null;
}

// -----------------------------------------------------------------------------
// Vocabularies
// -----------------------------------------------------------------------------

const CONSTRUCTION_IMPROVEMENT_RE =
  /\b(construction|constructed|improvement|renovation|renovate|expansion|expand|build[-\s]?out|capital\s+project|capital\s+improvement)\b/i;
const DURABLE_USE_RE =
  /\b(?:useful\s+life|multi[-\s]?year|long[-\s]?term|permanent\s+install|fixed\s+installation)\b/i;
const PROJECT_PO_RE =
  /\b(?:project\s*(?:#|no\.?|number)|capital\s+project|asset\s+register)\b/i;

// -----------------------------------------------------------------------------
// Weights — object-aware branch (completion pass)
// -----------------------------------------------------------------------------

const W_COMPLETE_MACHINE_STRONG = 26;       // COMPLETE_MACHINE with model+serial
const W_COMPLETE_MACHINE = 18;
const W_SERIALIZED_COMPONENT_CAPITAL = 12;  // serialized component ambiguous
const W_SERIALIZED_COMPONENT_RM = 15;

const W_COMPONENT_STRONG = 22;
const W_ACCESSORY_ZERO_BUNDLED_CAPITAL = 12; // §13: zero-cost bundled accessory
                                              // supports complete-machine reading
const W_CONSUMABLE_STRONG = 25;
const W_SERVICE_STRONG = 20;
const W_MULTIPLE_COMPONENTS = 10;
const W_ASSEMBLY_AMBIGUOUS = 6;              // engine / motor / pump — weak both ways
const W_REPLACEMENT_LANGUAGE = 18;
const W_CONSTRUCTION_IMPROVEMENT = 20;
const W_PROJECT_PO = 12;
const W_DURABLE_USE = 8;

const COMMIT_MIN_CONFIDENCE = 40;
const GAP_MIN = 12;

// -----------------------------------------------------------------------------
// Object-aware decision (completion-pass primary)
// -----------------------------------------------------------------------------

export function evaluateCapitalObjectEvidence(
  input: CapitalObjectEvidenceInput,
): CapitalEvidenceDecisionResult {
  const durable: CapitalEvidence[] = [];
  const operating: CapitalEvidence[] = [];
  const contradictions: CapitalEvidence[] = [];
  let capital = 0;
  let operatingScore = 0;
  let rm = 0;

  if (input.objects.length === 0) {
    return {
      decision: "UNRESOLVED",
      confidence: 0,
      durableAssetEvidence: durable,
      operatingEvidence: operating,
      contradictions: [{
        kind: "no_functional_evidence",
        detail: "no purchased objects surfaced",
        strength: "medium",
      }],
      diagnostic: "no objects — UNRESOLVED",
    };
  }

  let componentLines = 0;
  for (const obj of input.objects) {
    const hasIdentifier = obj.serialCandidates.length > 0 || obj.modelCandidates.length > 0 || obj.skuCandidates.length > 0;

    switch (obj.objectRole) {
      case "COMPLETE_MACHINE": {
        if (hasIdentifier) {
          capital += W_COMPLETE_MACHINE_STRONG;
          durable.push({
            kind: "complete_machine_with_identifier",
            detail: `"${obj.description.slice(0, 60)}" model=${obj.modelCandidates[0]?.value ?? "-"} serial=${obj.serialCandidates[0]?.value ?? "-"}`,
            strength: "strong",
          });
        } else {
          capital += W_COMPLETE_MACHINE;
          durable.push({
            kind: "complete_machine_without_identifier",
            detail: `"${obj.description.slice(0, 60)}"`,
            strength: "medium",
          });
        }
        break;
      }
      case "SERIALIZED_COMPONENT": {
        // §12 completion pass: SERIALIZED_COMPONENT is ambiguous.
        // Contributes weakly to BOTH branches. Contextual evidence
        // (replacement language / capital-project context) tips the
        // balance.
        capital += W_SERIALIZED_COMPONENT_CAPITAL;
        rm += W_SERIALIZED_COMPONENT_RM;
        durable.push({
          kind: "serialized_component",
          detail: `"${obj.description.slice(0, 60)}" serial=${obj.serialCandidates[0]?.value ?? "-"} — ambiguous`,
          strength: "medium",
        });
        break;
      }
      case "COMPONENT": {
        rm += W_COMPONENT_STRONG;
        componentLines++;
        operating.push({
          kind: "component_replacement",
          detail: `"${obj.description.slice(0, 60)}"`,
          strength: "strong",
        });
        break;
      }
      case "ACCESSORY": {
        // §13 completion pass: zero-cost accessory bundled with a
        // higher-value primary object supports COMPLETE_MACHINE
        // reading; paid accessory or standalone accessory does not.
        const bundled = obj.relatedObjects.find((r) => r.kind === "BUNDLED_WITH");
        if (bundled && (obj.extension === 0 || obj.extension == null)) {
          capital += W_ACCESSORY_ZERO_BUNDLED_CAPITAL;
          durable.push({
            kind: "accessory_bundled_zero_cost",
            detail: `"${obj.description.slice(0, 60)}" zero-cost accessory bundled with row #${bundled.targetIndex}`,
            strength: "medium",
          });
        }
        // Non-zero-cost accessory is treated neutrally by capital
        // reasoning here.
        break;
      }
      case "CONSUMABLE": {
        operatingScore += W_CONSUMABLE_STRONG;
        operating.push({
          kind: "consumable_purchase",
          detail: `"${obj.description.slice(0, 60)}"`,
          strength: "strong",
        });
        break;
      }
      case "SERVICE": {
        const isRepairService = /\b(?:repair|maintenance)\b/i.test(obj.description);
        if (isRepairService) rm += W_SERVICE_STRONG;
        else operatingScore += W_SERVICE_STRONG;
        operating.push({
          kind: "service_purchase",
          detail: `"${obj.description.slice(0, 60)}"`,
          strength: "strong",
        });
        break;
      }
      case "UNKNOWN": {
        // §9 completion pass: engine / assembly body word — contribute
        // small ambiguous weight, do NOT decide.
        const hasAssemblyEvidence = obj.objectRoleEvidence.some((e) =>
          e.kind === "engine_or_assembly_body_word" || e.kind === "component_vocab",
        );
        const hasMachineEvidence = obj.objectRoleEvidence.some((e) =>
          e.kind === "complete_machine_vocab" || e.kind === "model_and_brand_present",
        );
        if (hasAssemblyEvidence && hasMachineEvidence) {
          capital += W_ASSEMBLY_AMBIGUOUS;
          rm += W_ASSEMBLY_AMBIGUOUS;
          contradictions.push({
            kind: "assembly_body_word_ambiguous",
            detail: `"${obj.description.slice(0, 60)}" — evidence supports both COMPLETE_MACHINE and COMPONENT`,
            strength: "medium",
          });
        }
        break;
      }
    }

    // Replacement language — additional evidence for RM.
    const replacementHit = obj.objectRoleEvidence.some((e) => e.kind === "replacement_language");
    if (replacementHit) {
      rm += W_REPLACEMENT_LANGUAGE;
      operating.push({
        kind: "replacement_language",
        detail: `"${obj.description.slice(0, 60)}"`,
        strength: "strong",
      });
    }
  }

  if (componentLines >= 2) {
    rm += W_MULTIPLE_COMPONENTS * (componentLines - 1);
    operating.push({
      kind: "multiple_component_lines",
      detail: `${componentLines} component lines`,
      strength: "medium",
    });
  }

  // PO / project context.
  if (input.poRequestorText) {
    if (CONSTRUCTION_IMPROVEMENT_RE.test(input.poRequestorText)) {
      capital += W_CONSTRUCTION_IMPROVEMENT;
      durable.push({
        kind: "construction_or_improvement_context",
        detail: input.poRequestorText.slice(0, 80),
        strength: "medium",
      });
    }
    if (PROJECT_PO_RE.test(input.poRequestorText)) {
      capital += W_PROJECT_PO;
      durable.push({
        kind: "project_or_po_context",
        detail: input.poRequestorText.slice(0, 80),
        strength: "medium",
      });
    }
    if (DURABLE_USE_RE.test(input.poRequestorText)) {
      capital += W_DURABLE_USE;
      durable.push({
        kind: "durable_use_indicator",
        detail: input.poRequestorText.slice(0, 80),
        strength: "weak",
      });
    }
  }

  const ranked: Array<[CapitalDecision, number]> = [
    ["CAPITAL_CANDIDATE", capital],
    ["REPAIR_MAINTENANCE", rm],
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
  } else if (gap < GAP_MIN) {
    // §31 Outcome B: when both branches are well-supported, honestly
    // abstain.
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
    diagnostic: `capital=${capital} rm=${rm} op=${operatingScore} gap=${gap} → ${decision}(${confidence})`,
  };
}

// -----------------------------------------------------------------------------
// Legacy PurchasedItem-based decision (kept for existing unit tests)
// -----------------------------------------------------------------------------

const W_COMPLETE_ASSET_WITH_IDENTIFIER = 30;
const W_COMPLETE_ASSET_ONLY = 15;
const W_LEGACY_COMPONENT_STRONG = 25;
const W_LEGACY_CONSUMABLE_STRONG = 25;
const W_LEGACY_SERVICE_STRONG = 20;
const W_LEGACY_MULTIPLE_COMPONENTS = 12;

export function evaluateCapitalEvidence(input: CapitalEvidenceInput): CapitalEvidenceDecisionResult {
  const durable: CapitalEvidence[] = [];
  const operating: CapitalEvidence[] = [];
  const contradictions: CapitalEvidence[] = [];
  let capitalScore = 0;
  let operatingScore = 0;
  let repairMaintenanceScore = 0;

  const buckets: Record<ItemCompleteness, PurchasedItemIdentity[]> = {
    COMPLETE_ASSET: [], COMPONENT: [], CONSUMABLE: [], SERVICE: [], UNKNOWN: [],
  };
  for (const item of input.items) {
    const c = input.itemCompleteness.get(item.sourceLineItemIndex);
    const bucket = c?.completeness ?? "UNKNOWN";
    buckets[bucket].push(item);
  }

  for (const item of buckets.COMPLETE_ASSET) {
    if (item.model || item.serialNumber || item.sku) {
      capitalScore += W_COMPLETE_ASSET_WITH_IDENTIFIER;
      durable.push({
        kind: "complete_machine_with_identifier",
        detail: `"${item.description.slice(0, 60)}" model=${item.model} sku=${item.sku} serial=${item.serialNumber}`,
        strength: "strong",
      });
    } else {
      capitalScore += W_COMPLETE_ASSET_ONLY;
      durable.push({
        kind: "complete_machine_without_identifier",
        detail: `"${item.description.slice(0, 60)}"`,
        strength: "medium",
      });
    }
  }

  for (const item of buckets.COMPONENT) {
    repairMaintenanceScore += W_LEGACY_COMPONENT_STRONG;
    operating.push({
      kind: "component_replacement",
      detail: `"${item.description.slice(0, 60)}"`,
      strength: "strong",
    });
  }
  if (buckets.COMPONENT.length >= 2) {
    repairMaintenanceScore += W_LEGACY_MULTIPLE_COMPONENTS * (buckets.COMPONENT.length - 1);
    operating.push({
      kind: "multiple_component_lines",
      detail: `${buckets.COMPONENT.length} component lines`,
      strength: "medium",
    });
  }
  for (const item of buckets.CONSUMABLE) {
    operatingScore += W_LEGACY_CONSUMABLE_STRONG;
    operating.push({
      kind: "consumable_purchase",
      detail: `"${item.description.slice(0, 60)}"`,
      strength: "strong",
    });
  }
  for (const item of buckets.SERVICE) {
    const isRepair = /\b(?:repair|maintenance)\b/i.test(item.description);
    if (isRepair) repairMaintenanceScore += W_LEGACY_SERVICE_STRONG;
    else operatingScore += W_LEGACY_SERVICE_STRONG;
    operating.push({
      kind: "service_purchase",
      detail: `"${item.description.slice(0, 60)}"`,
      strength: "strong",
    });
  }
  if (input.poRequestorText) {
    if (CONSTRUCTION_IMPROVEMENT_RE.test(input.poRequestorText)) {
      capitalScore += 20;
      durable.push({ kind: "construction_or_improvement_context", detail: input.poRequestorText.slice(0, 80), strength: "medium" });
    }
    if (PROJECT_PO_RE.test(input.poRequestorText)) {
      capitalScore += 12;
      durable.push({ kind: "project_or_po_context", detail: input.poRequestorText.slice(0, 80), strength: "medium" });
    }
  }

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

  const ranked: Array<[CapitalDecision, number]> = [
    ["CAPITAL_CANDIDATE", capitalScore],
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
    diagnostic: `capital=${capitalScore} rm=${repairMaintenanceScore} op=${operatingScore} → ${decision}(${confidence})`,
  };
}
