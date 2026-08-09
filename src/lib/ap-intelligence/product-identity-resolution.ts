// Sprint 3 · Phase 4 Slice 5.4 (2026-08-08) — Product Identity
// Resolution.
//
// The layer between PurchasedObjectIdentity (structural extraction)
// and CapitalEvidenceDecision (accounting nature). When a purchased
// object admits more than one plausible object interpretation (e.g.
// complete machine vs replacement engine + serialized component),
// this layer:
//
//   • generates the competing candidates from internal evidence,
//   • scores each with internal support / contradictions,
//   • asks a PricePlausibilityProvider whether the observed price
//     is plausible for each candidate,
//   • optionally consults an external ProductReferenceProvider for
//     product-family / OEM / market evidence to break ambiguity,
//   • emits a status of RESOLVED_INTERNAL, RESOLVED_WITH_EXTERNAL_
//     CORROBORATION, AMBIGUOUS, or UNRESOLVED.
//
// Founder §1 invariant: price may resolve OBJECT IDENTITY but may
// NEVER directly increase CAPITAL score. Locked structurally by
// tests.
//
// Founder §2: internal evidence must be exhausted before external
// research is triggered. `externalCorroborationRequired` is set only
// when internal candidates are within the ambiguity band AND the
// ambiguity materially affects downstream accounting treatment.

import type {
  PurchasedObjectIdentity,
  ObjectRelationship,
} from "./purchased-object-identity";
import type {
  PricePlausibilityProvider,
  PricePlausibilityBand,
} from "./price-plausibility";
import type {
  ProductReferenceProvider,
  ProductReferenceResult,
} from "./product-reference-provider";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type ProductObjectType =
  | "COMPLETE_MACHINE"
  | "REPLACEMENT_ENGINE"
  | "SERIALIZED_COMPONENT"
  | "REPLACEMENT_COMPONENT"
  | "ACCESSORY"
  | "CONSUMABLE"
  | "SERVICE"
  | "UNKNOWN";

export type EvidenceStrength = "strong" | "medium" | "weak";

export interface IdentityCandidateEvidence {
  kind: string;
  strength: EvidenceStrength;
  detail: string;
}

export interface ProductIdentityCandidate {
  objectType: ProductObjectType;
  manufacturerCandidates: IdentityCandidateEvidence[];
  brandCandidates: IdentityCandidateEvidence[];
  modelCandidates: IdentityCandidateEvidence[];
  partNumberCandidates: IdentityCandidateEvidence[];
  skuCandidates: IdentityCandidateEvidence[];
  serialCandidates: IdentityCandidateEvidence[];
  relationshipToOtherObjects: ObjectRelationship[];

  internalEvidenceScore: number;
  pricePlausibilityScore?: number;
  pricePlausibilityBand?: PricePlausibilityBand;
  externalEvidenceScore?: number;

  supportingEvidence: IdentityCandidateEvidence[];
  contradictions: IdentityCandidateEvidence[];
  reason: string;

  /** Which purchased-object row this candidate reasons about. */
  sourceObjectIndex: number;
}

export type IdentityStatus =
  | "RESOLVED_INTERNAL"
  | "RESOLVED_WITH_EXTERNAL_CORROBORATION"
  | "AMBIGUOUS"
  | "UNRESOLVED";

export interface ProductIdentityResolution {
  candidates: ProductIdentityCandidate[];
  selected: ProductIdentityCandidate | null;

  status: IdentityStatus;
  confidence: number;
  evidenceQuality: "HIGH" | "MEDIUM" | "LOW";
  reason: string;

  externalCorroborationRequired: boolean;
  externalLookupCount: number;
  externalLatencyMs: number;
  /** Slice 5.6 live acceptance §25: provider diagnostic message
   *  surfaced for auditability. May include error / rate-limit
   *  / no-results state descriptions. Never contains credentials. */
  externalProviderDiagnostic?: string;
  /** Slice 5.6 live acceptance §5: accepted external evidence set
   *  for founder-facing audit. Each entry carries source domain,
   *  tier classification, evidence type, and bounded snippet. */
  externalEvidence?: Array<{
    sourceDomain: string | null;
    sourceTitle: string | null;
    evidenceType: string;
    matchedManufacturer: string | null;
    matchedModel: string | null;
    matchedProductFamily: string | null;
    confidence: number;
    evidenceSnippet: string;
  }>;

  diagnostic: string;
}

// -----------------------------------------------------------------------------
// Vocabularies — closed, generic. NO supplier / product / SKU literal.
// -----------------------------------------------------------------------------

const COMPLETE_MACHINE_VOCAB = /\b(?:mower|tractor|utility\s+vehicle|golf\s+cart|aerator|topdresser|sprayer|blower|greensmower|walking\s+mower|fairway\s+mower|rough\s+mower|reel\s+mower|rotary\s+mower|generator|compressor|forklift|skid\s*steer|loader|excavator|hvac\s+unit|air\s+conditioner|furnace|boiler|chiller|heat\s+pump|dishwasher|oven|refrigerator|freezer|ice\s*machine|deep\s*fryer|combi\s*oven|complete\s+unit|complete\s+system|new\s+machine)\b/i;

const ASSEMBLY_BODY_VOCAB = /\b(?:engine|transmission|gearbox|control\s+board|controller|hydraulic\s+pump|water\s+pump|fuel\s+pump|pump\s+body|motor\s+assembly)\b/i;

const REPAIR_KIT_VOCAB = /\b(?:bearing|seal|filter|belt|blade|reel\s+blade|bedknife|spring|gasket|hose|valve|switch|solenoid|sensor|spark\s*plug|tire|tyre|tube|rim|battery|alternator|starter|clutch|brake\s*(?:pad|disc|rotor|caliper)|nozzle|piston|ring|pulley|sprocket|chain|cable|wire|fuse|relay|coil|repair\s+kit|service\s+kit)\b/i;

const ACCESSORY_VOCAB = /\b(?:seat|steering\s+wheel|attachment|accessory|windshield|mirror|lamp|bulb|cover|hood|door|handle|grip|deck)\b/i;

const CONSUMABLE_VOCAB = /\b(?:diesel|gasoline|gas(?:oline)?|petrol|fuel|petroleum|kerosene|ethanol|propane|fertili(?:z|s)er|seed|sod|topdressing|pesticide|herbicide|fungicide|insecticide|chemical|oil|grease|lubricant|coolant|antifreeze|hydraulic\s+fluid|def\s+fluid)\b/i;

const SERVICE_VOCAB = /\b(?:labour|labor|service\s+call|installation|inspection|maintenance\s+call|tune[-\s]?up|repair\s+service|calibration|consulting|advisory|audit\s+service|legal\s+service|accounting\s+service|training)\b/i;

const REPLACEMENT_LANG = /\b(?:replacement|replaced|exchange|exchanged|rebuild|re[-\s]?built|refurbish(?:ed)?|warranty\s+claim|rma)\b/i;

// -----------------------------------------------------------------------------
// Weights (scoring)
// -----------------------------------------------------------------------------

const W_COMPLETE_VOCAB = 20;
const W_ASSEMBLY_BODY_VOCAB = 15;
const W_COMPONENT_VOCAB = 22;
const W_ACCESSORY_VOCAB = 18;
const W_CONSUMABLE_VOCAB = 25;
const W_SERVICE_VOCAB = 22;
const W_REPLACEMENT_LANG = 20;
const W_MODEL_AND_BRAND_EA = 10;    // complete-machine supporting
const W_SERIAL_PRESENT = 8;         // both complete + component
const W_BUNDLED_ACCESSORY_CONTEXT = 12; // supports COMPLETE_MACHINE
const W_ZERO_COST_ACCESSORY = 15;   // supports ACCESSORY role

// Price-plausibility contribution — bounded so price NEVER dominates
// alone. §1 invariant: price MAY influence object identity but must
// not directly increase capital score. This weight only feeds into
// object-identity scoring; capital scoring in capital-evidence.ts is
// a separate authority.
const W_PRICE_PLAUSIBILITY_PLAUSIBLE = 6;
const W_PRICE_PLAUSIBILITY_HIGH_OR_LOW = -3;
const W_PRICE_PLAUSIBILITY_VERY_HIGH_OR_LOW = -8;

// External corroboration contribution — also bounded.
const W_EXTERNAL_OEM_MATCH = 15;
const W_EXTERNAL_PRODUCT_FAMILY_MATCH = 12;
const W_EXTERNAL_PART_MATCH = 15;
const W_EXTERNAL_MARKET_COMPARABLE = 6;

// Commit thresholds — separate from capital-evidence's floor.
const INTERNAL_COMMIT_MIN = 22;
const INTERNAL_GAP_MIN = 10;
const EXTERNAL_GAP_MIN = 8;

// Ambiguity trigger: when the top-two internal candidates are within
// this delta AND the ambiguity spans object-types that produce
// materially different downstream capital treatments (COMPLETE_MACHINE
// vs SERIALIZED_COMPONENT / REPLACEMENT_ENGINE), external
// corroboration is REQUESTED (subject to §14 controls at the caller).
const MATERIAL_AMBIGUITY_MIN_GAP = 12;

// -----------------------------------------------------------------------------
// Input
// -----------------------------------------------------------------------------

export interface ProductIdentityResolveInput {
  objects: PurchasedObjectIdentity[];
  pricePlausibilityProvider?: PricePlausibilityProvider | null;
  productReferenceProvider?: ProductReferenceProvider | null;
  /** Cap external calls per document (§14 control). Default 2. */
  externalCallCap?: number;
  /** Overall external-lookup wall-clock budget (§14). Default 8s. */
  externalTimeoutMs?: number;
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

export async function resolveProductIdentity(
  input: ProductIdentityResolveInput,
): Promise<ProductIdentityResolution> {
  const objects = input.objects;
  if (objects.length === 0) {
    return {
      candidates: [], selected: null,
      status: "UNRESOLVED",
      confidence: 0,
      evidenceQuality: "LOW",
      reason: "no purchased objects to resolve",
      externalCorroborationRequired: false,
      externalLookupCount: 0,
      externalLatencyMs: 0,
      diagnostic: "no objects",
    };
  }

  // Resolve the PRIMARY purchased object (highest extension). Multi-
  // object cases (like TORO + bundled SEAT) are represented via each
  // object's own candidate set, but the resolution decision focuses
  // on the primary — the object with the material capital-vs-operating
  // implication.
  const primary = [...objects].sort((a, b) => (b.extension ?? 0) - (a.extension ?? 0))[0];

  // Step 1: internal candidate generation from the primary object.
  const candidates = generateCandidates(primary, objects);

  // Step 2: score each candidate on internal evidence.
  for (const c of candidates) {
    c.internalEvidenceScore = scoreInternalEvidence(c, primary, objects);
  }

  // Step 3: price plausibility (interface — always safe, defaults to
  // UNKNOWN when no provider or no reference data).
  if (input.pricePlausibilityProvider && primary.unitPrice != null) {
    for (const c of candidates) {
      const band = await input.pricePlausibilityProvider.classify({
        objectType: c.objectType,
        brandCandidates: c.brandCandidates.map((b) => b.detail),
        modelCandidates: c.modelCandidates.map((m) => m.detail),
        observedUnitPrice: primary.unitPrice,
        currency: null,   // caller supplies when known
        quantity: primary.quantity ?? 1,
        unit: primary.unit ?? null,
      });
      c.pricePlausibilityBand = band.band;
      c.pricePlausibilityScore = weightForBand(band.band);
      c.supportingEvidence.push({
        kind: "price_plausibility",
        strength: "medium",
        detail: `band=${band.band} price=${primary.unitPrice}${band.reason ? " reason=" + band.reason : ""}`,
      });
    }
  }

  // Step 4: does the internal + price-plausibility state resolve?
  const combined = candidates.map((c) => ({
    c,
    total: c.internalEvidenceScore + (c.pricePlausibilityScore ?? 0),
  })).sort((a, b) => b.total - a.total);

  const top = combined[0];
  const second = combined[1] ?? { c: null, total: 0 };
  const internalGap = top.total - second.total;
  // Slice 5.5 §10 amended trigger: material capital ambiguity fires
  // when BOTH conditions hold:
  //   (A) competing candidate object types would produce materially
  //       different accounting treatment (durable vs component OR
  //       durable vs consumable OR capital-install vs service etc.);
  //   AND
  //   (B) either (i) top-two candidates are close on relative gap OR
  //             (ii) the top candidate's ABSOLUTE score is below
  //                  the identity-confidence-for-material-decision
  //                  threshold.
  // A wide relative gap between two weak candidates does not mean
  // the purchased object has been strongly identified.
  const isDurable = (t: ProductObjectType) => t === "COMPLETE_MACHINE";
  const isComponentOrRepair = (t: ProductObjectType) =>
    t === "REPLACEMENT_ENGINE" || t === "SERIALIZED_COMPONENT" || t === "REPLACEMENT_COMPONENT";
  const isConsumable = (t: ProductObjectType) => t === "CONSUMABLE";
  const isService = (t: ProductObjectType) => t === "SERVICE";
  // Material accounting divergence: any two candidates whose object
  // types would yield different capital / operating / repair
  // treatments qualify.
  const materialDivergentPair = (a: ProductObjectType, b: ProductObjectType): boolean => {
    // durable vs component/consumable/service — always material
    if (isDurable(a) && (isComponentOrRepair(b) || isConsumable(b) || isService(b))) return true;
    if (isDurable(b) && (isComponentOrRepair(a) || isConsumable(a) || isService(a))) return true;
    // component vs consumable — different accounting treatment
    if (isComponentOrRepair(a) && isConsumable(b)) return true;
    if (isComponentOrRepair(b) && isConsumable(a)) return true;
    return false;
  };
  // "In-band" candidates for the relative-gap check.
  const inBand = combined.filter((x) => (top.total - x.total) < MATERIAL_AMBIGUITY_MIN_GAP);
  const relativeCandidateAmbiguity = inBand.some((x) =>
    x !== top && materialDivergentPair(top.c.objectType, x.c.objectType),
  );
  // Absolute-confidence check: if the top score is under this
  // threshold AND ANY other candidate is materially divergent, the
  // identity is not strongly established even at wide relative gap.
  const IDENTITY_CONFIDENCE_FOR_MATERIAL_DECISION = 45;
  const absoluteIdentityBelowThreshold = top.total < IDENTITY_CONFIDENCE_FOR_MATERIAL_DECISION
    && candidates.some((c) => materialDivergentPair(top.c.objectType, c.objectType));
  const materialAmbiguity = relativeCandidateAmbiguity || absoluteIdentityBelowThreshold;

  let externalLookupCount = 0;
  let externalLatencyMs = 0;
  let externalResults: ProductReferenceResult | null = null;

  if (materialAmbiguity && input.productReferenceProvider != null) {
    // Step 5: consult external product-reference provider (§7).
    const cap = input.externalCallCap ?? 2;
    const budgetMs = input.externalTimeoutMs ?? 8000;
    const started = Date.now();
    try {
      externalResults = await withTimeout(
        input.productReferenceProvider.resolve({
          brandCandidates: primary.brandCandidates.map((b) => b.value),
          modelCandidates: primary.modelCandidates.map((m) => m.value),
          skuCandidates: primary.skuCandidates.map((s) => s.value),
          serialCandidates: primary.serialCandidates.map((s) => s.value),
          descriptionExcerpt: primary.description.slice(0, 200),
          observedUnitPrice: primary.unitPrice ?? null,
          currency: null,
          maxCalls: cap,
        }),
        budgetMs,
      );
      externalLookupCount = externalResults?.callCount ?? 0;
      externalLatencyMs = Date.now() - started;
    } catch (err) {
      externalLatencyMs = Date.now() - started;
      externalResults = {
        state: "TIMEOUT",
        callCount: 0,
        products: [],
        prices: [],
        diagnostic: `external lookup exceeded ${budgetMs}ms: ${err instanceof Error ? err.message : "unknown"}`,
      };
    }

    // Apply external evidence per candidate.
    if (externalResults?.state === "RESOLVED" || externalResults?.state === "PARTIAL") {
      for (const c of candidates) {
        c.externalEvidenceScore = scoreExternalEvidence(c, externalResults);
      }
    }
  }

  // Final ranking incorporates external evidence when present.
  const finalRanked = candidates.map((c) => ({
    c,
    total: c.internalEvidenceScore + (c.pricePlausibilityScore ?? 0) + (c.externalEvidenceScore ?? 0),
  })).sort((a, b) => b.total - a.total);

  const finalTop = finalRanked[0];
  const finalSecond = finalRanked[1] ?? { c: null, total: 0 };
  const finalGap = finalTop.total - finalSecond.total;
  const externallyResolved = externalLookupCount > 0
    && externalResults != null
    && (externalResults.state === "RESOLVED" || externalResults.state === "PARTIAL")
    && finalGap >= EXTERNAL_GAP_MIN;

  let status: IdentityStatus;
  let confidence: number;
  let reason: string;
  let selected: ProductIdentityCandidate | null = null;

  if (finalTop.total < INTERNAL_COMMIT_MIN) {
    status = "UNRESOLVED";
    confidence = Math.min(30, finalTop.total);
    reason = `insufficient evidence: top=${finalTop.c.objectType}(${finalTop.total}) < commit floor ${INTERNAL_COMMIT_MIN}`;
  } else if (externallyResolved) {
    status = "RESOLVED_WITH_EXTERNAL_CORROBORATION";
    confidence = Math.min(95, finalTop.total + Math.min(5, finalGap));
    reason = `external corroboration resolved ambiguity — ${finalTop.c.objectType} (internal=${finalTop.c.internalEvidenceScore}, external=${finalTop.c.externalEvidenceScore ?? 0}, gap=${finalGap})`;
    selected = finalTop.c;
  } else if (finalGap >= INTERNAL_GAP_MIN && !materialAmbiguity) {
    status = "RESOLVED_INTERNAL";
    confidence = Math.min(90, finalTop.total + Math.min(5, finalGap));
    reason = `internal evidence sufficient — ${finalTop.c.objectType} (${finalTop.total}), 2nd=${finalSecond.c?.objectType ?? "-"}(${finalSecond.total})`;
    selected = finalTop.c;
  } else {
    // Materially ambiguous OR gap too small to commit.
    status = "AMBIGUOUS";
    confidence = Math.min(55, finalTop.total);
    reason = materialAmbiguity
      ? `material capital-vs-operating ambiguity: ${finalTop.c.objectType}(${finalTop.total}) vs ${finalSecond.c?.objectType}(${finalSecond.total}) — gap=${finalGap} < ${MATERIAL_AMBIGUITY_MIN_GAP}`
      : `insufficient gap between candidates: gap=${finalGap} < ${INTERNAL_GAP_MIN}`;
  }

  const evidenceQuality: "HIGH" | "MEDIUM" | "LOW" =
    finalTop.total >= 60 ? "HIGH"
      : finalTop.total >= 30 ? "MEDIUM"
      : "LOW";

  const diagnostic = `candidates=${candidates.length} top=${finalTop.c.objectType}(${finalTop.total}) 2nd=${finalSecond.c?.objectType ?? "-"}(${finalSecond.total}) status=${status} externalCalls=${externalLookupCount} externalMs=${externalLatencyMs}`;

  return {
    candidates,
    selected,
    status,
    confidence,
    evidenceQuality,
    reason,
    externalCorroborationRequired: materialAmbiguity && !externallyResolved,
    externalLookupCount,
    externalLatencyMs,
    externalProviderDiagnostic: externalResults?.diagnostic,
    externalEvidence: externalResults?.products?.map((p) => ({
      sourceDomain: p.sourceDomain,
      sourceTitle: p.sourceTitle,
      evidenceType: p.evidenceType,
      matchedManufacturer: p.matchedManufacturer,
      matchedModel: p.matchedModel,
      matchedProductFamily: p.matchedProductFamily,
      confidence: p.confidence,
      evidenceSnippet: p.evidenceSnippet,
    })),
    diagnostic,
  };
}

// -----------------------------------------------------------------------------
// Candidate generation (§2, §4)
// -----------------------------------------------------------------------------

function generateCandidates(
  primary: PurchasedObjectIdentity,
  allObjects: PurchasedObjectIdentity[],
): ProductIdentityCandidate[] {
  const desc = primary.description;
  const candidates: ProductIdentityCandidate[] = [];

  const hasCompleteVocab = COMPLETE_MACHINE_VOCAB.test(desc);
  const hasAssemblyBody = ASSEMBLY_BODY_VOCAB.test(desc);
  const hasComponentVocab = REPAIR_KIT_VOCAB.test(desc);
  const hasAccessoryVocab = ACCESSORY_VOCAB.test(desc);
  const hasConsumableVocab = CONSUMABLE_VOCAB.test(desc);
  const hasServiceVocab = SERVICE_VOCAB.test(desc);
  const hasReplacementLang = REPLACEMENT_LANG.test(desc);
  const hasMultipleBrands = primary.brandCandidates.length >= 2;

  const base = (objectType: ProductObjectType): ProductIdentityCandidate => ({
    objectType,
    manufacturerCandidates: primary.brandCandidates.map((b) => ({
      kind: b.provenance, strength: b.strength as EvidenceStrength, detail: b.value,
    })),
    brandCandidates: primary.brandCandidates.map((b) => ({
      kind: b.provenance, strength: b.strength as EvidenceStrength, detail: b.value,
    })),
    modelCandidates: primary.modelCandidates.map((m) => ({
      kind: m.provenance, strength: m.strength as EvidenceStrength, detail: m.value,
    })),
    partNumberCandidates: [],   // populated by external provider
    skuCandidates: primary.skuCandidates.map((s) => ({
      kind: s.provenance, strength: s.strength as EvidenceStrength, detail: s.value,
    })),
    serialCandidates: primary.serialCandidates.map((s) => ({
      kind: s.provenance, strength: s.strength as EvidenceStrength, detail: s.value,
    })),
    relationshipToOtherObjects: primary.relatedObjects,
    internalEvidenceScore: 0,
    supportingEvidence: [],
    contradictions: [],
    reason: "",
    sourceObjectIndex: primary.sourceLineItemIndex,
  });

  // A COMPLETE_MACHINE candidate — emitted when the description
  // contains an outer-machine noun OR the row is high-value + serial
  // + qty=1 + brand+model (structural complete-purchase signature).
  if (hasCompleteVocab || (primary.serialCandidates.length > 0 && primary.brandCandidates.length > 0 && primary.modelCandidates.length > 0 && (primary.quantity ?? 0) === 1)) {
    candidates.push(base("COMPLETE_MACHINE"));
  }

  // A REPLACEMENT_ENGINE candidate — emitted when assembly-body vocab
  // is present. Even without explicit "replacement" language, an
  // engine/transmission body word CAN be a replacement-only
  // interpretation and internal evidence alone often cannot decide.
  if (hasAssemblyBody) {
    candidates.push(base("REPLACEMENT_ENGINE"));
  }

  // A SERIALIZED_COMPONENT candidate — emitted when there's a serial
  // AND an assembly-body or generic-component vocab.
  if (primary.serialCandidates.length > 0 && (hasAssemblyBody || hasComponentVocab)) {
    candidates.push(base("SERIALIZED_COMPONENT"));
  }

  if (hasComponentVocab && !hasCompleteVocab && !hasAssemblyBody) {
    candidates.push(base("REPLACEMENT_COMPONENT"));
  }
  if (hasAccessoryVocab && !hasCompleteVocab && (primary.extension === 0 || primary.extension == null)) {
    candidates.push(base("ACCESSORY"));
  }
  if (hasConsumableVocab) {
    candidates.push(base("CONSUMABLE"));
  }
  if (hasServiceVocab) {
    candidates.push(base("SERVICE"));
  }
  if (candidates.length === 0) {
    candidates.push(base("UNKNOWN"));
  }

  // Attach the discovery flags as evidence hooks so downstream
  // scoring can reference them; scoring functions also re-derive
  // where needed.
  for (const c of candidates) {
    if (hasMultipleBrands) {
      c.supportingEvidence.push({
        kind: "multiple_brands_in_description",
        strength: "medium",
        detail: primary.brandCandidates.map((b) => b.value).join(" + "),
      });
    }
    if (hasReplacementLang && c.objectType === "REPLACEMENT_ENGINE") {
      c.supportingEvidence.push({
        kind: "replacement_language",
        strength: "strong",
        detail: "explicit replacement wording",
      });
    }
    if (hasReplacementLang && c.objectType === "COMPLETE_MACHINE") {
      c.contradictions.push({
        kind: "replacement_language",
        strength: "strong",
        detail: "replacement wording contradicts complete-machine reading",
      });
    }
  }

  // Bundled-accessory context (§5, §24). If any OTHER object in the
  // set is a zero-cost ACCESSORY BUNDLED_WITH this primary, treat as
  // supporting evidence for COMPLETE_MACHINE and contradicting for
  // REPLACEMENT_ENGINE.
  const bundledAccessoryPresent = allObjects.some((o) =>
    o.sourceLineItemIndex !== primary.sourceLineItemIndex
    && o.relatedObjects.some((r) => r.kind === "BUNDLED_WITH" && r.targetIndex === primary.sourceLineItemIndex)
    && (o.extension === 0 || o.extension == null),
  );
  if (bundledAccessoryPresent) {
    for (const c of candidates) {
      if (c.objectType === "COMPLETE_MACHINE") {
        c.supportingEvidence.push({
          kind: "bundled_zero_cost_accessory",
          strength: "medium",
          detail: "another zero-cost line shares model / BUNDLED_WITH this row — package-purchase pattern",
        });
      } else if (c.objectType === "REPLACEMENT_ENGINE" || c.objectType === "SERIALIZED_COMPONENT" || c.objectType === "REPLACEMENT_COMPONENT") {
        c.contradictions.push({
          kind: "bundled_zero_cost_accessory",
          strength: "medium",
          detail: "bundled accessory contradicts single-component-only reading",
        });
      }
    }
  }

  return candidates;
}

// -----------------------------------------------------------------------------
// Internal scoring (§3)
// -----------------------------------------------------------------------------

function scoreInternalEvidence(
  c: ProductIdentityCandidate,
  primary: PurchasedObjectIdentity,
  _allObjects: PurchasedObjectIdentity[],
): number {
  let score = 0;
  const desc = primary.description;

  switch (c.objectType) {
    case "COMPLETE_MACHINE": {
      if (COMPLETE_MACHINE_VOCAB.test(desc)) score += W_COMPLETE_VOCAB;
      if (primary.brandCandidates.length > 0 && primary.modelCandidates.length > 0
          && primary.unit && /^(EA|EACH)$/i.test(primary.unit)
          && (primary.quantity ?? 0) === 1) {
        score += W_MODEL_AND_BRAND_EA;
      }
      if (primary.serialCandidates.length > 0) score += W_SERIAL_PRESENT;
      if (c.supportingEvidence.some((e) => e.kind === "bundled_zero_cost_accessory")) {
        score += W_BUNDLED_ACCESSORY_CONTEXT;
      }
      if (c.contradictions.some((e) => e.kind === "replacement_language")) {
        score -= W_REPLACEMENT_LANG;
      }
      break;
    }
    case "REPLACEMENT_ENGINE":
    case "SERIALIZED_COMPONENT": {
      if (ASSEMBLY_BODY_VOCAB.test(desc)) score += W_ASSEMBLY_BODY_VOCAB;
      if (primary.serialCandidates.length > 0) score += W_SERIAL_PRESENT;
      if (c.supportingEvidence.some((e) => e.kind === "replacement_language")) {
        score += W_REPLACEMENT_LANG;
      }
      if (c.contradictions.some((e) => e.kind === "bundled_zero_cost_accessory")) {
        score -= W_BUNDLED_ACCESSORY_CONTEXT;
      }
      break;
    }
    case "REPLACEMENT_COMPONENT": {
      if (REPAIR_KIT_VOCAB.test(desc)) score += W_COMPONENT_VOCAB;
      break;
    }
    case "ACCESSORY": {
      if (ACCESSORY_VOCAB.test(desc)) score += W_ACCESSORY_VOCAB;
      if (primary.extension === 0 || primary.extension == null) score += W_ZERO_COST_ACCESSORY;
      break;
    }
    case "CONSUMABLE": {
      if (CONSUMABLE_VOCAB.test(desc)) score += W_CONSUMABLE_VOCAB;
      break;
    }
    case "SERVICE": {
      if (SERVICE_VOCAB.test(desc)) score += W_SERVICE_VOCAB;
      break;
    }
    case "UNKNOWN": {
      break;
    }
  }
  return score;
}

function scoreExternalEvidence(
  c: ProductIdentityCandidate,
  results: ProductReferenceResult,
): number {
  let score = 0;
  for (const p of results.products) {
    const matches = c.brandCandidates.some((b) => b.detail.toLowerCase() === (p.matchedManufacturer ?? "").toLowerCase())
      || c.modelCandidates.some((m) => m.detail.toLowerCase() === (p.matchedModel ?? "").toLowerCase())
      || c.skuCandidates.some((s) => s.detail === p.matchedPartNumber);
    if (!matches) continue;

    if (p.evidenceType === "OEM_PRODUCT_MATCH") score += W_EXTERNAL_OEM_MATCH;
    else if (p.evidenceType === "OEM_PART_MATCH") score += W_EXTERNAL_PART_MATCH;
    else if (p.evidenceType === "OEM_SPECIFICATION") score += W_EXTERNAL_PRODUCT_FAMILY_MATCH;
    else if (p.evidenceType === "AUTHORIZED_DEALER_MATCH") score += W_EXTERNAL_PRODUCT_FAMILY_MATCH;

    if (p.matchedProductFamily) {
      c.supportingEvidence.push({
        kind: "external_product_family",
        strength: "strong",
        detail: `${p.evidenceType}: ${p.matchedManufacturer ?? "?"} ${p.matchedModel ?? "?"} → family=${p.matchedProductFamily} source=${p.sourceDomain ?? "?"}`,
      });
      // Product-family match strongly supports COMPLETE_MACHINE if
      // family names describe complete-equipment categories.
      if (c.objectType === "COMPLETE_MACHINE" && /mower|tractor|vehicle|equipment|machine/i.test(p.matchedProductFamily)) {
        score += W_EXTERNAL_PRODUCT_FAMILY_MATCH;
      }
    }
  }
  // Market-comparable price evidence.
  for (const p of results.prices) {
    if (p.observedPrice != null) {
      score += W_EXTERNAL_MARKET_COMPARABLE;
      c.supportingEvidence.push({
        kind: "external_market_comparable",
        strength: "weak",
        detail: `market ${p.currency ?? ""} ${p.observedPrice} from ${p.sourceDomain ?? "?"} (observed ${p.retrievedAt ?? "unknown"})`,
      });
    }
  }
  return score;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function weightForBand(band: PricePlausibilityBand): number {
  switch (band) {
    case "PLAUSIBLE": return W_PRICE_PLAUSIBILITY_PLAUSIBLE;
    case "HIGH":
    case "LOW":       return W_PRICE_PLAUSIBILITY_HIGH_OR_LOW;
    case "VERY_HIGH":
    case "VERY_LOW":  return W_PRICE_PLAUSIBILITY_VERY_HIGH_OR_LOW;
    case "UNKNOWN":   return 0;
  }
}

function isMaterialCapitalDivergence(a: ProductObjectType, b: ProductObjectType): boolean {
  const isDurable = (t: ProductObjectType) => t === "COMPLETE_MACHINE";
  const isComponentOrRepair = (t: ProductObjectType) =>
    t === "REPLACEMENT_ENGINE" || t === "SERIALIZED_COMPONENT" || t === "REPLACEMENT_COMPONENT";
  return (isDurable(a) && isComponentOrRepair(b)) || (isDurable(b) && isComponentOrRepair(a));
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]);
}
