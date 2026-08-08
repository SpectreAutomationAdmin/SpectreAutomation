// Sprint 3 · Phase 4 Slice 5.3 completion pass (2026-08-08) —
// PurchasedObject identity + object-role classification + object
// hierarchy.
//
// Founder amendments §6–§14 (completion pass):
//   • Do NOT flatten a multi-brand description into one manufacturer/
//     model pair. Preserve candidates for brand, model, SKU, serial.
//   • Do NOT treat "engine" (or "seat", "pump", "motor", "controller",
//     "compressor", "assembly") as a hard COMPONENT verdict — treat as
//     evidence, not verdict.
//   • Object roles: COMPLETE_MACHINE | SERIALIZED_COMPONENT | COMPONENT
//     | ACCESSORY | CONSUMABLE | SERVICE | UNKNOWN.
//   • Represent relationships: BUNDLED_WITH, PART_OF, ACCESSORY_FOR,
//     REPLACEMENT_FOR, COMPATIBLE_WITH, UNKNOWN_RELATIONSHIP.
//   • Zero-dollar bundled accessory is contextual evidence for a
//     complete-machine interpretation, never a hardcoded rule.
//   • Provider interface (§16) so a future understanding provider
//     (embeddings / product-reference / multimodal) can be plugged in
//     without changing downstream accounting architecture.
//
// This module is generic — no supplier / model / SKU / product-code
// literal. Every noun list is a closed generic vocabulary.

import type { CanonicalLineItem } from "./evidence/canonical-line-item";
import { isItemizedSummaryDescription } from "./line-item-region-strategies";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type ObjectRole =
  | "COMPLETE_MACHINE"
  | "SERIALIZED_COMPONENT"
  | "COMPONENT"
  | "ACCESSORY"
  | "CONSUMABLE"
  | "SERVICE"
  | "UNKNOWN";

export type RelationshipKind =
  | "PART_OF"
  | "COMPATIBLE_WITH"
  | "ACCESSORY_FOR"
  | "BUNDLED_WITH"
  | "REPLACEMENT_FOR"
  | "UNKNOWN_RELATIONSHIP";

export type EvidenceStrength = "strong" | "medium" | "weak";

export interface IdentityEvidence {
  value: string;
  strength: EvidenceStrength;
  provenance: string;
}

export interface ObjectRoleEvidence {
  kind:
    | "complete_machine_vocab"
    | "component_vocab"
    | "engine_or_assembly_body_word"
    | "seat_or_accessory_body_word"
    | "consumable_vocab"
    | "service_vocab"
    | "serial_identifier"
    | "high_extension_unit"
    | "zero_extension_accessory"
    | "model_and_brand_present"
    | "labour_or_install_sibling"
    | "replacement_language"
    | "capital_project_context";
  detail: string;
  strength: EvidenceStrength;
  // Which candidate role this evidence supports (may support more
  // than one).
  supports: ObjectRole[];
  contradicts?: ObjectRole[];
}

export interface ObjectRelationship {
  targetIndex: number;
  kind: RelationshipKind;
  strength: EvidenceStrength;
  detail: string;
}

export interface PurchasedObjectIdentity {
  description: string;

  brandCandidates: IdentityEvidence[];
  modelCandidates: IdentityEvidence[];
  skuCandidates: IdentityEvidence[];
  serialCandidates: IdentityEvidence[];

  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  extension: number | null;

  objectRole: ObjectRole;
  objectRoleConfidence: number;
  objectRoleEvidence: ObjectRoleEvidence[];
  objectRoleContradictions: ObjectRoleEvidence[];
  objectRoleDiagnostic: string;

  relatedObjects: ObjectRelationship[];

  evidenceQuality: "HIGH" | "MEDIUM" | "LOW";
  provenance: string[];
  sourceLineItemIndex: number;
}

// -----------------------------------------------------------------------------
// Vocabularies — closed generic lists. NO supplier / product literals.
// -----------------------------------------------------------------------------

const COMPLETE_MACHINE_NOUNS = [
  /\bmower\b/i, /\btractor\b/i, /\butility\s+vehicle\b/i, /\bgolf\s+cart\b/i,
  /\baerator\b/i, /\btopdresser\b/i, /\bsprayer\b/i, /\bblower\b/i,
  /\bgenerator\b/i, /\bcompressor\b/i, /\bforklift\b/i, /\bskid\s*steer\b/i,
  /\bloader\b/i, /\bexcavator\b/i, /\bbulldozer\b/i, /\bdumper\b/i,
  /\btrailer\b/i, /\bhvac\s+unit\b/i, /\bair\s+conditioner\b/i, /\bfurnace\b/i,
  /\bboiler\b/i, /\bchiller\b/i, /\bheat\s+pump\b/i, /\bdehumidifier\b/i,
  /\bdishwasher\b/i, /\boven\b/i, /\brange\b/i, /\brefrigerator\b/i,
  /\bfreezer\b/i, /\bice\s*machine\b/i, /\bdeep\s*fryer\b/i, /\bcombi\s*oven\b/i,
  /\bwalk[-\s]?in\b/i,
  /\bserver\b/i, /\bdesktop\b/i, /\blaptop\b/i, /\bworkstation\b/i,
  /\bprinter\b/i, /\bphotocopier\b/i, /\bmultifunction\s+device\b/i,
  /\bcomplete\s+unit\b/i, /\bcomplete\s+system\b/i, /\bnew\s+machine\b/i,
];

// Engine / transmission / pump-body etc. — evidence for COMPONENT role.
// Per §9 completion-pass amendment: NOT a hard verdict.
const ASSEMBLY_BODY_NOUNS = [
  /\bengine\b/i, /\btransmission\b/i, /\bgearbox\b/i,
  /\bcontrol\s+board\b/i, /\bcontroller(?:\s+board)?\b/i,
  /\bhydraulic\s+pump\b/i, /\bwater\s+pump\b/i, /\bfuel\s+pump\b/i,
  /\bpump\s+body\b/i, /\bmotor\s+assembly\b/i,
];

// Standalone pump / motor / controller etc. that MAY be either a
// complete standalone asset OR a replacement assembly.
const AMBIGUOUS_ASSEMBLY_NOUNS = [
  /\bpump\b/i, /\bmotor\b/i, /\bcontroller\b/i, /\bcompressor\b/i,
  /\bactuator\b/i, /\bassembly\b/i, /\basm\b/i,
];

const SMALL_COMPONENT_NOUNS = [
  /\bbearing\b/i, /\bseal\b/i, /\bspacer\b/i, /\bbelt\b/i, /\bfilter\b/i,
  /\bblade\b/i, /\breel(?:\s+blade)?\b/i, /\bbedknife\b/i, /\bspring\b/i,
  /\bbolt\b/i, /\bnut\b/i, /\bwasher\b/i, /\bgasket\b/i, /\bhose\b/i,
  /\bfitting\b/i, /\bvalve\b/i, /\bswitch\b/i, /\bsolenoid\b/i, /\bsensor\b/i,
  /\bspark\s*plug\b/i, /\btire\b/i, /\btyre\b/i, /\btube\b/i, /\brim\b/i,
  /\bbattery\b/i, /\balternator\b/i, /\bstarter\b/i, /\bclutch\b/i,
  /\bbrake\s*(?:pad|disc|rotor|caliper)\b/i,
  /\bnozzle\b/i, /\bpiston\b/i, /\bring\b/i,
  /\bpulley\b/i, /\bsprocket\b/i, /\bchain\b/i, /\bcable\b/i, /\bwire\b/i,
  /\bfuse\b/i, /\brelay\b/i, /\bcoil\b/i,
  /\brepair\s+kit\b/i, /\bservice\s+kit\b/i,
];

const ACCESSORY_NOUNS = [
  /\bseat\b/i, /\bsteering\s+wheel\b/i, /\battachment\b/i, /\baccessory\b/i,
  /\baccessories\b/i, /\bwindshield\b/i, /\bmirror\b/i, /\blight\b/i,
  /\blamp\b/i, /\bbulb\b/i, /\bdash\b/i, /\bpanel\b/i, /\bcover\b/i,
  /\bhood\b/i, /\bdoor\b/i, /\bhandle\b/i, /\bgrip\b/i, /\bdeck\b/i,
  /\bupgrade\s+kit\b/i,
];

const CONSUMABLE_NOUNS = [
  /\bdiesel\b/i, /\bgasoline\b/i, /\bgas(?:oline)?\b/i, /\bpetrol\b/i,
  /\bfuel\b/i, /\bpetroleum\b/i, /\bjet\s+fuel\b/i, /\bkerosene\b/i,
  /\bethanol\b/i, /\bpropane\b/i,
  /\bfertili(?:z|s)er\b/i, /\bseed\b/i, /\bsod\b/i, /\btopdressing\b/i,
  /\bpesticide\b/i, /\bherbicide\b/i, /\bfungicide\b/i, /\binsecticide\b/i,
  /\bchemical\b/i, /\bchemicals\b/i,
  /\boil\b/i, /\bgrease\b/i, /\blubricant\b/i, /\bcoolant\b/i,
  /\bantifreeze\b/i, /\bhydraulic\s+fluid\b/i, /\bdef\s+fluid\b/i,
  /\bpaper\b/i, /\bnapkin\b/i, /\btowel\b/i, /\btoilet\s+paper\b/i,
  /\bcleaning\s+solution\b/i, /\bdetergent\b/i, /\bsoap\b/i,
];

const SERVICE_NOUNS = [
  /\blabour\b/i, /\blabor\b/i, /\bservice\s+call\b/i, /\binstallation\b/i,
  /\binspection\b/i, /\bmaintenance\s+call\b/i, /\btune[-\s]?up\b/i,
  /\brepair\s+service\b/i, /\bcalibration\b/i,
  /\bconsulting\b/i, /\badvisory\b/i, /\baudit\s+service\b/i,
  /\blegal\s+service\b/i, /\baccounting\s+service\b/i, /\bdesign\s+service\b/i,
  /\btraining\b/i,
];

const REPLACEMENT_LANGUAGE = [
  /\breplacement\b/i, /\breplaced\b/i, /\bexchange\b/i, /\bexchanged\b/i,
  /\brebuild\b/i, /\bre[-\s]?built\b/i, /\brefurbish(?:ed)?\b/i,
  /\bwarranty\s+claim\b/i, /\brma\b/i,
];

const CAPITAL_CONTEXT = [
  /\bcapital\s+project\b/i, /\bcapital\s+expenditure\b/i,
  /\bcapital\s+improvement\b/i, /\basset\s+register\b/i,
  /\bproject\s*(?:#|no\.?|number)\b/i,
];

const CONSTRUCTION_LANGUAGE = [
  /\bconstruction\b/i, /\bconstructed\b/i, /\brenovation\b/i,
  /\brenovate\b/i, /\bexpansion\b/i, /\bbuild[-\s]?out\b/i,
];

// Generic-token reject set — same list guarded by purchased-item-identity.ts,
// re-used here.
const NON_BRAND_TOKENS = new Set([
  "EA", "PCS", "PC", "KG", "LB", "LBS", "OZ", "GAL", "L", "ML",
  "GST", "HST", "PST", "QST", "VAT",
  "TOTAL", "SUBTOTAL", "SUB", "TAX", "AMOUNT", "AMT", "PRICE", "COST", "NET", "GROSS",
  "LINE", "LINES", "ITEM", "ITEMS", "PRODUCT", "PRODUCTS", "PART", "PARTS", "EACH",
  "INC", "LTD", "CO", "CORP", "LLC",
  "USD", "CAD", "EUR", "GBP",
  "QTY", "SKU", "REF", "MODEL", "SERIAL", "MFG", "MFR",
  "NEW", "USED", "REBUILT", "OEM",
  "PREMIUM", "STANDARD", "BASIC", "DELUXE",
  "SEAT", "COVER", "PUMP", "MOTOR",   // structural nouns — never brand
  "ENGINE", "TRANSMISSION", "GEARBOX",
  "TIRE", "TYRE", "BELT", "FILTER",
]);

// -----------------------------------------------------------------------------
// Provider interface (§16)
// -----------------------------------------------------------------------------

export interface PurchasedObjectUnderstandingProvider {
  interpret(items: CanonicalLineItem[]): PurchasedObjectIdentity[];
}

// -----------------------------------------------------------------------------
// Deterministic default provider
// -----------------------------------------------------------------------------

export class DeterministicPurchasedObjectProvider implements PurchasedObjectUnderstandingProvider {
  interpret(items: CanonicalLineItem[]): PurchasedObjectIdentity[] {
    const canonical: CanonicalLineItem[] = items;
    // Attach description-only continuation rows to the preceding
    // substantive row (Serial #: X). This is a no-op if the canonical
    // extractor already merged them — the extractor does that today,
    // but this belt-and-braces guarantees single-object rows.
    const objects: PurchasedObjectIdentity[] = [];
    for (let i = 0; i < canonical.length; i++) {
      const li = canonical[i];
      if (li.role !== "PRIMARY_PURCHASE" && li.role !== "SURCHARGE") continue;
      if (isItemizedSummaryDescription(li.description)) continue;

      const obj = buildIdentity(li, i);
      objects.push(obj);
    }
    // §8 completion pass: compute relationships between objects.
    for (let i = 0; i < objects.length; i++) {
      for (let j = 0; j < objects.length; j++) {
        if (i === j) continue;
        const rel = detectRelationship(objects[i], objects[j]);
        if (rel != null) objects[i].relatedObjects.push({
          targetIndex: objects[j].sourceLineItemIndex,
          kind: rel.kind,
          strength: rel.strength,
          detail: rel.detail,
        });
      }
    }
    // §10 completion pass: refine objectRole with context (zero-dollar
    // bundled accessory bumps the primary object toward COMPLETE_MACHINE
    // rather than being a hard rule).
    for (const obj of objects) {
      const bundledInto = obj.relatedObjects.find((r) => r.kind === "BUNDLED_WITH");
      if (bundledInto && (obj.extension == null || obj.extension === 0)) {
        // This object is a bundled zero-dollar item — it's an ACCESSORY
        // if not already classified stronger.
        if (obj.objectRole === "UNKNOWN" || obj.objectRole === "COMPONENT") {
          obj.objectRole = "ACCESSORY";
          obj.objectRoleEvidence.push({
            kind: "zero_extension_accessory",
            detail: `zero-cost, bundled with row #${bundledInto.targetIndex}`,
            strength: "strong",
            supports: ["ACCESSORY"],
          });
        }
      }
    }
    return objects;
  }
}

// -----------------------------------------------------------------------------
// Identity extraction from a single CanonicalLineItem
// -----------------------------------------------------------------------------

function buildIdentity(li: CanonicalLineItem, index: number): PurchasedObjectIdentity {
  const description = li.description;
  const provenance: string[] = [
    `canonical_line_item(role=${li.role})`,
  ];

  const brandCandidates = extractBrandCandidates(description);
  const modelCandidates = extractModelCandidates(description);
  const skuCandidates = extractSkuCandidates(description, li.sku ?? null);
  const serialCandidates = extractSerialCandidates(description);

  const roleEvidence: ObjectRoleEvidence[] = [];
  const roleContradictions: ObjectRoleEvidence[] = [];

  // Weighted scoring per role. NO single vocab hit produces a verdict.
  const scores: Record<ObjectRole, number> = {
    COMPLETE_MACHINE: 0,
    SERIALIZED_COMPONENT: 0,
    COMPONENT: 0,
    ACCESSORY: 0,
    CONSUMABLE: 0,
    SERVICE: 0,
    UNKNOWN: 0,
  };

  for (const re of COMPLETE_MACHINE_NOUNS) {
    if (re.test(description)) {
      scores.COMPLETE_MACHINE += 20;
      roleEvidence.push({
        kind: "complete_machine_vocab",
        detail: re.source,
        strength: "medium",
        supports: ["COMPLETE_MACHINE"],
      });
    }
  }
  for (const re of ASSEMBLY_BODY_NOUNS) {
    if (re.test(description)) {
      // §9 completion-pass: engine/transmission/pump-body is EVIDENCE
      // for COMPONENT / SERIALIZED_COMPONENT, but not a verdict. Also
      // weakly supports COMPLETE_MACHINE when the description names an
      // outer machine (e.g. TORO GM3500D KUBOTA ENGINE — engine names
      // the engine subassembly of a Toro machine).
      scores.COMPONENT += 15;
      scores.SERIALIZED_COMPONENT += 10;
      roleEvidence.push({
        kind: "engine_or_assembly_body_word",
        detail: re.source,
        strength: "medium",
        supports: ["COMPONENT", "SERIALIZED_COMPONENT"],
      });
    }
  }
  for (const re of AMBIGUOUS_ASSEMBLY_NOUNS) {
    if (re.test(description)) {
      scores.COMPONENT += 8;
      scores.COMPLETE_MACHINE += 6;
      roleEvidence.push({
        kind: "component_vocab",
        detail: re.source,
        strength: "weak",
        supports: ["COMPONENT", "COMPLETE_MACHINE"],
      });
    }
  }
  for (const re of SMALL_COMPONENT_NOUNS) {
    if (re.test(description)) {
      scores.COMPONENT += 25;
      roleEvidence.push({
        kind: "component_vocab",
        detail: re.source,
        strength: "strong",
        supports: ["COMPONENT"],
      });
    }
  }
  for (const re of ACCESSORY_NOUNS) {
    if (re.test(description)) {
      scores.ACCESSORY += 20;
      roleEvidence.push({
        kind: "seat_or_accessory_body_word",
        detail: re.source,
        strength: "medium",
        supports: ["ACCESSORY", "COMPONENT"],
      });
    }
  }
  for (const re of CONSUMABLE_NOUNS) {
    if (re.test(description)) {
      scores.CONSUMABLE += 25;
      roleEvidence.push({
        kind: "consumable_vocab",
        detail: re.source,
        strength: "strong",
        supports: ["CONSUMABLE"],
      });
    }
  }
  for (const re of SERVICE_NOUNS) {
    if (re.test(description)) {
      scores.SERVICE += 25;
      roleEvidence.push({
        kind: "service_vocab",
        detail: re.source,
        strength: "strong",
        supports: ["SERVICE"],
      });
    }
  }

  // §14: serial identifier — supports SERIALIZED_COMPONENT and
  // COMPLETE_MACHINE equally. Not decisive.
  if (serialCandidates.length > 0) {
    scores.SERIALIZED_COMPONENT += 8;
    scores.COMPLETE_MACHINE += 8;
    roleEvidence.push({
      kind: "serial_identifier",
      detail: serialCandidates[0].value,
      strength: "medium",
      supports: ["SERIALIZED_COMPONENT", "COMPLETE_MACHINE"],
    });
  }

  // §12: model + brand present + numeric extension of significant
  // magnitude → supporting evidence for COMPLETE_MACHINE (a full unit
  // is typically priced per EA at a substantial figure). This is not
  // a materiality gate — extension magnitude is only evidence for
  // "one purchase per unit" not for capital-vs-operating.
  if (brandCandidates.length > 0 && modelCandidates.length > 0 && li.unit && /^(EA|EACH)$/i.test(li.unit)) {
    scores.COMPLETE_MACHINE += 10;
    roleEvidence.push({
      kind: "model_and_brand_present",
      detail: `brand=${brandCandidates[0].value} model=${modelCandidates[0].value} per=${li.unit}`,
      strength: "medium",
      supports: ["COMPLETE_MACHINE"],
    });
  }

  // §12: replacement language.
  for (const re of REPLACEMENT_LANGUAGE) {
    if (re.test(description)) {
      scores.SERIALIZED_COMPONENT += 15;
      scores.COMPONENT += 10;
      roleEvidence.push({
        kind: "replacement_language",
        detail: re.source,
        strength: "strong",
        supports: ["SERIALIZED_COMPONENT", "COMPONENT"],
        contradicts: ["COMPLETE_MACHINE"],
      });
      // Contradiction of COMPLETE_MACHINE
      scores.COMPLETE_MACHINE -= 12;
      roleContradictions.push({
        kind: "replacement_language",
        detail: `"${re.source}" contradicts complete-machine reading`,
        strength: "strong",
        supports: [], contradicts: ["COMPLETE_MACHINE"],
      });
    }
  }

  // §12: capital-project / construction context boosts COMPLETE_MACHINE.
  for (const re of CAPITAL_CONTEXT) {
    if (re.test(description)) {
      scores.COMPLETE_MACHINE += 15;
      roleEvidence.push({
        kind: "capital_project_context",
        detail: re.source,
        strength: "medium",
        supports: ["COMPLETE_MACHINE"],
      });
    }
  }
  for (const re of CONSTRUCTION_LANGUAGE) {
    if (re.test(description)) {
      scores.COMPLETE_MACHINE += 10;
      roleEvidence.push({
        kind: "capital_project_context",
        detail: re.source,
        strength: "weak",
        supports: ["COMPLETE_MACHINE"],
      });
    }
  }

  // Choose role: top score with commit floor and gap check.
  const ranked = (Object.entries(scores) as Array<[ObjectRole, number]>)
    .sort((a, b) => b[1] - a[1]);
  const [topRole, topScore] = ranked[0];
  const [secondRole, secondScore] = ranked[1] ?? ["UNKNOWN", 0];
  const gap = topScore - secondScore;

  let objectRole: ObjectRole;
  let confidence: number;
  const COMMIT_FLOOR = 20;
  const GAP_MIN = 8;
  if (topScore < COMMIT_FLOOR) {
    objectRole = "UNKNOWN";
    confidence = Math.min(30, Math.max(0, topScore));
  } else if (gap < GAP_MIN) {
    objectRole = "UNKNOWN";
    confidence = Math.min(45, topScore);
  } else {
    objectRole = topRole;
    confidence = Math.min(95, topScore + Math.min(5, gap));
  }

  // Serial + a defensible role for a complete unit → promote to
  // SERIALIZED_COMPONENT only if that's the top rank; do not promote
  // COMPLETE_MACHINE to SERIALIZED_COMPONENT automatically.
  const diagnostic = `role=${objectRole}(${confidence}) top=${topRole}(${topScore}) 2nd=${secondRole}(${secondScore}) scores=${JSON.stringify(scores)}`;

  // Evidence quality (same three-band scale as PurchasedItemIdentity).
  const substantiveLen = description.trim().length;
  let evidenceQuality: "HIGH" | "MEDIUM" | "LOW";
  const hasStructured = modelCandidates.length > 0 || skuCandidates.length > 0
    || serialCandidates.length > 0 || li.sku != null;
  if (hasStructured && li.extension != null && substantiveLen >= 6) evidenceQuality = "HIGH";
  else if (li.extension != null && substantiveLen >= 6) evidenceQuality = "MEDIUM";
  else evidenceQuality = "LOW";

  return {
    description,
    brandCandidates,
    modelCandidates,
    skuCandidates,
    serialCandidates,
    quantity: li.quantity ?? null,
    unit: li.unit ?? null,
    unitPrice: li.unitPrice ?? null,
    extension: li.extension ?? null,
    objectRole,
    objectRoleConfidence: confidence,
    objectRoleEvidence: roleEvidence,
    objectRoleContradictions: roleContradictions,
    objectRoleDiagnostic: diagnostic,
    relatedObjects: [],
    evidenceQuality,
    provenance,
    sourceLineItemIndex: index,
  };
}

// -----------------------------------------------------------------------------
// Identity extractors
// -----------------------------------------------------------------------------

function extractBrandCandidates(description: string): IdentityEvidence[] {
  // Brands are ALL-CAPS 3+ letter tokens with NO digits, not in the
  // reject set. Preserve ALL candidates so multi-brand descriptions
  // (e.g. "TORO GM3500D KUBOTA ENGINE") keep both.
  const tokens = description.split(/[\s,;:]+/).filter(Boolean);
  const out: IdentityEvidence[] = [];
  for (const t of tokens) {
    const clean = t.replace(/[.,;:]+$/, "");
    if (clean.length < 3) continue;
    if (NON_BRAND_TOKENS.has(clean.toUpperCase())) continue;
    if (!/^[A-Z][A-Z]{2,}$/.test(clean)) continue;  // ALL CAPS 3+ letters
    if (/\d/.test(clean)) continue;                  // no digits
    out.push({
      value: clean,
      strength: "medium",
      provenance: `all_caps_token`,
    });
  }
  return out;
}

function extractModelCandidates(description: string): IdentityEvidence[] {
  const tokens = description.split(/[\s,;:]+/).filter(Boolean);
  const out: IdentityEvidence[] = [];
  for (const t of tokens) {
    const clean = t.replace(/[.,;:]+$/, "");
    if (clean.length < 3 || clean.length > 20) continue;
    if (NON_BRAND_TOKENS.has(clean.toUpperCase())) continue;
    // Model tokens: contain digit OR hyphen; not purely numeric; not
    // a serial-shape (≥ 8 pure digits without letters).
    if (!/[\d\-_]/.test(clean)) continue;
    if (/^\d+$/.test(clean)) continue;
    if (/^\d{8,}$/.test(clean)) continue;   // serial-shape
    if (!/^[A-Z0-9][A-Z0-9\-_/.]{2,15}$/i.test(clean)) continue;
    out.push({
      value: clean,
      strength: "strong",
      provenance: `model_shape_token`,
    });
  }
  return out;
}

function extractSkuCandidates(description: string, structuredSku: string | null): IdentityEvidence[] {
  const out: IdentityEvidence[] = [];
  if (structuredSku) {
    out.push({
      value: structuredSku,
      strength: "strong",
      provenance: "sku_column",
    });
  }
  // §15: leading numeric prefix like "1 30807" or "30807" — could be
  // line# + product-code. Preserve as candidate with lower strength.
  const leading = description.match(/^\s*(?:\d{1,3}\s+)?(\d{4,7})\b/);
  if (leading) {
    out.push({
      value: leading[1],
      strength: "medium",
      provenance: "leading_numeric_prefix",
    });
  }
  return out;
}

function extractSerialCandidates(description: string): IdentityEvidence[] {
  const out: IdentityEvidence[] = [];
  const labelled = description.match(/\bSerial\s*(?:#|no\.?|number)?\s*[:\.]?\s*([A-Z0-9][A-Z0-9\-_]{5,})/i);
  if (labelled) {
    out.push({
      value: labelled[1],
      strength: "strong",
      provenance: "explicit_labelled_serial",
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Relationship detection
// -----------------------------------------------------------------------------

function detectRelationship(a: PurchasedObjectIdentity, b: PurchasedObjectIdentity): {
  kind: RelationshipKind;
  strength: EvidenceStrength;
  detail: string;
} | null {
  // Shared model between two rows → related. If one is ACCESSORY-shape
  // (SEAT / STEERING / ATTACHMENT) with zero cost, treat as
  // ACCESSORY_FOR / BUNDLED_WITH.
  const aModels = new Set(a.modelCandidates.map((m) => m.value.toUpperCase()));
  const bModels = new Set(b.modelCandidates.map((m) => m.value.toUpperCase()));
  const sharedModel = [...aModels].find((m) => bModels.has(m)) ?? null;
  if (sharedModel) {
    const aZero = a.extension === 0 || a.extension == null;
    const bZero = b.extension === 0 || b.extension == null;
    // A is zero-cost ACCESSORY of B (higher-value item)
    if (aZero && !bZero && a.objectRole !== "COMPLETE_MACHINE") {
      return {
        kind: "BUNDLED_WITH",
        strength: "strong",
        detail: `zero-cost item sharing model ${sharedModel} with high-value row`,
      };
    }
    // Just related through shared model — no strong hierarchy
    return {
      kind: "COMPATIBLE_WITH",
      strength: "medium",
      detail: `shared model ${sharedModel}`,
    };
  }
  return null;
}
