// Sprint 3 · Phase 4 Slice 5 (2026-08-07) — economic-purpose
// taxonomy + provider interface.
//
// Founder rule §14-§18:
//   - Purpose evidence comes primarily from purchased goods/services
//     (canonical line items).
//   - Supplier context / historical vendor coding / email context are
//     supporting evidence only.
//   - Every conclusion cites supporting line-item evidence.
//   - The classifier must reason about concepts, not exact keywords
//     ("diesel", "gasoline", "fuel", "dyed" all support FUEL).
//
// This module is Option A: deterministic taxonomy + curated lexicon,
// implemented behind an EconomicPurposeProvider interface so a local
// embedding model can be evaluated later without rebuilding
// downstream accounting intelligence.

import type { CanonicalLineItem } from "./evidence/canonical-line-item";

// -----------------------------------------------------------------------------
// Taxonomy — provider-neutral. Not tied to any tenant's COA.
// -----------------------------------------------------------------------------

export type EconomicPurposeConcept =
  | "FUEL"
  | "LUBRICANTS"
  | "EQUIPMENT"
  | "EQUIPMENT_PARTS"
  | "REPAIR_MAINTENANCE"
  | "TELECOMMUNICATIONS"
  | "INTERNET_CONNECTIVITY"
  | "SOFTWARE_SUBSCRIPTION"
  | "PROFESSIONAL_MEMBERSHIP"
  | "PROFESSIONAL_SERVICES"
  | "FOOD"
  | "BEVERAGE"
  | "FREIGHT_DELIVERY"
  | "CAPITAL_EQUIPMENT"
  | "BUILDING_MAINTENANCE"
  | "COURSE_MAINTENANCE"
  | "OFFICE_SUPPLIES"
  | "INTEREST"
  | "PENALTY"
  | "OTHER"
  | "UNKNOWN";

// -----------------------------------------------------------------------------
// Concept-family lexicons — GENERIC. No supplier / SKU / filename
// literals. Cue phrasing drawn from common accounting practice, not
// from any single tenant's vendor list.
// -----------------------------------------------------------------------------

interface ConceptDefinition {
  concept: EconomicPurposeConcept;
  cues: RegExp[];
  contradictions?: RegExp[];
  /** Strength floor for a cue match (0..100). */
  cueStrength: number;
  /** Human-readable label for diagnostics. */
  label: string;
}

const CONCEPTS: ConceptDefinition[] = [
  {
    concept: "FUEL",
    label: "Fuel / petroleum product",
    cues: [
      /\b(diesel|gasoline|gas(oline)?|petrol|petroleum|motor\s*fuel|dyed(?:\s+fuel)?|fuel(?:\s+oil)?|jet\s*fuel|marine\s*fuel|kerosene|ethanol)\b/i,
      /\bLS\s*Dyed\b/i,
      /\bunleaded\b/i,
    ],
    cueStrength: 82,
  },
  {
    concept: "LUBRICANTS",
    label: "Lubricants / oils",
    cues: [
      /\b(engine\s*oil|hydraulic\s*(?:oil|fluid)|gear\s*oil|grease|lubricant|motor\s*oil|transmission\s*fluid|coolant|antifreeze|def\s*fluid|diesel\s*exhaust\s*fluid)\b/i,
    ],
    cueStrength: 78,
  },
  {
    concept: "EQUIPMENT_PARTS",
    label: "Equipment parts / consumables",
    cues: [
      /\b(bearing|seal|spacer|belt|filter|blade|reel|bedknife|spring|bolt|nut|washer|gasket|hose|fitting|valve|switch|solenoid|sensor|spark\s*plug|tire|tyre|tube|rim|battery|alternator|starter|clutch|brake\s*pad|rotor|caliper|kit|replacement\s*part|hardware|wheel|axle|shaft|pulley|sprocket|chain|cable|wire|fuse|relay|coil|element|nozzle|piston|ring)s?\b/i,
    ],
    cueStrength: 72,
  },
  {
    concept: "REPAIR_MAINTENANCE",
    label: "Repair / maintenance service",
    cues: [
      /\b(repair|service|maintenance|labor|labour|installation|install|removal|remove|clean(?:ing)?|inspect(?:ion)?|adjust(?:ment)?|calibrat(?:e|ion)|tune[-\s]?up|overhaul|rebuild|refurbish|replace(?:ment)?\s+service)\b/i,
    ],
    contradictions: [
      /\bcapital\s+(?:project|expenditure|improvement)\b/i,
    ],
    cueStrength: 68,
  },
  {
    concept: "TELECOMMUNICATIONS",
    label: "Telecommunications service",
    cues: [
      /\b(telephone|phone\s*line|voip|long\s*distance|toll\s*free|mobile\s*(?:plan|service)|cellular|sim\s*card|calling\s*plan|voice\s*service)\b/i,
    ],
    cueStrength: 78,
  },
  {
    concept: "INTERNET_CONNECTIVITY",
    label: "Internet / connectivity",
    cues: [
      /\b(internet|broadband|fiber\s*optic|dsl|wifi|wi[-\s]?fi|bandwidth|circuit|mbit\/?s|mbps|gbps|isp\s*service|network\s*connectivity|ethernet\s*service)\b/i,
    ],
    cueStrength: 80,
  },
  {
    concept: "SOFTWARE_SUBSCRIPTION",
    label: "Software / SaaS subscription",
    cues: [
      /\b(software\s*(?:licen[cs]e|subscription)|saas|user\s*licen[cs]e|seat\s*licen[cs]e|annual\s*subscription|cloud\s*service|monthly\s*subscription|renewal\s*—?\s*software)\b/i,
    ],
    cueStrength: 78,
  },
  {
    concept: "PROFESSIONAL_MEMBERSHIP",
    label: "Professional membership dues",
    cues: [
      /\b(member(?:ship)?\s*(?:dues|fee)|annual\s*dues|professional\s*dues|association\s*dues|chapter\s*dues|CPA\s*(?:Alberta|Canada|BC|Ontario|Manitoba|Saskatchewan|Quebec|Nova\s*Scotia|New\s*Brunswick|PEI|Yukon|Newfoundland)\s*Fee)\b/i,
    ],
    cueStrength: 82,
  },
  {
    concept: "PROFESSIONAL_SERVICES",
    label: "Professional / advisory services",
    cues: [
      /\b(consulting|audit|advisory|legal|accountant|accounting\s*service|tax\s*preparation|tax\s*service|bookkeeping|payroll\s*service|engineer(?:ing)?\s*service|architect(?:ural)?\s*service)\b/i,
    ],
    contradictions: [
      /\b(member(?:ship)?\s*(?:dues|fee))\b/i,
    ],
    cueStrength: 72,
  },
  {
    concept: "FOOD",
    label: "Food purchases",
    cues: [
      /\b(produce|meat|poultry|beef|pork|chicken|seafood|fish|bakery|dairy|eggs?|vegetables?|fruit|frozen\s*food|prepared\s*food|dry\s*goods|grocery|catering\s*food)\b/i,
    ],
    cueStrength: 70,
  },
  {
    concept: "BEVERAGE",
    label: "Beverage purchases",
    cues: [
      /\b(beverage|beer|wine|spirits|liquor|whisky|whiskey|vodka|gin|rum|tequila|soda|juice|water|coffee\s*beans?|tea)\b/i,
    ],
    cueStrength: 70,
  },
  {
    concept: "FREIGHT_DELIVERY",
    label: "Freight / delivery",
    cues: [
      /\b(freight|shipping|delivery|carriage|transport|courier|freight\s*charge)\b/i,
    ],
    cueStrength: 65,
  },
  {
    concept: "CAPITAL_EQUIPMENT",
    label: "Capital equipment",
    cues: [
      /\b(mower|tractor|utility\s*vehicle|golf\s*cart|aerator|topdresser|sprayer|blower|rake|greensmower|walking\s*mower|fairway\s*mower|rough\s*mower|hvac\s*unit|compressor|generator|forklift|new\s*equipment)\b/i,
    ],
    cueStrength: 70,
  },
  {
    concept: "BUILDING_MAINTENANCE",
    label: "Building maintenance",
    cues: [
      /\b(plumbing|electrical\s*repair|hvac\s*(?:service|repair|maintenance)|painting|roofing|drywall|carpentry|flooring|janitorial|cleaning\s*service|window\s*(?:cleaning|washing)|pest\s*control|snow\s*removal)\b/i,
    ],
    cueStrength: 68,
  },
  {
    concept: "COURSE_MAINTENANCE",
    label: "Course maintenance",
    cues: [
      /\b(fertilizer|fertilise|fertilize|seed|sod|turf|top\s*dressing|dressing\s*sand|pesticide|herbicide|fungicide|insecticide|irrigation\s*(?:parts?|repair|service)|greens\s*sand|bunker\s*sand|divot\s*mix)\b/i,
    ],
    cueStrength: 74,
  },
  {
    concept: "OFFICE_SUPPLIES",
    label: "Office supplies",
    cues: [
      /\b(office\s*(?:supplies|supply)|toner|ink\s*cartridge|paper\s*ream|envelopes?|stationery|pens?|binders?|stapl(?:e|er))\b/i,
    ],
    cueStrength: 68,
  },
  {
    concept: "INTEREST",
    label: "Interest / finance charge",
    cues: [
      /\b(interest|finance\s*charge)\b/i,
    ],
    cueStrength: 78,
  },
  {
    concept: "PENALTY",
    label: "Penalty / late fee",
    cues: [
      /\b(penalty|late\s*fee|late\s*payment|nsf|returned\s*cheque|dishonour)\b/i,
    ],
    cueStrength: 78,
  },
];

// -----------------------------------------------------------------------------
// Provider interface
// -----------------------------------------------------------------------------

export interface PurposeEvidenceCite {
  lineItemIndex?: number;
  lineItemDescription?: string;
  cue: string;
  strength: "strong" | "medium" | "weak";
  reason: string;
}

export interface PurposeClassification {
  concept: EconomicPurposeConcept;
  label: string;
  confidence: number;
  supporting: PurposeEvidenceCite[];
  contradictions: PurposeEvidenceCite[];
}

export interface EconomicPurposeContext {
  supplierName?: string | null;
  fullDocumentText?: string | null;
}

export interface EconomicPurposeProvider {
  readonly kind: string;
  classify(
    lineItems: CanonicalLineItem[],
    ctx: EconomicPurposeContext,
  ): PurposeClassification[];
}

// -----------------------------------------------------------------------------
// Deterministic taxonomy provider (Option A)
// -----------------------------------------------------------------------------

export class DeterministicTaxonomyProvider implements EconomicPurposeProvider {
  readonly kind = "deterministic_taxonomy_v1";

  classify(
    lineItems: CanonicalLineItem[],
    ctx: EconomicPurposeContext,
  ): PurposeClassification[] {
    // Sprint 3 · Phase 4 Slice 5.3 (2026-08-08, amendment #9) —
    // fix taxonomy contamination by scoping primary-purpose
    // classification to PRIMARY_PURCHASE lines only. Auxiliary rows
    // (SURCHARGE / FREIGHT / TAX / SUMMARY_ROW_REJECTED / CREDIT /
    // DISCOUNT / INTEREST / PENALTY) do NOT determine the primary
    // economic purpose when substantive PRIMARY_PURCHASE rows exist.
    //
    // This fixes the "Alberta Tire Levy ADF" SURCHARGE leaking
    // "tire" vocabulary into EQUIPMENT_PARTS classification for
    // invoices whose real primary purchase is a mower engine.
    const primaryLines = lineItems.filter((li) => li.role === "PRIMARY_PURCHASE");
    // If NO PRIMARY_PURCHASE lines exist at all, widen to auxiliary
    // roles so a document with only a service/surcharge description
    // still gets some classification signal — but SURCHARGE tokens
    // never determine the primary concept when a primary line exists.
    const pool = primaryLines.length > 0
      ? primaryLines
      : lineItems.filter((li) => li.role !== "TAX" && li.role !== "SUMMARY_ROW_REJECTED");

    const scores = new Map<EconomicPurposeConcept, {
      score: number;
      supporting: PurposeEvidenceCite[];
      contradictions: PurposeEvidenceCite[];
    }>();

    const record = (c: EconomicPurposeConcept, delta: number, cite: PurposeEvidenceCite, isContra: boolean) => {
      const cur = scores.get(c) ?? { score: 0, supporting: [], contradictions: [] };
      cur.score += delta;
      (isContra ? cur.contradictions : cur.supporting).push(cite);
      scores.set(c, cur);
    };

    // STRONG: line-item descriptions.
    pool.forEach((li, idx) => {
      const desc = li.description;
      for (const def of CONCEPTS) {
        for (const cue of def.cues) {
          if (cue.test(desc)) {
            record(def.concept, def.cueStrength, {
              lineItemIndex: idx,
              lineItemDescription: desc.slice(0, 80),
              cue: cue.source,
              strength: "strong",
              reason: `line-item description matches ${def.label} concept`,
            }, false);
          }
        }
        if (def.contradictions) {
          for (const cue of def.contradictions) {
            if (cue.test(desc)) {
              record(def.concept, -Math.round(def.cueStrength * 0.4), {
                lineItemIndex: idx,
                lineItemDescription: desc.slice(0, 80),
                cue: cue.source,
                strength: "strong",
                reason: `line-item description contradicts ${def.label}`,
              }, true);
            }
          }
        }
      }
    });

    // MEDIUM: full-document text (only when a line-item hit is
    // already present — never as sole evidence).
    const text = (ctx.fullDocumentText ?? "").slice(0, 8000);
    if (text) {
      for (const def of CONCEPTS) {
        const existing = scores.get(def.concept);
        if (!existing) continue; // don't originate from doc text alone
        for (const cue of def.cues) {
          if (cue.test(text)) {
            record(def.concept, Math.round(def.cueStrength * 0.35), {
              cue: cue.source,
              strength: "medium",
              reason: `document text reinforces ${def.label}`,
            }, false);
          }
        }
      }
    }

    // WEAK: supplier-name hint (only reinforces existing concept).
    const supplier = (ctx.supplierName ?? "").slice(0, 120);
    if (supplier) {
      for (const def of CONCEPTS) {
        const existing = scores.get(def.concept);
        if (!existing) continue;
        for (const cue of def.cues) {
          if (cue.test(supplier)) {
            record(def.concept, Math.round(def.cueStrength * 0.15), {
              cue: cue.source,
              strength: "weak",
              reason: `supplier name contains cue for ${def.label}`,
            }, false);
          }
        }
      }
    }

    // Build ranked results.
    const ranked: PurposeClassification[] = [];
    for (const [concept, s] of scores.entries()) {
      const def = CONCEPTS.find((c) => c.concept === concept)!;
      ranked.push({
        concept,
        label: def.label,
        // Cap confidence at 96 for deterministic-cue classification
        // (leaves head-room for future embedding provider boosts).
        confidence: Math.max(0, Math.min(96, s.score)),
        supporting: s.supporting,
        contradictions: s.contradictions,
      });
    }
    ranked.sort((a, b) => b.confidence - a.confidence);
    if (ranked.length === 0) {
      ranked.push({
        concept: "UNKNOWN",
        label: "Unknown — no line-item cue matched",
        confidence: 0,
        supporting: [],
        contradictions: [],
      });
    }
    return ranked;
  }
}

// -----------------------------------------------------------------------------
// Default provider (Slice 5 baseline)
// -----------------------------------------------------------------------------

let _defaultProvider: EconomicPurposeProvider = new DeterministicTaxonomyProvider();
export function getEconomicPurposeProvider(): EconomicPurposeProvider {
  return _defaultProvider;
}
/** Test/DI override — used by future embedding provider evaluation. */
export function setEconomicPurposeProvider(p: EconomicPurposeProvider): void {
  _defaultProvider = p;
}
export function resetEconomicPurposeProvider(): void {
  _defaultProvider = new DeterministicTaxonomyProvider();
}
