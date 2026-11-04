// EP-TRAIN-6C-10B — hardened independent grounding validator.
//
// This is the TypeScript port of the EP-TRAIN-6C-10A validator
// (originally at scratchpad/ep-train-6b/gen/grounding-validator-hardened.mjs),
// with no behavioral change. Every error code, advisory flag, and
// semantic rule is preserved verbatim from the accepted 6C-10A baseline.
//
// Invariants (preserved from 6C-10A acceptance):
//   - The validator NEVER trusts the generator's self-reported
//     groundingStatus. It consumes the AUTHORIZED grounding projection
//     and the pilot authorization, and emits its own verdict.
//   - Section-aware: unsupported facts in the AUTHORITATIVE surface
//     (question stem / correct options / explanation) are HARD FAIL;
//     distractor-surface numeric inventions are allowed; regulatory
//     and insurance references anywhere in the proposal are HARD FAIL
//     when unsupported.
//   - Deterministic pattern-based; no LLM call; no network I/O.
//   - The authoritative Lite / Proposal schemas are NOT modified here.

import type {
  GroundingPassage,
  GroundingProjection,
  PilotAuthorizationV1,
  TrainingQuestionProposalV1,
  ValidatorError,
  ValidatorWarning,
} from "./types";
import { PROPOSAL_SCHEMA_VERSION } from "./types";

export type Verdict = "GROUNDED" | "REQUIRES_HUMAN_VERIFICATION" | "REJECTED";

export interface ValidatorResult {
  readonly verdict: Verdict;
  readonly errors: readonly ValidatorError[];
  readonly warnings: readonly ValidatorWarning[];
  readonly flags: readonly string[];
}

export const VALIDATOR_ERRORS = Object.freeze({
  SCHEMA_INVALID: "ERR_PROPOSAL_SCHEMA_INVALID",
  UNSUPPORTED_SCHEMA: "ERR_PROPOSAL_UNSUPPORTED_SCHEMA",
  CITATION_SEGMENT_UNKNOWN: "ERR_CITATION_SEGMENT_UNKNOWN",
  CITATION_SEGMENT_EXCLUDED: "ERR_CITATION_SEGMENT_EXCLUDED",
  CITATION_SEGMENT_UNAUTHORIZED: "ERR_CITATION_SEGMENT_UNAUTHORIZED",
  CITATION_TIMESTAMP_OUT_OF_BOUNDS: "ERR_CITATION_TIMESTAMP_OUT_OF_BOUNDS",
  CITATION_TIMESTAMP_REVERSED: "ERR_CITATION_TIMESTAMP_REVERSED",
  QUOTATION_NOT_IN_SOURCE: "ERR_QUOTATION_NOT_IN_SOURCE",
  QUESTION_TYPE_INVALID: "ERR_QUESTION_TYPE_INVALID",
  OPTION_COUNT_INVALID: "ERR_OPTION_COUNT_INVALID",
  OPTION_DUPLICATE: "ERR_OPTION_DUPLICATE",
  CORRECT_ANSWER_KEY_INVALID: "ERR_CORRECT_ANSWER_KEY_INVALID",
  TRUE_FALSE_SHAPE_INVALID: "ERR_TRUE_FALSE_SHAPE_INVALID",
  ORGANIZATION_SUBSTITUTION: "ERR_ORG_SUBSTITUTION",
  ORGANIZATION_INVENTION: "ERR_ORG_INVENTION",
  PROHIBITED_PASSAGE_CITED: "ERR_PROHIBITED_PASSAGE_CITED",
  PLACEMENT_OUT_OF_SOURCE: "ERR_PLACEMENT_OUT_OF_SOURCE",
  UNSUPPORTED_FACTUAL_YEAR: "ERR_UNSUPPORTED_FACTUAL_YEAR",
  UNSUPPORTED_FACTUAL_DATE: "ERR_UNSUPPORTED_FACTUAL_DATE",
  UNSUPPORTED_FACTUAL_MONEY: "ERR_UNSUPPORTED_FACTUAL_MONEY",
  UNSUPPORTED_FACTUAL_PERCENTAGE: "ERR_UNSUPPORTED_FACTUAL_PERCENTAGE",
  UNSUPPORTED_FACTUAL_DURATION: "ERR_UNSUPPORTED_FACTUAL_DURATION",
  UNSUPPORTED_REGULATORY_BODY: "ERR_UNSUPPORTED_REGULATORY_BODY",
  UNSUPPORTED_INSURANCE_REFERENCE: "ERR_UNSUPPORTED_INSURANCE_REFERENCE",
} as const);

export const VALIDATOR_FLAGS = Object.freeze({
  UNSUPPORTED_ANSWER_WORDS: "FLAG_UNSUPPORTED_ANSWER_WORDS",
  SOURCE_ORG_MISMATCH: "SOURCE_ORG_MISMATCH",
  POTENTIAL_INVENTED_POLICY_TERM: "FLAG_POTENTIAL_INVENTED_POLICY_TERM",
  PROPOSAL_DUPLICATE: "FLAG_PROPOSAL_DUPLICATE",
  AMBIGUOUS_CORRECT_ANSWER: "FLAG_AMBIGUOUS_CORRECT_ANSWER",
  UNSUPPORTED_QUANTITY: "FLAG_UNSUPPORTED_QUANTITY",
  AMBIGUOUS_FACTUAL_CLAIM: "FLAG_AMBIGUOUS_FACTUAL_CLAIM",
} as const);

const STOP_WORDS = new Set([
  "a","an","the","and","or","but","if","then","else","when","while","of","in","on",
  "at","to","for","with","by","from","as","is","are","was","were","be","being",
  "been","do","does","did","not","no","yes","it","its","this","that","these",
  "those","i","you","he","she","we","they","them","their","there","here","what",
  "which","who","whom","how","why","so","than","have","has","had","can","may",
  "will","would","should","could","shall","must","any","all","each","every","some",
  "many","most","more","less","such","our","your","my","his","her","s","t","d","ll","re","ve","m",
]);

const POLICY_SNIFF_TERMS = [
  "mandatory", "disciplinary", "termination", "fired", "written warning",
  "suspension", "immediate termination", "zero tolerance", "osha", "whmis",
  "legal action", "lawsuit",
];

export const KNOWN_SOURCE_ORG_NAMES = ["silver spring", "silver springs"] as const;
export const KNOWN_TENANT_ORG_NAMES = ["coulee ridge", "coulee"] as const;

export const REGULATORY_BODIES = [
  "osha", "nlrb", "eeoc", "ada", "fmla", "flsa", "sec", "ftc", "dot", "dhs",
  "hipaa", "ferpa", "coppa", "sox", "hhs", "fda", "cdc", "irs", "usda", "uscis",
  "whmis", "cra", "revenue canada", "service canada",
  "worksafe", "worksafebc", "worksafe bc", "workers compensation board", "wcb",
  "ohs", "ohsa", "ministry of labour", "ministry of labor",
  "department of labour", "department of labor", "health canada", "esdc", "wsib",
  "gdpr", "ccpa", "pipeda", "cpra",
] as const;

export const INSURANCE_TERMS = [
  "insurance company", "insurance provider", "insurance carrier",
  "insurance policy", "liability insurance", "health insurance",
  "disability insurance", "workers comp insurance", "workers compensation insurance",
] as const;

function fail(
  errors: ValidatorError[],
  code: string,
  message: string,
  detail: Record<string, unknown> = {},
): void {
  errors.push({ code, message, detail });
}

function normaliseWord(w: string): string {
  return String(w).toLowerCase().replace(/[.?!,'"():;$#%&*+/\\\-_=]/g, "");
}

function wordsOf(text: string): string[] {
  return String(text).split(/\s+/).map(normaliseWord).filter((w) => w && !STOP_WORDS.has(w));
}

function lower(s: string): string { return String(s).toLowerCase(); }

function canonicaliseText(s: string): string {
  return lower(s).replace(/[.?!,'"():;$#%&*+/\\\-_=]/g, "").replace(/\s+/g, " ").trim();
}

function indexGroundingPassages(grounding: GroundingProjection): Map<number, GroundingPassage> {
  const map = new Map<number, GroundingPassage>();
  for (const p of grounding.passages || []) {
    for (const sid of p.sourceSegmentIds || []) {
      map.set(sid, p);
    }
  }
  return map;
}

// ---------- Factual-claim extractors (preserved verbatim from 6C-10A) ----------

interface Claim {
  readonly raw: string;
  readonly normalised: string;
  readonly kind: string;
}
interface DurationClaim extends Claim { readonly amount: number; readonly unit: string; }
interface DateClaim extends Claim { readonly month: number; readonly day: number; readonly year: number | null; }
interface QuantityClaim extends Claim { readonly amount: number; readonly noun: string; }

const YEAR_RE = /\b(19\d{2}|20\d{2}|21\d{2})\b/g;
function extractYears(text: string): Claim[] {
  const out: Claim[] = [];
  for (const m of String(text).matchAll(YEAR_RE)) {
    out.push({ raw: m[0], normalised: m[0], kind: "year" });
  }
  return out;
}
function yearSupported(claim: Claim, citedLower: string): boolean {
  const re = new RegExp(`\\b${claim.normalised}\\b`);
  return re.test(citedLower);
}

const MONEY_RE = /\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\b\d{1,3}(?:,\d{3})*(?:\.\d{2})?\s*(?:dollars?|CAD|USD|EUR|GBP)\b/gi;
function extractMoney(text: string): Claim[] {
  const out: Claim[] = [];
  for (const m of String(text).matchAll(MONEY_RE)) {
    const raw = m[0];
    const digits = raw.replace(/[^\d.]/g, "");
    const numeric = Number(digits);
    if (!Number.isFinite(numeric)) continue;
    out.push({ raw, normalised: String(Math.round(numeric * 100)), kind: "money" });
  }
  return out;
}
function moneySupported(claim: Claim, citedText: string): boolean {
  const cents = Number(claim.normalised);
  const integer = String(cents / 100).replace(/\.00$/, "");
  const dec = (cents / 100).toFixed(2);
  const citedLower = citedText.toLowerCase();
  const re1 = new RegExp(`\\$\\s*0*${integer}(?:\\.0{1,2})?\\b`);
  const re2 = new RegExp(`\\$\\s*0*${dec.replace(".", "\\.")}\\b`);
  const re3 = new RegExp(`\\b0*${integer}\\s*(?:dollars?|cad|usd|eur|gbp)\\b`);
  return re1.test(citedLower) || re2.test(citedLower) || re3.test(citedLower);
}

const PERCENT_RE = /\b\d+(?:\.\d+)?\s*%|\b\d+(?:\.\d+)?\s*percent\b/gi;
function extractPercentages(text: string): Claim[] {
  const out: Claim[] = [];
  for (const m of String(text).matchAll(PERCENT_RE)) {
    const raw = m[0];
    const digits = raw.replace(/[^\d.]/g, "");
    const numeric = Number(digits);
    if (!Number.isFinite(numeric)) continue;
    out.push({ raw, normalised: String(numeric), kind: "percent" });
  }
  return out;
}
function percentSupported(claim: Claim, citedText: string): boolean {
  const v = claim.normalised;
  const citedLower = citedText.toLowerCase();
  const re1 = new RegExp(`\\b${v}(?:\\.0+)?\\s*%`);
  const re2 = new RegExp(`\\b${v}(?:\\.0+)?\\s*percent\\b`);
  return re1.test(citedLower) || re2.test(citedLower);
}

const WORD_NUMBER: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};
const WORD_NUMBER_PATTERN = Object.keys(WORD_NUMBER).join("|");

const DURATION_RE = new RegExp(
  `\\b(\\d+(?:\\.\\d+)?|${WORD_NUMBER_PATTERN})\\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\\b`,
  "gi",
);
function extractDurations(text: string): DurationClaim[] {
  const out: DurationClaim[] = [];
  for (const m of String(text).matchAll(DURATION_RE)) {
    const amount = m[1].toLowerCase();
    const unit = m[2].toLowerCase().replace(/s$/, "");
    const n = WORD_NUMBER[amount] ?? Number(amount);
    if (!Number.isFinite(n)) continue;
    out.push({ raw: m[0], normalised: `${n}-${unit}`, kind: "duration", amount: n, unit });
  }
  return out;
}
function durationSupported(claim: DurationClaim, citedText: string): boolean {
  const citedLower = citedText.toLowerCase();
  const digit = String(claim.amount);
  const unit = claim.unit;
  const re1 = new RegExp(`\\b${digit}\\s*${unit}s?\\b`);
  if (re1.test(citedLower)) return true;
  const wordForm = Object.entries(WORD_NUMBER).find(([, v]) => v === claim.amount)?.[0];
  if (wordForm) {
    const re2 = new RegExp(`\\b${wordForm}\\s+${unit}s?\\b`);
    if (re2.test(citedLower)) return true;
  }
  return false;
}

const MONTH_LONG = "january|february|march|april|may|june|july|august|september|october|november|december";
const MONTH_SHORT = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
const MONTH_RE = new RegExp(`\\b(${MONTH_LONG}|${MONTH_SHORT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi");
const NUMERIC_DATE_RE = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b|\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/g;
const MONTH_INDEX: Record<string, number> = {
  january:1, february:2, march:3, april:4, may:5, june:6, july:7, august:8,
  september:9, october:10, november:11, december:12,
  jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12,
};
function extractDates(text: string): DateClaim[] {
  const out: DateClaim[] = [];
  for (const m of String(text).matchAll(MONTH_RE)) {
    const monthRaw = m[1].toLowerCase();
    const month = MONTH_INDEX[monthRaw];
    if (!month) continue;
    const day = Number(m[2]);
    const year = m[3] ? Number(m[3]) : null;
    out.push({
      raw: m[0],
      normalised: year ? `${year}-${month}-${day}` : `${month}-${day}`,
      kind: "date",
      month, day, year,
    });
  }
  for (const m of String(text).matchAll(NUMERIC_DATE_RE)) {
    if (m[4]) {
      out.push({
        raw: m[0],
        normalised: `${Number(m[4])}-${Number(m[5])}-${Number(m[6])}`,
        kind: "date", month: Number(m[5]), day: Number(m[6]), year: Number(m[4]),
      });
    } else {
      const month = Number(m[1]);
      const day = Number(m[2]);
      if (month < 1 || month > 12 || day < 1 || day > 31) continue;
      let year: number | null = m[3] ? Number(m[3]) : null;
      if (year !== null && year < 100) year += 2000;
      out.push({
        raw: m[0],
        normalised: year ? `${year}-${month}-${day}` : `${month}-${day}`,
        kind: "date", month, day, year,
      });
    }
  }
  return out;
}
function dateSupported(claim: DateClaim, citedText: string): boolean {
  // Checks only (month, day). The year, if present, is validated by the
  // Year detector separately. This split prevents a double-fail when the
  // (month, day) component is supported and only the year is invented.
  const citedLower = citedText.toLowerCase();
  const month = claim.month;
  const day = claim.day;
  const monthLongs = Object.entries(MONTH_INDEX).filter(([, v]) => v === month).map(([k]) => k);
  const surfaces: RegExp[] = [];
  for (const m of monthLongs) {
    surfaces.push(new RegExp(`\\b${m}\\.?\\s+${day}(?:st|nd|rd|th)?\\b`));
  }
  surfaces.push(new RegExp(`\\b0?${month}[\\/-]0?${day}\\b`));
  if (claim.year) {
    surfaces.push(new RegExp(`\\b${claim.year}[\\/-]0?${month}[\\/-]0?${day}\\b`));
  }
  return surfaces.some((re) => re.test(citedLower));
}

const QUANTITY_NOUNS = [
  "scholarships?","employees?","checks?","items?","times?","visits?","shifts?",
  "requests?","rounds?","members?","servings?","cards?","drinks?","meals?",
  "customers?","orders?","tickets?","reservations?","complaints?","incidents?",
  "warnings?","chances?","opportunities?","seats?","tables?","hours?","shifts?",
  "staff","guests?","children","hats","copies","items","minutes","slots?","credits?",
];
const QUANTITY_RE = new RegExp(
  `\\b(\\d+|${WORD_NUMBER_PATTERN})\\s+(${QUANTITY_NOUNS.join("|")})\\b`,
  "gi",
);
function extractQuantities(text: string): QuantityClaim[] {
  const out: QuantityClaim[] = [];
  for (const m of String(text).matchAll(QUANTITY_RE)) {
    const amount = m[1].toLowerCase();
    const noun = m[2].toLowerCase();
    const n = WORD_NUMBER[amount] ?? Number(amount);
    if (!Number.isFinite(n)) continue;
    out.push({ raw: m[0], normalised: `${n}-${noun}`, kind: "quantity", amount: n, noun });
  }
  return out;
}
function quantitySupported(claim: QuantityClaim, citedText: string): boolean {
  const citedLower = citedText.toLowerCase();
  const digit = String(claim.amount);
  const nounStem = claim.noun.replace(/s$/, "").slice(0, 6);
  const re1 = new RegExp(`\\b${digit}\\s+\\w*${nounStem}\\w*\\b`);
  if (re1.test(citedLower)) return true;
  const wordForm = Object.entries(WORD_NUMBER).find(([, v]) => v === claim.amount)?.[0];
  if (wordForm) {
    const re2 = new RegExp(`\\b${wordForm}\\s+\\w*${nounStem}\\w*\\b`);
    if (re2.test(citedLower)) return true;
  }
  return false;
}

function extractRegulatoryBodies(text: string): Claim[] {
  const out: Claim[] = [];
  const lowered = String(text).toLowerCase();
  for (const body of REGULATORY_BODIES) {
    const re = new RegExp(`\\b${body.replace(/\s+/g, "\\s+")}\\b`, "g");
    for (const m of lowered.matchAll(re)) {
      out.push({ raw: m[0], normalised: body, kind: "regulatory_body" });
    }
  }
  return out;
}
function regulatoryBodySupported(claim: Claim, citedText: string): boolean {
  const re = new RegExp(`\\b${claim.normalised.replace(/\s+/g, "\\s+")}\\b`);
  return re.test(citedText.toLowerCase());
}

function extractInsuranceReferences(text: string): Claim[] {
  const out: Claim[] = [];
  const lowered = String(text).toLowerCase();
  for (const term of INSURANCE_TERMS) {
    const re = new RegExp(term.replace(/\s+/g, "\\s+"), "g");
    for (const m of lowered.matchAll(re)) {
      out.push({ raw: m[0], normalised: term, kind: "insurance_reference" });
    }
  }
  return out;
}
function insuranceReferenceSupported(claim: Claim, citedText: string): boolean {
  return citedText.toLowerCase().includes(claim.normalised);
}

// ---------- Structural + citation + org + policy checks ----------

function validateStructuralShape(
  proposal: TrainingQuestionProposalV1 | null | undefined,
  errors: ValidatorError[],
): proposal is TrainingQuestionProposalV1 {
  if (!proposal || typeof proposal !== "object") {
    fail(errors, VALIDATOR_ERRORS.SCHEMA_INVALID, "proposal missing or not an object");
    return false;
  }
  if (proposal.schemaVersion !== PROPOSAL_SCHEMA_VERSION) {
    fail(errors, VALIDATOR_ERRORS.UNSUPPORTED_SCHEMA, `proposal.schemaVersion=${proposal.schemaVersion} unsupported`);
    return false;
  }
  const required = [
    "proposalId", "placement", "questionType", "questionText",
    "options", "explanation", "supportingCitations", "groundingStatus", "reviewStatus",
  ] as const;
  for (const k of required) {
    if (!(k in proposal)) {
      fail(errors, VALIDATOR_ERRORS.SCHEMA_INVALID, `missing field: ${k}`);
    }
  }
  if (errors.length) return false;
  if (!["SINGLE_CHOICE", "MULTI_ANSWER", "TRUE_FALSE"].includes(proposal.questionType)) {
    fail(errors, VALIDATOR_ERRORS.QUESTION_TYPE_INVALID, `unsupported questionType ${proposal.questionType}`);
    return false;
  }
  if (!Array.isArray(proposal.options) || proposal.options.length < 2 || proposal.options.length > 6) {
    fail(errors, VALIDATOR_ERRORS.OPTION_COUNT_INVALID, `options length ${proposal.options?.length} out of range`);
    return false;
  }
  if (proposal.reviewStatus !== "PENDING_REVIEW") {
    fail(errors, VALIDATOR_ERRORS.SCHEMA_INVALID, `reviewStatus must be PENDING_REVIEW on generator output; got ${proposal.reviewStatus}`);
  }
  const allowed = new Set<string>(["schemaVersion", ...required]);
  for (const k of Object.keys(proposal)) {
    if (!allowed.has(k)) {
      fail(errors, VALIDATOR_ERRORS.SCHEMA_INVALID, `unexpected top-level field: ${k}`);
    }
  }
  return errors.length === 0;
}

function validateOptionsSanity(proposal: TrainingQuestionProposalV1, errors: ValidatorError[]): void {
  const texts = proposal.options.map((o) => canonicaliseText(o.text));
  const seen = new Set<string>();
  for (const t of texts) {
    if (seen.has(t)) {
      fail(errors, VALIDATOR_ERRORS.OPTION_DUPLICATE, `duplicate option text: "${t}"`);
    }
    seen.add(t);
  }
  const corrects = proposal.options.filter((o) => o.isCorrect === true);
  if (proposal.questionType === "SINGLE_CHOICE") {
    if (corrects.length !== 1) {
      fail(errors, VALIDATOR_ERRORS.CORRECT_ANSWER_KEY_INVALID,
        `SINGLE_CHOICE must have exactly 1 correct option (got ${corrects.length})`);
    }
  } else if (proposal.questionType === "MULTI_ANSWER") {
    if (corrects.length < 2) {
      fail(errors, VALIDATOR_ERRORS.CORRECT_ANSWER_KEY_INVALID,
        `MULTI_ANSWER must have >= 2 correct options (got ${corrects.length})`);
    }
    if (corrects.length === proposal.options.length) {
      fail(errors, VALIDATOR_ERRORS.CORRECT_ANSWER_KEY_INVALID,
        `MULTI_ANSWER must have at least one incorrect option`);
    }
  } else if (proposal.questionType === "TRUE_FALSE") {
    if (proposal.options.length !== 2) {
      fail(errors, VALIDATOR_ERRORS.TRUE_FALSE_SHAPE_INVALID,
        `TRUE_FALSE must have exactly 2 options (got ${proposal.options.length})`);
    } else {
      const vals = proposal.options.map((o) => canonicaliseText(o.text));
      const hasTrue = vals.some((v) => v === "true");
      const hasFalse = vals.some((v) => v === "false");
      if (!hasTrue || !hasFalse) {
        fail(errors, VALIDATOR_ERRORS.TRUE_FALSE_SHAPE_INVALID,
          `TRUE_FALSE options must be literally "True" and "False"`);
      }
    }
    if (corrects.length !== 1) {
      fail(errors, VALIDATOR_ERRORS.CORRECT_ANSWER_KEY_INVALID,
        `TRUE_FALSE must have exactly 1 correct option (got ${corrects.length})`);
    }
  }
}

function validateCitations(
  proposal: TrainingQuestionProposalV1,
  grounding: GroundingProjection,
  authorization: PilotAuthorizationV1,
  errors: ValidatorError[],
): void {
  const passageById = indexGroundingPassages(grounding);
  const excluded = new Set(authorization.pilotRestrictions.excludedSegmentIds || []);
  for (const c of proposal.supportingCitations) {
    if (!passageById.has(c.segmentId)) {
      fail(errors, VALIDATOR_ERRORS.CITATION_SEGMENT_UNKNOWN,
        `citation references segment ${c.segmentId} not in authorized grounding projection`);
      continue;
    }
    if (excluded.has(c.segmentId)) {
      fail(errors, VALIDATOR_ERRORS.CITATION_SEGMENT_EXCLUDED,
        `citation references pilot-excluded segment ${c.segmentId}`);
      continue;
    }
    const passage = passageById.get(c.segmentId)!;
    if ((passage.flags?.pendingReview || []).length > 0) {
      fail(errors, VALIDATOR_ERRORS.CITATION_SEGMENT_UNAUTHORIZED,
        `citation references segment ${c.segmentId} that carries pending-review flag(s) in grounding`);
      continue;
    }
    if (c.endSec <= c.startSec) {
      fail(errors, VALIDATOR_ERRORS.CITATION_TIMESTAMP_REVERSED,
        `citation on segment ${c.segmentId} has endSec ${c.endSec} <= startSec ${c.startSec}`);
      continue;
    }
    if (c.startSec < passage.sourceStartSec || c.endSec > passage.sourceEndSec) {
      fail(errors, VALIDATOR_ERRORS.CITATION_TIMESTAMP_OUT_OF_BOUNDS,
        `citation on segment ${c.segmentId} range (${c.startSec}, ${c.endSec}) escapes passage range (${passage.sourceStartSec}, ${passage.sourceEndSec})`);
      continue;
    }
    const canonPassage = canonicaliseText(passage.text);
    const canonQuote = canonicaliseText(c.quotation);
    if (canonQuote.length < 2) {
      fail(errors, VALIDATOR_ERRORS.QUOTATION_NOT_IN_SOURCE,
        `quotation on segment ${c.segmentId} empty after normalization`);
      continue;
    }
    if (!canonPassage.includes(canonQuote)) {
      fail(errors, VALIDATOR_ERRORS.QUOTATION_NOT_IN_SOURCE,
        `quotation on segment ${c.segmentId} not found verbatim in authorized passage text`,
        { quotation: c.quotation, segmentId: c.segmentId });
    }
  }
}

function validatePlacement(
  proposal: TrainingQuestionProposalV1,
  grounding: GroundingProjection,
  errors: ValidatorError[],
): void {
  if (proposal.placement.kind !== "CHECKPOINT") return;
  const at = proposal.placement.atSec;
  const anyPassage = (grounding.passages || []).find(
    (p) => at >= p.sourceStartSec && at <= p.sourceEndSec,
  );
  if (!anyPassage) {
    fail(errors, VALIDATOR_ERRORS.PLACEMENT_OUT_OF_SOURCE,
      `CHECKPOINT placement at ${at}s does not fall within any authorized passage`);
  }
}

function validateOrganizationIntegrity(
  proposal: TrainingQuestionProposalV1,
  grounding: GroundingProjection,
  errors: ValidatorError[],
  flags: string[],
): void {
  const passageById = indexGroundingPassages(grounding);
  const combinedTextL = lower([
    proposal.questionText,
    ...proposal.options.map((o) => o.text),
    proposal.explanation,
  ].join(" "));
  const citedPassagesL = proposal.supportingCitations
    .map((c) => passageById.get(c.segmentId))
    .filter((p): p is GroundingPassage => Boolean(p))
    .map((p) => lower(p.text));
  const anyCitedHasTenant = citedPassagesL.some((t) => KNOWN_TENANT_ORG_NAMES.some((n) => t.includes(n)));
  const anyCitedHasSource = citedPassagesL.some((t) => KNOWN_SOURCE_ORG_NAMES.some((n) => t.includes(n)));
  const questionHasTenant = KNOWN_TENANT_ORG_NAMES.some((n) => combinedTextL.includes(n));
  const questionHasSource = KNOWN_SOURCE_ORG_NAMES.some((n) => combinedTextL.includes(n));

  if (questionHasTenant && !anyCitedHasTenant) {
    fail(errors, VALIDATOR_ERRORS.ORGANIZATION_INVENTION,
      `proposal mentions tenant org (Coulee Ridge) but no cited passage contains it`);
  }
  if (anyCitedHasSource && questionHasTenant && !questionHasSource) {
    fail(errors, VALIDATOR_ERRORS.ORGANIZATION_SUBSTITUTION,
      `proposal substitutes tenant org (Coulee Ridge) for source org (Silver Springs) from the cited passage`);
  }
  if (anyCitedHasSource) {
    flags.push(VALIDATOR_FLAGS.SOURCE_ORG_MISMATCH);
  }
}

function validatePolicyInvention(
  proposal: TrainingQuestionProposalV1,
  grounding: GroundingProjection,
  errors: ValidatorError[],
  flags: string[],
): void {
  const passageById = indexGroundingPassages(grounding);
  const combinedTextL = lower([
    proposal.questionText,
    ...proposal.options.map((o) => o.text),
    proposal.explanation,
  ].join(" "));
  const citedTextL = proposal.supportingCitations
    .map((c) => passageById.get(c.segmentId))
    .filter((p): p is GroundingPassage => Boolean(p))
    .map((p) => lower(p.text))
    .join(" ");
  for (const term of POLICY_SNIFF_TERMS) {
    if (combinedTextL.includes(term) && !citedTextL.includes(term)) {
      fail(errors, VALIDATOR_ERRORS.CITATION_SEGMENT_UNAUTHORIZED,
        `proposal introduces policy term "${term}" not present in any cited passage`);
    }
  }
  const correctOptions = proposal.options.filter((o) => o.isCorrect).map((o) => o.text);
  const sourceWords = new Set(citedTextL.split(/\s+/).map(normaliseWord).filter(Boolean));
  const questionWords = wordsOf(proposal.questionText);
  const answerWords = correctOptions.flatMap(wordsOf);
  const unsupported = new Set<string>();
  for (const w of [...questionWords, ...answerWords]) {
    if (!sourceWords.has(w)) unsupported.add(w);
  }
  if (unsupported.size > 0) {
    flags.push(VALIDATOR_FLAGS.UNSUPPORTED_ANSWER_WORDS);
  }
}

// ---------- Section-aware factual-claim validation ----------

interface SectionsPartition {
  readonly authoritative: string;
  readonly distractor: string;
  readonly all: string;
}
function partitionSections(proposal: TrainingQuestionProposalV1): SectionsPartition {
  const correctTexts = proposal.options.filter((o) => o.isCorrect).map((o) => o.text);
  const distractorTexts = proposal.options.filter((o) => !o.isCorrect).map((o) => o.text);
  const authoritative = [
    proposal.questionText || "",
    ...correctTexts,
    proposal.explanation || "",
  ].join("\n");
  const distractor = distractorTexts.join("\n");
  const all = authoritative + "\n" + distractor;
  return { authoritative, distractor, all };
}

function citedPassagesText(proposal: TrainingQuestionProposalV1, grounding: GroundingProjection): string {
  const passageById = indexGroundingPassages(grounding);
  return proposal.supportingCitations
    .map((c) => passageById.get(c.segmentId))
    .filter((p): p is GroundingPassage => Boolean(p))
    .map((p) => p.text)
    .join("\n");
}

function validateFactualClaims(
  proposal: TrainingQuestionProposalV1,
  grounding: GroundingProjection,
  errors: ValidatorError[],
  _warnings: ValidatorWarning[],
  flags: string[],
): void {
  const sections = partitionSections(proposal);
  const citedText = citedPassagesText(proposal, grounding);
  const citedLower = citedText.toLowerCase();

  // AUTHORITATIVE surface — hard failures on unsupported facts
  for (const claim of extractYears(sections.authoritative)) {
    if (!yearSupported(claim, citedLower)) {
      fail(errors, VALIDATOR_ERRORS.UNSUPPORTED_FACTUAL_YEAR,
        `authoritative section references calendar year "${claim.raw}" not found in cited passages`,
        { year: claim.raw, section: "authoritative" });
    }
  }
  for (const claim of extractMoney(sections.authoritative)) {
    if (!moneySupported(claim, citedText)) {
      fail(errors, VALIDATOR_ERRORS.UNSUPPORTED_FACTUAL_MONEY,
        `authoritative section references monetary amount "${claim.raw}" not found in cited passages`,
        { amount: claim.raw, section: "authoritative" });
    }
  }
  for (const claim of extractPercentages(sections.authoritative)) {
    if (!percentSupported(claim, citedText)) {
      fail(errors, VALIDATOR_ERRORS.UNSUPPORTED_FACTUAL_PERCENTAGE,
        `authoritative section references percentage "${claim.raw}" not found in cited passages`,
        { percent: claim.raw, section: "authoritative" });
    }
  }
  for (const claim of extractDurations(sections.authoritative)) {
    if (!durationSupported(claim, citedText)) {
      fail(errors, VALIDATOR_ERRORS.UNSUPPORTED_FACTUAL_DURATION,
        `authoritative section references duration "${claim.raw}" not found in cited passages`,
        { duration: claim.raw, section: "authoritative" });
    }
  }
  for (const claim of extractDates(sections.authoritative)) {
    if (!dateSupported(claim, citedText)) {
      fail(errors, VALIDATOR_ERRORS.UNSUPPORTED_FACTUAL_DATE,
        `authoritative section references date "${claim.raw}" not found in cited passages`,
        { date: claim.raw, normalised: claim.normalised, section: "authoritative" });
    }
  }
  for (const claim of extractQuantities(sections.authoritative)) {
    if (!quantitySupported(claim, citedText)) {
      flags.push(VALIDATOR_FLAGS.UNSUPPORTED_QUANTITY);
    }
  }

  // WHOLE-PROPOSAL surface — regulatory + insurance refs hard-fail everywhere.
  for (const claim of extractRegulatoryBodies(sections.all)) {
    if (!regulatoryBodySupported(claim, citedText)) {
      fail(errors, VALIDATOR_ERRORS.UNSUPPORTED_REGULATORY_BODY,
        `proposal references regulatory body "${claim.normalised}" not present in any cited passage`,
        { body: claim.normalised });
    }
  }
  for (const claim of extractInsuranceReferences(sections.all)) {
    if (!insuranceReferenceSupported(claim, citedText)) {
      fail(errors, VALIDATOR_ERRORS.UNSUPPORTED_INSURANCE_REFERENCE,
        `proposal references insurance concept "${claim.normalised}" not present in any cited passage`,
        { reference: claim.normalised });
    }
  }
}

// ---------- Main entry point ----------

export interface ValidateProposalInput {
  readonly proposal: TrainingQuestionProposalV1 | null | undefined;
  readonly grounding: GroundingProjection | null | undefined;
  readonly authorization: PilotAuthorizationV1 | null | undefined;
}

export function validateProposal(input: ValidateProposalInput): ValidatorResult {
  const errors: ValidatorError[] = [];
  const warnings: ValidatorWarning[] = [];
  const flags: string[] = [];
  const { proposal, grounding, authorization } = input;

  if (!validateStructuralShape(proposal, errors)) {
    return finalise("REJECTED", errors, warnings, flags);
  }
  validateOptionsSanity(proposal, errors);
  if (errors.length) return finalise("REJECTED", errors, warnings, flags);

  if (!grounding || !grounding.passages) {
    fail(errors, VALIDATOR_ERRORS.SCHEMA_INVALID, "grounding projection missing");
    return finalise("REJECTED", errors, warnings, flags);
  }
  if (!authorization || !authorization.pilotRestrictions) {
    fail(errors, VALIDATOR_ERRORS.SCHEMA_INVALID, "authorization missing");
    return finalise("REJECTED", errors, warnings, flags);
  }
  validateCitations(proposal, grounding, authorization, errors);
  validatePlacement(proposal, grounding, errors);
  if (errors.length) return finalise("REJECTED", errors, warnings, flags);

  validateOrganizationIntegrity(proposal, grounding, errors, flags);
  if (errors.length) return finalise("REJECTED", errors, warnings, flags);

  validatePolicyInvention(proposal, grounding, errors, flags);
  validateFactualClaims(proposal, grounding, errors, warnings, flags);

  if (errors.length) return finalise("REJECTED", errors, warnings, flags);

  const verdict: Verdict = flags.length > 0 ? "REQUIRES_HUMAN_VERIFICATION" : "GROUNDED";
  return finalise(verdict, errors, warnings, flags);
}

function finalise(
  verdict: Verdict,
  errors: ValidatorError[],
  warnings: ValidatorWarning[],
  flags: string[],
): ValidatorResult {
  return { verdict, errors, warnings, flags };
}

export function detectDuplicates(
  proposals: readonly TrainingQuestionProposalV1[],
): ReadonlyArray<{ readonly a: string; readonly b: string }> {
  const seenCanon = new Map<string, string>();
  const dups: Array<{ a: string; b: string }> = [];
  for (const p of proposals) {
    const key = canonicaliseText(p.questionText);
    if (seenCanon.has(key)) {
      dups.push({ a: seenCanon.get(key)!, b: p.proposalId });
    } else {
      seenCanon.set(key, p.proposalId);
    }
  }
  return dups;
}

// Internal exports — strictly for tests. DO NOT import these from product code.
export const _internal = {
  extractYears, extractMoney, extractPercentages, extractDurations,
  extractDates, extractQuantities, extractRegulatoryBodies,
  extractInsuranceReferences,
};
