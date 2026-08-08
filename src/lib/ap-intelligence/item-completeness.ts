// Sprint 3 · Phase 4 Slice 5.3 (2026-08-08) — item-completeness
// classifier.
//
// Founder amendment #5:
//   Use states: COMPLETE_ASSET / COMPONENT / CONSUMABLE / SERVICE /
//   UNKNOWN. Determine COMPLETE_ASSET from FUNCTIONAL substance —
//   NOT merely manufacturer/model/serial presence. A replacement
//   engine, transmission, control board, pump component, attachment
//   or assembly may have a model/serial number and STILL be a
//   COMPONENT.
//
//   The classifier asks: "Is the purchased item a standalone durable
//   asset capable of performing the intended operational function,
//   OR is it a component incorporated into / replacing part of an
//   existing asset?"

import type { PurchasedItemIdentity } from "./purchased-item-identity";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type ItemCompleteness =
  | "COMPLETE_ASSET"
  | "COMPONENT"
  | "CONSUMABLE"
  | "SERVICE"
  | "UNKNOWN";

export interface ItemCompletenessEvidence {
  kind:
    | "standalone_functional_unit_vocab"
    | "component_replacement_vocab"
    | "consumable_vocab"
    | "service_vocab"
    | "engine_or_assembly_body_word"
    | "seat_or_accessory_body_word"
    | "model_or_serial_present"
    | "no_functional_vocab";
  detail: string;
  strength: "strong" | "medium" | "weak";
}

export interface ItemCompletenessResult {
  completeness: ItemCompleteness;
  confidence: number;
  supporting: ItemCompletenessEvidence[];
  contradictions: ItemCompletenessEvidence[];
  diagnostic: string;
}

// -----------------------------------------------------------------------------
// Vocabularies — deliberately careful. Every vocabulary is a
// GENERIC noun list; no supplier / product-code / invoice literal.
// -----------------------------------------------------------------------------

/** Standalone durable equipment nouns — the item itself IS the
 *  functional unit. */
const COMPLETE_ASSET_VOCAB: RegExp[] = [
  /\b(?:mower|tractor|utility\s+vehicle|golf\s+cart|greensmower|walking\s+mower|fairway\s+mower|rough\s+mower|aerator|topdresser|sprayer|blower|verticutter|reel\s+mower|rotary\s+mower)\b/i,
  /\b(?:generator|compressor|forklift|skid\s*steer|loader|excavator|bulldozer|dumper|trailer)\b/i,
  /\b(?:hvac\s+unit|air\s+conditioner|furnace|boiler|chiller|heat\s+pump|dehumidifier)\b/i,
  /\b(?:dishwasher|oven|range|refrigerator|freezer|ice\s*machine|deep\s*fryer|combi\s*oven|walk[-\s]?in)\b/i,
  /\b(?:server|desktop|laptop|workstation|printer|photocopier|multifunction\s+device)\b/i,
  /\b(?:pump\s*station|irrigation\s*controller|control\s*system|complete\s+unit|complete\s+system|new\s+machine)\b/i,
];

/** Replacement-part / component nouns — the item is a subcomponent
 *  installed into an existing asset. These CONTRADICT COMPLETE_ASSET
 *  even when a model/serial is present. */
const COMPONENT_VOCAB: RegExp[] = [
  /\b(?:bearing|seal|spacer|belt|filter|blade|reel(?:\s+blade)?|bedknife|spring|bolt|nut|washer|gasket|hose|fitting|valve|switch|solenoid|sensor|spark\s*plug|tire|tyre|tube|rim|battery|alternator|starter|clutch|brake\s*(?:pad|disc|rotor|caliper))\b/i,
  /\b(?:part|parts|component|components|kit|assembly|asm|element|nozzle|piston|ring|rings|pulley|sprocket|chain|cable|wire|fuse|relay|coil)\b/i,
  /\b(?:replacement|repair\s+kit|service\s+kit|refurbish|rebuild|attachment|accessory|accessories|upgrade\s+kit)\b/i,
  /\b(?:seat|steering\s+wheel|windshield|mirror|light|lamp|bulb|dash|panel|cover|hood|door|handle|grip|deck)\b/i,
];

/** Engine / transmission / pump-body etc. — per §5 amendment these
 *  are COMPONENT even when they carry model/serial identifiers. */
const ENGINE_OR_ASSEMBLY_BODY_WORDS: RegExp[] = [
  /\b(?:engine|transmission|control\s+board|controller(?:\s+board)?|pump(?:\s+body)?|motor(?:\s+assembly)?|gearbox|hydraulic\s+pump|water\s+pump|fuel\s+pump)\b/i,
];

/** Consumable — fuel, chemicals, food, disposables. */
const CONSUMABLE_VOCAB: RegExp[] = [
  /\b(?:diesel|gasoline|gas(?:oline)?|petrol|fuel|petroleum|jet\s+fuel|marine\s+fuel|kerosene|ethanol|propane|natural\s+gas)\b/i,
  /\b(?:fertili(?:z|s)er|seed|sod|topdressing|pesticide|herbicide|fungicide|insecticide|chemical(?:s)?)\b/i,
  /\b(?:oil|grease|lubricant|coolant|antifreeze|hydraulic\s+fluid|def\s+fluid)\b/i,
  /\b(?:paper|napkin|towel|toilet\s+paper|cleaning\s+solution|detergent|soap)\b/i,
];

/** Service — labour, installation, inspection, etc. */
const SERVICE_VOCAB: RegExp[] = [
  /\b(?:labor|labour|service\s+call|installation|install|inspection|inspect|maintenance\s+call|tune[-\s]?up|repair\s+service|calibration)\b/i,
  /\b(?:consulting|advisory|audit\s+service|legal\s+service|accounting\s+service|design\s+service|training)\b/i,
];

// -----------------------------------------------------------------------------
// Scoring
// -----------------------------------------------------------------------------

const STRONG = 25;
const MEDIUM = 15;
const WEAK = 8;

/** Classify a single purchased item's completeness. */
export function classifyItemCompleteness(item: PurchasedItemIdentity): ItemCompletenessResult {
  const supporting: ItemCompletenessEvidence[] = [];
  const contradictions: ItemCompletenessEvidence[] = [];
  const scores: Record<ItemCompleteness, number> = {
    COMPLETE_ASSET: 0, COMPONENT: 0, CONSUMABLE: 0, SERVICE: 0, UNKNOWN: 0,
  };

  const desc = item.description;

  for (const re of SERVICE_VOCAB) {
    if (re.test(desc)) {
      scores.SERVICE += STRONG;
      supporting.push({ kind: "service_vocab", detail: re.source, strength: "strong" });
    }
  }
  for (const re of CONSUMABLE_VOCAB) {
    if (re.test(desc)) {
      scores.CONSUMABLE += STRONG;
      supporting.push({ kind: "consumable_vocab", detail: re.source, strength: "strong" });
    }
  }
  // §5 amendment: engine/assembly body words are COMPONENT signals
  // even when a complete-asset word is present.
  let engineBodyWordHit = false;
  for (const re of ENGINE_OR_ASSEMBLY_BODY_WORDS) {
    if (re.test(desc)) {
      scores.COMPONENT += STRONG;
      supporting.push({ kind: "engine_or_assembly_body_word", detail: re.source, strength: "strong" });
      engineBodyWordHit = true;
    }
  }
  for (const re of COMPONENT_VOCAB) {
    if (re.test(desc)) {
      scores.COMPONENT += MEDIUM;
      supporting.push({ kind: "component_replacement_vocab", detail: re.source, strength: "medium" });
    }
  }
  for (const re of COMPLETE_ASSET_VOCAB) {
    if (re.test(desc)) {
      if (engineBodyWordHit) {
        // Amendment #5: complete-asset vocab is CONTRADICTED when an
        // engine/assembly body word is also present. Reflect the
        // contradiction rather than the score.
        contradictions.push({
          kind: "standalone_functional_unit_vocab",
          detail: `matched ${re.source} but engine/assembly body word contradicts standalone-unit classification`,
          strength: "medium",
        });
        scores.COMPLETE_ASSET += WEAK;
      } else {
        scores.COMPLETE_ASSET += STRONG;
        supporting.push({ kind: "standalone_functional_unit_vocab", detail: re.source, strength: "strong" });
      }
    }
  }

  // Model / serial contributes to CONFIDENCE for whichever
  // classification wins, but does NOT drive COMPLETE_ASSET per §5.
  const hasModelOrSerial = item.model != null || item.serialNumber != null || item.sku != null;
  if (hasModelOrSerial) {
    supporting.push({
      kind: "model_or_serial_present",
      detail: `model=${item.model} serial=${item.serialNumber} sku=${item.sku}`,
      strength: "weak",
    });
  }

  // Seat / accessory body word — force COMPONENT (§5 explicit).
  if (/\b(seat|steering\s+wheel|attachment)\b/i.test(desc)) {
    scores.COMPONENT += STRONG;
    supporting.push({ kind: "seat_or_accessory_body_word", detail: "seat/steering/attachment", strength: "strong" });
  }

  // Rank + winner.
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]) as Array<[ItemCompleteness, number]>;
  const [topKey, topScore] = ranked[0];
  const [, secondScore] = ranked[1] ?? [null, 0];
  const gap = topScore - secondScore;
  // Require some evidence AND a meaningful gap for a confident call.
  let completeness: ItemCompleteness;
  let confidence: number;
  if (topScore < WEAK) {
    completeness = "UNKNOWN";
    confidence = 0;
    supporting.push({ kind: "no_functional_vocab", detail: "no vocabulary hit on description", strength: "weak" });
  } else if (gap < WEAK) {
    completeness = "UNKNOWN";
    confidence = Math.min(50, Math.round(topScore));
  } else {
    completeness = topKey;
    confidence = Math.min(95, Math.round(topScore + Math.min(5, gap)));
  }

  return {
    completeness,
    confidence,
    supporting,
    contradictions,
    diagnostic: `completeness=${completeness}(${confidence}) top=${topKey}(${topScore}) 2nd=${ranked[1]?.[0] ?? "-"}(${secondScore}) engineBody=${engineBodyWordHit}`,
  };
}
