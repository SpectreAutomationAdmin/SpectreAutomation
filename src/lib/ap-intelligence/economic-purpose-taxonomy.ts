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
  | "CYBERSECURITY_SERVICE"
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

// Exported for cue-coverage tests only. The classifier and its
// diagnostic API remain the public runtime surface. Internal call
// sites continue to reference `CONCEPTS` via the alias below.
export const CANONICAL_PURPOSE_CONCEPTS: ConceptDefinition[] = [
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
      // Sprint 3 · 221178 IT-taxonomy slice (2026-08-10) — cloud
      // storage / backup / data storage are consistently sold as
      // recurring cloud subscriptions.
      /\b(online\s*backup|cloud\s*backup|offsite\s*backup|backup\s*storage|backup\s*service|cloud\s*storage|data\s*storage|data\s*backup|hosted\s*storage)\b/i,
    ],
    cueStrength: 78,
  },
  {
    // Sprint 3 · 221178 IT-taxonomy slice (2026-08-10) — cybersecurity
    // as a first-class purpose. Antivirus / endpoint protection /
    // security monitoring belong here, not in physical R&M or in
    // Telephone & Internet or in ordinary Licenses. Tenant COA
    // typically supports these via `Computer & IT Services` or a
    // dedicated `Security` account.
    concept: "CYBERSECURITY_SERVICE",
    label: "Cybersecurity / endpoint protection service",
    cues: [
      /\b(cyber\s*security|cybersecurity|endpoint\s*protection|antivirus|anti[-\s]?virus|edr|mdr|security\s*monitoring|network\s*security|information\s*security|threat\s*detection|vulnerability\s*scan(?:ning)?|penetration\s*test)\b/i,
    ],
    cueStrength: 80,
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

// Internal alias — every classifier call site below uses `CONCEPTS`.
const CONCEPTS = CANONICAL_PURPOSE_CONCEPTS;

// -----------------------------------------------------------------------------
// Provider interface
// -----------------------------------------------------------------------------

export interface PurposeEvidenceCite {
  lineItemIndex?: number;
  lineItemDescription?: string;
  cue: string;
  strength: "strong" | "medium" | "weak";
  reason: string;
  // Sprint 3 · Phase 4 Slice 5.10 (2026-08-09) — evidence provenance
  // for §2 role model + §3 authority hierarchy. `authorityTier` is
  // 1 (primary transaction), 2 (transaction context), 3 (ancillary),
  // or 4 (boilerplate / warranty terms / footer). `sourceType` names
  // where the cue actually appeared. Backfilled to every citation
  // this classifier emits so downstream diagnostics can prove the
  // provenance behind any purpose commitment.
  authorityTier?: 1 | 2 | 3 | 4;
  sourceType?:
    | "line_item_primary_purchase"
    | "line_item_aux"
    | "purchased_object_role"
    | "transactional_body_text"
    | "body_boilerplate_zone"
    | "supplier_name";
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
  // Sprint 3 · Phase 4 Slice 5.10 (2026-08-09) — §6 authority
  // consumption. When available, the taxonomy classifier consults
  // per-line PurchasedObjectIdentity roles so a COMPLETE_MACHINE
  // classification on a line item overrides cue-based EQUIPMENT_PARTS
  // or REPAIR_MAINTENANCE hits from adjectival tokens in the same
  // description (e.g. "Reel Mower" → mower is a complete unit, not
  // a "reel" part).
  //
  // The array is aligned index-with-index against the same
  // `lineItems` list passed to `classify()`.
  purchasedObjectRolesByLineIndex?: Array<
    "COMPLETE_MACHINE"
    | "SERIALIZED_COMPONENT"
    | "COMPONENT"
    | "ACCESSORY"
    | "CONSUMABLE"
    | "SERVICE"
    | "UNKNOWN"
    | null
  >;
}

// Sprint 3 · Phase 4 Slice 5.10 (2026-08-09) — §2 evidence-role /
// §3 authority-hierarchy support. Structural boundary detection for
// low-authority document zones (warranty, terms & conditions,
// payment terms, service-terms boilerplate). Class-of-thing patterns
// only — NO supplier / invoice / SKU / vendor literals.
const BOILERPLATE_ZONE_HEADERS = [
  /^={2,}\s*(?:warranty|service\s+terms|terms\s+(?:and|&)\s+conditions|payment\s+terms|standard\s+terms|conditions\s+of\s+sale)[\s&]*(?:warranty|service\s+terms|terms)?\s*={2,}$/im,
  /^\s*warranty\s*(?:&|and)\s*service\s+terms\s*$/im,
  /^\s*warranty\s+(?:&|and)\s+maintenance\s+terms\s*$/im,
  /^\s*terms\s*(?:&|and)\s*conditions\s*$/im,
  /^\s*payment\s+terms\s*$/im,
  /^\s*standard\s+(?:terms|conditions|warranty)\s*$/im,
  /^\s*service\s+&?\s*repair\s+terms\s*$/im,
];

/** §3 Tier-4 zone extraction. Splits body text at the first
 *  boilerplate-zone header we can find. Text BEFORE the header is
 *  transactional (Tier 1-2). Text AFTER is boilerplate (Tier 4).
 *  If no header is found, everything is treated as transactional. */
function splitBodyIntoZones(text: string): { transactional: string; boilerplate: string } {
  if (!text || text.length === 0) return { transactional: "", boilerplate: "" };
  let earliestBoilerplateStart = -1;
  for (const re of BOILERPLATE_ZONE_HEADERS) {
    const m = re.exec(text);
    if (m && (earliestBoilerplateStart === -1 || m.index < earliestBoilerplateStart)) {
      earliestBoilerplateStart = m.index;
    }
  }
  if (earliestBoilerplateStart === -1) {
    return { transactional: text, boilerplate: "" };
  }
  return {
    transactional: text.slice(0, earliestBoilerplateStart),
    boilerplate: text.slice(earliestBoilerplateStart),
  };
}

// §3 additional Tier-1 contradictions specific to REPAIR_MAINTENANCE
// when project-completion context is present. These signals do NOT
// automatically classify capital; they merely CONTRADICT operating-
// repair when they co-occur with a rebuild/repair-style word on the
// primary line item. Class-of-thing patterns only.
const REPAIR_CONTRADICTED_BY_PROJECT_STATE = [
  /\bplaced\s+in\s+service\b/i,
  /\bsubstantial\s+completion\b/i,
  /\bwork\s+completed\b/i,
  /\bproject\s+closed\b/i,
  /\bfinal\s+invoice[^a-z]/i,   // "final invoice" but not "final invoiced"
  /\bdelivered\s+and\s+inspected\b/i,
  /\bconstruction\s+in\s+progress\b/i,
  /\baia\s+(?:g702|g703|progress\s+billing)\b/i,
  /\bapplication\s+for\s+payment\b/i,
];

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
    //
    // Sprint 3 · Phase 4 Slice 5.10 (2026-08-09) — §6 authority
    // consumption. When PurchasedObjectIdentity has committed the
    // line to a role, we use that role to CONTEXTUALIZE the cue
    // matching:
    //
    //   role = COMPLETE_MACHINE
    //     → EQUIPMENT_PARTS / REPAIR_MAINTENANCE hits on this line
    //       are DEMOTED to weak (they are almost always adjectives
    //       inside a machine model name like "Reel Mower"). Non-
    //       maintenance concepts still fire STRONG.
    //     → CAPITAL_EQUIPMENT hits (mower/tractor/etc.) fire STRONG.
    //   role = SERVICE  → REPAIR_MAINTENANCE stays STRONG.
    //   role = COMPONENT / SERIALIZED_COMPONENT / CONSUMABLE / etc.
    //     → normal behaviour.
    //   role = null / UNKNOWN → normal behaviour (backward-compatible).
    //
    // This is authoritative consumption, NOT a keyword blacklist.
    const roles = ctx.purchasedObjectRolesByLineIndex ?? [];
    // Note: `roles` is aligned against the caller's `lineItems`, but
    // our internal `pool` is filtered. Map back via the original
    // index carried on the line item via reference equality against
    // the original list.
    // §6/§11 defensive helper. When the line's authoritative role is
    // COMPLETE_MACHINE we demote EQUIPMENT_PARTS/REPAIR_MAINTENANCE
    // cues on that line. Additionally — and independent of role
    // detection — when the SAME description matches a CAPITAL_EQUIPMENT
    // machine-noun cue (mower / tractor / etc.) we also treat that
    // line as complete-machine for demotion purposes. The compound
    // noun ("Reel Mower", "Fairway Mower", "Utility Tractor") makes
    // the EQUIPMENT_PARTS token adjectival. This backs the
    // PurchasedObjectIdentity signal when line-item extraction has
    // split the machine description across rows.
    const CAPITAL_MACHINE_NOUN_RE_LOCAL =
      /\b(?:mower|tractor|utility\s*vehicle|golf\s*cart|aerator|topdresser|sprayer|blower|greensmower|walking\s*mower|fairway\s*mower|rough\s*mower|hvac\s*unit|compressor|generator|forklift|new\s+equipment|complete\s+unit|complete\s+system|new\s+machine)\b/i;

    pool.forEach((li) => {
      const originalIndex = lineItems.indexOf(li);
      const desc = li.description;
      const role = originalIndex >= 0 && originalIndex < roles.length ? roles[originalIndex] : null;
      const lineDescLooksLikeCompleteMachine = CAPITAL_MACHINE_NOUN_RE_LOCAL.test(desc);
      const isCompleteMachineRole = role === "COMPLETE_MACHINE" || lineDescLooksLikeCompleteMachine;
      for (const def of CONCEPTS) {
        // §6/§11 — when the line's authoritative role is
        // COMPLETE_MACHINE, EQUIPMENT_PARTS and REPAIR_MAINTENANCE
        // cues on THIS line are almost always adjectival ("Reel
        // Mower", "Turf Repair Ltd." etc.) rather than the true
        // economic purpose. Demote the strength.
        const demoteForCompleteMachine = isCompleteMachineRole
          && (def.concept === "EQUIPMENT_PARTS" || def.concept === "REPAIR_MAINTENANCE");
        for (const cue of def.cues) {
          if (cue.test(desc)) {
            const strength: "strong" | "medium" | "weak" = demoteForCompleteMachine ? "weak" : "strong";
            const weight = demoteForCompleteMachine
              ? Math.round(def.cueStrength * 0.15)
              : def.cueStrength;
            record(def.concept, weight, {
              lineItemIndex: originalIndex,
              lineItemDescription: desc.slice(0, 80),
              cue: cue.source,
              strength,
              reason: demoteForCompleteMachine
                ? `line-item cue for ${def.label} demoted — PurchasedObjectIdentity=COMPLETE_MACHINE on this row (§6)`
                : `line-item description matches ${def.label} concept`,
              authorityTier: 1,
              sourceType: "line_item_primary_purchase",
            }, false);
          }
        }
        if (def.contradictions) {
          for (const cue of def.contradictions) {
            if (cue.test(desc)) {
              record(def.concept, -Math.round(def.cueStrength * 0.4), {
                lineItemIndex: originalIndex,
                lineItemDescription: desc.slice(0, 80),
                cue: cue.source,
                strength: "strong",
                reason: `line-item description contradicts ${def.label}`,
                authorityTier: 1,
                sourceType: "line_item_primary_purchase",
              }, true);
            }
          }
        }
      }
    });

    // Sprint 3 · Phase 4 Slice 5.10 (2026-08-09) — §3 authority
    // hierarchy. Split full document text into transactional zone
    // (Tier 2) and boilerplate zone (Tier 4). Cues hitting only the
    // boilerplate zone contribute at Tier 4 (weak) and cannot beat
    // primary Tier-1 evidence per §8 hard rule.
    const text = (ctx.fullDocumentText ?? "").slice(0, 8000);
    if (text) {
      const zones = splitBodyIntoZones(text);
      // MEDIUM: transactional-zone body text (only when a line-item
      // hit is already present — never as sole evidence).
      for (const def of CONCEPTS) {
        const existing = scores.get(def.concept);
        if (!existing) continue; // don't originate from doc text alone
        for (const cue of def.cues) {
          if (zones.transactional && cue.test(zones.transactional)) {
            record(def.concept, Math.round(def.cueStrength * 0.35), {
              cue: cue.source,
              strength: "medium",
              reason: `transactional-zone body text reinforces ${def.label}`,
              authorityTier: 2,
              sourceType: "transactional_body_text",
            }, false);
          }
        }
      }
      // WEAK / Tier-4: boilerplate zone cues get very small weight
      // and can never dominate primary evidence. §8: no purpose
      // commitment may be made SOLELY from boilerplate.
      if (zones.boilerplate) {
        for (const def of CONCEPTS) {
          const existing = scores.get(def.concept);
          if (!existing) continue; // never originate purpose from boilerplate
          for (const cue of def.cues) {
            if (cue.test(zones.boilerplate)) {
              // §4: boilerplate warranty/repair language must not
              // become purchase substance. Contribution is tiny
              // (5% instead of 35%) and clearly tagged Tier-4 so
              // downstream diagnostics prove the demotion.
              record(def.concept, Math.round(def.cueStrength * 0.05), {
                cue: cue.source,
                strength: "weak",
                reason: `boilerplate-zone cue (warranty/terms footer) — Tier-4 authority`,
                authorityTier: 4,
                sourceType: "body_boilerplate_zone",
              }, false);
            }
          }
        }
      }

      // §10 — REPAIR_MAINTENANCE contradictions from project-state
      // signals. If ANY transactional-zone text says "placed in
      // service" / "project closed" / "substantial completion" /
      // etc., that contradicts an OPERATING repair interpretation
      // regardless of whether "rebuild" was on the line item. This
      // does NOT commit CAPITAL — it just removes the false-positive
      // pull on REPAIR_MAINTENANCE.
      const repairScore = scores.get("REPAIR_MAINTENANCE");
      if (repairScore && zones.transactional) {
        for (const re of REPAIR_CONTRADICTED_BY_PROJECT_STATE) {
          if (re.test(zones.transactional)) {
            const def = CONCEPTS.find((c) => c.concept === "REPAIR_MAINTENANCE")!;
            record("REPAIR_MAINTENANCE", -Math.round(def.cueStrength * 0.6), {
              cue: re.source,
              strength: "strong",
              reason: `project-state signal contradicts operating REPAIR_MAINTENANCE (§10)`,
              authorityTier: 1,
              sourceType: "transactional_body_text",
            }, true);
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
              authorityTier: 3,
              sourceType: "supplier_name",
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
