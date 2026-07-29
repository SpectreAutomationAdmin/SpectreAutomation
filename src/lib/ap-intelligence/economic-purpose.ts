// Sprint 3 · Checkpoint 15Q (2026-07-28) — economic-purpose
// classifier.
//
// Founder rule: the classifier must reason about what the
// expenditure IS FOR, not just whether a keyword matches. Two
// concrete failure modes the pre-15Q code produced:
//
//   • A membership invoice from a professional body ("Chartered
//     Professional Accountants") was classified as external
//     accounting services because "CPA" appeared in a
//     `PROFESSIONAL` keyword regex. The economic purpose is
//     professional-membership dues.
//   • A member paying club dues has direction of payment REVERSED
//     from a club paying a vendor. Same "member dues" wording,
//     opposite accounting treatment.
//
// This classifier returns a ranked list of economic-purpose
// concepts with supporting + contradicting evidence. The GL
// recommender consumes it and maps concepts → concrete accounts on
// the tenant's chart. No account numbers are hardcoded here.
//
// GENERALIZED — no invoice-specific rules. The concept catalog is
// intentionally small and each concept has multiple positive +
// negative signals. New concepts are added by extending the
// catalog; no per-invoice branches.

export type EconomicPurpose =
  | "employee_professional_membership_dues"
  | "external_accounting_or_audit_services"
  | "professional_education_training"
  | "licences_and_certifications"
  | "regulatory_fees"
  | "penalties_and_late_fees"
  | "member_dues_charged_by_club"          // REVENUE — club receives dues from members
  | "employee_reimbursement"
  | "legal_or_consulting_services"
  | "recurring_communications_or_connectivity_service"  // Sprint 3 · Checkpoint 15T — telecom / internet / SaaS subscriptions
  | "recurring_utility_or_facility_service"             // Sprint 3 · Checkpoint 15T — electricity / gas / water / waste
  | "generic_supplies_or_services";        // fallback

export type PaymentDirection =
  | "club_pays_vendor"                     // AP expense
  | "member_pays_club"                     // AR revenue
  | "unknown";

// Sprint 3 · Checkpoint 15T — evidence strength differentiates
// where a signal came from. Founder rule (§4):
//   * extracted line-item description → STRONG
//   * structured section/context      → MEDIUM
//   * repeated document phrase        → MEDIUM
//   * supplier identity               → WEAK supporting context
//   * email sender / filename         → NOT DETERMINATIVE
// A single weak phrase must not determine the GL.
export type EvidenceStrength = "strong" | "medium" | "weak";

export interface PurposeEvidence {
  kind: string;
  detail?: string;
  strength?: EvidenceStrength;
}

export interface PurposeCandidate {
  purpose: EconomicPurpose;
  score: number;
  supporting: PurposeEvidence[];
  contradicting: PurposeEvidence[];
  suggestedAccountRoles: string[];         // e.g. ["EMPLOYEE_MEMBERSHIP_DUES", "PROFESSIONAL_DEVELOPMENT"]
  classificationConcept: string;           // human-readable label for the card
}

export interface EconomicPurposeInput {
  supplierName: string | null;
  lineDescriptions: string[];
  // Sprint 3 · Checkpoint 15T — full-document text. Used ONLY to
  // surface characteristic phrases (billing cycle, ongoing charges,
  // internet speeds, member dues, penalty). Each phrase counts as
  // MEDIUM evidence — strictly weaker than a line-item description.
  fullDocumentText?: string | null;
  paymentDirection: PaymentDirection;
  hasPenaltyLine: boolean;
  hasMembershipLine: boolean;
  hasProfessionalCredentialContext: boolean;   // supplier appears to be a licensing body
}

// -----------------------------------------------------------------------------
// Concept catalog — a small, documented set of concepts. Extending
// this catalog is the intended way to add new economic-purpose
// coverage. Each concept has ≥2 supporting signals + ≥1
// contradicting signal to prevent single-keyword mis-classification.
// -----------------------------------------------------------------------------

interface ConceptRule {
  purpose: EconomicPurpose;
  classificationConcept: string;
  // Direction of payment expected for this concept.
  expectedDirection: PaymentDirection;
  // Positive signals — functions that inspect the input and return
  // matched evidence (or null).
  supporting: Array<(input: EconomicPurposeInput) => PurposeEvidence | null>;
  // Contradicting signals — if any fire, subtract from score.
  contradicting: Array<(input: EconomicPurposeInput) => PurposeEvidence | null>;
  // Suggested Chart-of-Accounts role tags. The GL recommender
  // maps these to concrete accounts using the tenant's COA. This
  // catalog does NOT hardcode account numbers.
  suggestedAccountRoles: string[];
}

// Small helper — matches ANY line-description against a regex.
// Line-description evidence is STRONG (§4).
function anyLineMatches(re: RegExp) {
  return (input: EconomicPurposeInput): PurposeEvidence | null => {
    const hit = input.lineDescriptions.find((d) => re.test(d));
    return hit ? { kind: "line_description_match", detail: hit.slice(0, 80), strength: "strong" } : null;
  };
}
// Sprint 3 · Checkpoint 15T — full-document phrase match. Weaker
// than line-item evidence (MEDIUM). Used when line-item extraction
// is sparse but the document body contains characteristic phrases.
function documentPhraseMatches(re: RegExp, kind: string) {
  return (input: EconomicPurposeInput): PurposeEvidence | null => {
    if (!input.fullDocumentText) return null;
    const m = input.fullDocumentText.match(re);
    return m ? { kind, detail: m[0].slice(0, 80), strength: "medium" } : null;
  };
}
// Sprint 3 · Checkpoint 15T — supplier-identity evidence is WEAK.
function supplierMatches(re: RegExp, kind: string) {
  return (input: EconomicPurposeInput): PurposeEvidence | null => {
    if (input.supplierName && re.test(input.supplierName)) {
      return { kind, detail: input.supplierName, strength: "weak" };
    }
    return null;
  };
}
function directionIs(direction: PaymentDirection, kind: string, strength: EvidenceStrength = "weak") {
  return (input: EconomicPurposeInput): PurposeEvidence | null =>
    (input.paymentDirection === direction ? { kind, strength } : null);
}
function flagIs<K extends keyof EconomicPurposeInput>(flag: K, val: EconomicPurposeInput[K], kind: string, strength: EvidenceStrength = "medium") {
  return (input: EconomicPurposeInput): PurposeEvidence | null =>
    (input[flag] === val ? { kind, strength } : null);
}

// Concept catalog. Order does not matter — every rule is evaluated.
const CONCEPT_CATALOG: ConceptRule[] = [
  // --- Employee professional membership dues -----------------------
  // Supplier is a licensing / professional body (association,
  // college, institute) AND the club is paying it AND the invoice
  // mentions membership / dues / annual fee. Direction is club→vendor.
  {
    purpose: "employee_professional_membership_dues",
    classificationConcept: "Employee professional membership dues",
    expectedDirection: "club_pays_vendor",
    supporting: [
      flagIs("hasProfessionalCredentialContext", true, "supplier_is_professional_body"),
      flagIs("hasMembershipLine", true, "invoice_line_names_membership"),
      supplierMatches(/\b(?:association|society|college|institute|order\s+of|academy|federation|chartered|professional)\b/i, "supplier_professional_body_language"),
      anyLineMatches(/\b(?:annual\s+dues|membership\s+dues|member(?:ship)?\s+fee|professional\s+dues|licens[ec]\s+fee)\b/i),
      directionIs("club_pays_vendor", "direction_expense"),
      // Sprint 3 · Checkpoint 15T — document-phrase signals (§4
      // "structured section / context" = medium). Catches the shape
      // where line items are extracted as e.g. "[ACRONYM] [Region]
      // Fee" but the body of the document literally says "Member
      // Dues for [Name]" or "Annual dues". No vendor allowlist.
      documentPhraseMatches(/\b(?:member(?:ship)?|annual|professional)\s+(?:dues|fee|application)\b/i, "phrase_dues_or_fee"),
      documentPhraseMatches(/\bmember\s+dues\b/i, "phrase_member_dues"),
    ],
    contradicting: [
      // Direction reversal is architecturally definitive — a member
      // paying the club is REVENUE, not an employee expense (§4).
      directionIs("member_pays_club", "direction_reversed", "strong"),
      // Pure external service invoice (audit, tax return) has these
      // words which we treat as a strong CONTRA.
      anyLineMatches(/\b(?:audit\s+services|tax\s+return\s+preparation|financial\s+statement\s+preparation|bookkeeping\s+services)\b/i),
    ],
    suggestedAccountRoles: ["EMPLOYEE_MEMBERSHIP_DUES", "PROFESSIONAL_DEVELOPMENT", "TRAINING_AND_DUES"],
  },

  // --- External accounting or audit services -----------------------
  // Supplier is an accounting FIRM (partnership / LLP naming) AND
  // the invoice lines describe deliverables (audit, review, tax
  // return, engagement). NOT membership dues.
  {
    purpose: "external_accounting_or_audit_services",
    classificationConcept: "External accounting or audit services",
    expectedDirection: "club_pays_vendor",
    supporting: [
      supplierMatches(/\b(?:LLP|Chartered\s+Accountants|Accounting|Auditors?)\b(?![\s\S]{0,30}(?:Association|Society|Institute))/i, "supplier_accounting_firm"),
      anyLineMatches(/\b(?:audit\s+services|review\s+engagement|tax\s+return|financial\s+statement\s+preparation|bookkeeping|compilation)\b/i),
      directionIs("club_pays_vendor", "direction_expense"),
    ],
    contradicting: [
      // Membership dues language contradicts external services.
      flagIs("hasMembershipLine", true, "line_is_membership"),
      flagIs("hasProfessionalCredentialContext", true, "supplier_is_licensing_body"),
    ],
    suggestedAccountRoles: ["ACCOUNTING_AND_AUDIT_FEES", "PROFESSIONAL_FEES"],
  },

  // --- Member dues charged by the club (REVENUE) -------------------
  // Direction reversed: a member is paying the club. Line mentions
  // annual dues / initiation / member fees.
  {
    purpose: "member_dues_charged_by_club",
    classificationConcept: "Member dues (club revenue)",
    expectedDirection: "member_pays_club",
    supporting: [
      directionIs("member_pays_club", "direction_revenue"),
      anyLineMatches(/\b(?:annual\s+dues|monthly\s+dues|initiation\s+fee|assessment|capital\s+dues)\b/i),
    ],
    contradicting: [
      directionIs("club_pays_vendor", "direction_expense"),
      flagIs("hasProfessionalCredentialContext", true, "supplier_professional_body"),
    ],
    suggestedAccountRoles: ["MEMBER_DUES_REVENUE", "MEMBERSHIP_REVENUE"],
  },

  // --- Penalties and late fees -------------------------------------
  {
    purpose: "penalties_and_late_fees",
    classificationConcept: "Penalties and late fees",
    expectedDirection: "unknown",
    supporting: [
      flagIs("hasPenaltyLine", true, "penalty_line_present"),
      anyLineMatches(/\b(?:penalty|late[-\s]?fee|late[-\s]?payment|finance\s+charge|interest\s+charge|NSF|returned\s+cheque)\b/i),
    ],
    contradicting: [
      anyLineMatches(/\b(?:membership\s+dues|professional\s+dues)\b/i),
    ],
    suggestedAccountRoles: ["INTEREST_AND_PENALTIES", "BANK_CHARGES"],
  },

  // --- Professional education / training ---------------------------
  {
    purpose: "professional_education_training",
    classificationConcept: "Professional education and training",
    expectedDirection: "club_pays_vendor",
    supporting: [
      anyLineMatches(/\b(?:seminar|conference|course|training|continuing\s+education|CPE|CEU|workshop)\b/i),
    ],
    contradicting: [
      flagIs("hasMembershipLine", true, "membership_dominant"),
    ],
    suggestedAccountRoles: ["TRAINING_AND_EDUCATION", "PROFESSIONAL_DEVELOPMENT"],
  },

  // --- Licences and certifications ---------------------------------
  {
    purpose: "licences_and_certifications",
    classificationConcept: "Licences and certifications",
    expectedDirection: "club_pays_vendor",
    supporting: [
      anyLineMatches(/\b(?:licens[ec]|certificat(?:e|ion)|permit|registration\s+fee|renewal)\b/i),
    ],
    contradicting: [
      flagIs("hasMembershipLine", true, "membership_dominant"),
    ],
    suggestedAccountRoles: ["LICENCES_AND_PERMITS", "REGULATORY_FEES"],
  },

  // --- Legal or consulting services --------------------------------
  {
    purpose: "legal_or_consulting_services",
    classificationConcept: "Legal or consulting services",
    expectedDirection: "club_pays_vendor",
    supporting: [
      supplierMatches(/\b(?:law|legal|attorneys?|counsel|barristers?|solicitors?|LLP)\b/i, "supplier_law_firm"),
      anyLineMatches(/\b(?:legal\s+services|consulting|retainer|advisory)\b/i),
    ],
    contradicting: [
      flagIs("hasMembershipLine", true, "membership_dominant"),
    ],
    suggestedAccountRoles: ["LEGAL_FEES", "CONSULTING_FEES", "PROFESSIONAL_FEES"],
  },

  // --- Recurring communications / connectivity service --------------
  // Sprint 3 · Checkpoint 15T — telecom / internet / SaaS-style
  // recurring statements. Characteristic phrases: billing cycle,
  // ongoing charges, monthly service, upload/download speeds, plan.
  // No vendor-name allowlist — the signals must come from the
  // document itself.
  {
    purpose: "recurring_communications_or_connectivity_service",
    classificationConcept: "Recurring communications or connectivity service",
    expectedDirection: "club_pays_vendor",
    supporting: [
      anyLineMatches(/\b(?:ongoing\s+charges|monthly\s+service|internet|broadband|fibre|fiber|mobile|cellular|VoIP|SaaS|subscription|hosting|domain|managed\s+service)\b/i),
      documentPhraseMatches(/\bbilling\s+cycle\b/i, "phrase_billing_cycle"),
      documentPhraseMatches(/\bongoing\s+charges\b/i, "phrase_ongoing_charges"),
      documentPhraseMatches(/\b\d{1,4}\s*(?:mbit|mbps|Mb\/s|gbit|gbps|Gb\/s|kbps)\b/i, "phrase_bandwidth_units"),
      documentPhraseMatches(/\b(?:upload|download)\s*speed\b/i, "phrase_speed_column"),
      documentPhraseMatches(/\bpending\s+payments\b/i, "phrase_pending_payments"),
      documentPhraseMatches(/\brecurring\b/i, "phrase_recurring"),
    ],
    contradicting: [
      flagIs("hasMembershipLine", true, "line_is_membership"),
      flagIs("hasProfessionalCredentialContext", true, "supplier_is_professional_body"),
      anyLineMatches(/\b(?:audit\s+services|tax\s+return|legal\s+services|membership\s+dues)\b/i),
    ],
    suggestedAccountRoles: [
      "TELECOMMUNICATIONS",
      "INTERNET_AND_CONNECTIVITY",
      "COMMUNICATIONS_EXPENSE",
      "IT_SUBSCRIPTIONS",
      "SOFTWARE_SUBSCRIPTIONS",
    ],
  },

  // --- Recurring utility / facility service -------------------------
  // Electricity / gas / water / waste / sanitation — characteristic
  // phrases include consumption units (kWh, m³, GJ) and utility
  // vocabulary (meter, service address, delivery charge).
  {
    purpose: "recurring_utility_or_facility_service",
    classificationConcept: "Recurring utility or facility service",
    expectedDirection: "club_pays_vendor",
    supporting: [
      anyLineMatches(/\b(?:electricity|hydro|natural\s+gas|water|sewer|waste|sanitation|garbage|utilities|delivery\s+charge|distribution\s+charge)\b/i),
      documentPhraseMatches(/\b\d+(?:\.\d+)?\s*(?:kWh|m³|m3|GJ|CCF)\b/i, "phrase_consumption_units"),
      documentPhraseMatches(/\bservice\s+address\b/i, "phrase_service_address"),
      documentPhraseMatches(/\bmeter\s+(?:reading|number)\b/i, "phrase_meter"),
    ],
    contradicting: [
      flagIs("hasMembershipLine", true, "line_is_membership"),
      flagIs("hasProfessionalCredentialContext", true, "supplier_is_professional_body"),
    ],
    suggestedAccountRoles: [
      "UTILITIES",
      "ELECTRICITY",
      "NATURAL_GAS",
      "WATER_AND_SEWER",
      "WASTE_REMOVAL",
    ],
  },

  // --- Generic supplies / services (fallback) ----------------------
  {
    purpose: "generic_supplies_or_services",
    classificationConcept: "Supplier goods or services",
    expectedDirection: "club_pays_vendor",
    supporting: [
      directionIs("club_pays_vendor", "direction_expense"),
    ],
    contradicting: [],
    suggestedAccountRoles: ["GENERAL_EXPENSES"],
  },
];

// Sprint 3 · Checkpoint 15T — strength-differentiated weights.
// Strong evidence outscores medium; medium outscores weak. Contradicts
// are treated at their own tier so a single weak contradiction cannot
// kill a strong supporting stack. Weights are calibrated so a concept
// with three medium signals (fits the founder-observed professional-
// body invoice) OR one strong signal plus supporting context clears
// the gl-recommend boost gate at 60.
const STRENGTH_SUPPORT_WEIGHT: Record<EvidenceStrength, number> = {
  strong: 25,
  medium: 15,
  weak: 8,
};
const STRENGTH_CONTRADICT_WEIGHT: Record<EvidenceStrength, number> = {
  strong: 30,
  medium: 18,
  weak: 8,
};

// -----------------------------------------------------------------------------
// Classifier
// -----------------------------------------------------------------------------

export function classifyEconomicPurpose(input: EconomicPurposeInput): PurposeCandidate[] {
  const candidates: PurposeCandidate[] = [];
  for (const rule of CONCEPT_CATALOG) {
    const supporting: PurposeEvidence[] = [];
    const contradicting: PurposeEvidence[] = [];
    let supportScore = 0;
    let contradictScore = 0;
    for (const s of rule.supporting) {
      const ev = s(input);
      if (ev) {
        supporting.push(ev);
        supportScore += STRENGTH_SUPPORT_WEIGHT[ev.strength ?? "medium"];
      }
    }
    for (const c of rule.contradicting) {
      const ev = c(input);
      if (ev) {
        contradicting.push(ev);
        contradictScore += STRENGTH_CONTRADICT_WEIGHT[ev.strength ?? "medium"];
      }
    }
    const score = supportScore - contradictScore;
    if (score <= 0 && rule.purpose !== "generic_supplies_or_services") continue;
    candidates.push({
      purpose: rule.purpose,
      classificationConcept: rule.classificationConcept,
      suggestedAccountRoles: rule.suggestedAccountRoles,
      supporting, contradicting,
      score,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}
