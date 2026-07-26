// Sprint 3 Checkpoint 15E (2026-07-24) — Deterministic capital-vs-
// operating classifier.
//
// Rules only — no LLM, no ML. Every recommendation cites the
// evidence that produced it. Two orthogonal signals combine:
//   1. Threshold — the extracted total vs the club's
//      `capital_expense_min` setting (default $5,000).
//   2. Keyword — the invoice description + line descriptions
//      contain capital-suggesting language ("install", "replace",
//      "purchase", "equipment", "machinery", "improvement", etc.).
// AND-of-both → CAPITAL. Threshold-only OR keyword-only → AMBIGUOUS.
// Neither → OPERATING. Missing signals → INSUFFICIENT_EVIDENCE.

import type { ExtractedInvoice, CapitalVsOperatingState, CapitalClass } from "./types";
import { toMoney } from "@/lib/accounting/decimal";

const RULE_VERSION = 1;

// Capital-suggesting keywords, grouped by capital class. Order matters
// (first match wins for class suggestion).
const CAPITAL_CLASS_HINTS: Array<{ cls: CapitalClass; patterns: RegExp[] }> = [
  { cls: "IRRIGATION", patterns: [/\birrigation\b/i, /\bsprinkler(s)?\b/i, /\birrigation\s+pump\b/i] },
  { cls: "COURSE_EQUIPMENT", patterns: [/\bfairway mower\b/i, /\bgreens mower\b/i, /\bcourse mower\b/i, /\btop dresser\b/i, /\baerator\b/i, /\btractor\b/i, /\butility vehicle\b/i, /\bturf\s+(?:sprayer|equipment)\b/i] },
  { cls: "GOLF_EQUIPMENT", patterns: [/\bgolf cart(s)?\b/i, /\brange picker\b/i, /\bball washer\b/i, /\brange ball\s+equipment\b/i] },
  { cls: "KITCHEN_EQUIPMENT", patterns: [/\brange oven\b/i, /\bcombi oven\b/i, /\bwalk-?in cooler\b/i, /\bcommercial dishwasher\b/i, /\bicemaker\b/i, /\bconvection oven\b/i, /\bhood\b/i, /\bfryer\b/i] },
  { cls: "BUILDING_IMPROVEMENTS", patterns: [/\bleasehold\b/i, /\bconstruction\b/i, /\brenovation\b/i, /\bhvac\b/i, /\broofing\b/i, /\bpainting\s+(?:building|clubhouse)\b/i, /\bwindows\b/i, /\bflooring\b/i, /\bdrywall\b/i] },
  { cls: "FURNITURE", patterns: [/\bfurniture\b/i, /\bfurnishing(s)?\b/i, /\btable(s)?\b/i, /\bchair(s)?\b/i, /\bbanquet furniture\b/i] },
  { cls: "COMPUTER_EQUIPMENT", patterns: [/\bserver\b/i, /\blaptop(s)?\b/i, /\bdesktop(s)?\b/i, /\bpos terminal\b/i, /\btablet(s)?\b/i, /\bworkstation(s)?\b/i, /\bswitch(?:es)?\b/i, /\bnetworking equipment\b/i] },
  { cls: "VEHICLES", patterns: [/\bvehicle\b/i, /\bpickup truck\b/i, /\bcube van\b/i, /\btruck\b/i, /\bcart\s+fleet\b/i] },
];

// Words that STRONGLY suggest operating (repairs, consumables, utilities).
const OPERATING_HINTS: RegExp[] = [
  /\bmaintenance\b/i,
  /\brepair(s|ed|ing)?\b/i,
  /\bservice call\b/i,
  /\bconsumable(s)?\b/i,
  /\bcleaning\s+supplies\b/i,
  /\bmonthly\s+(?:fee|charge|subscription)\b/i,
  /\butilit(y|ies)\b/i,
  /\bhydro\b/i,
  /\belectric(?:ity)?\b/i,
  /\bwater bill\b/i,
  /\bgas bill\b/i,
  /\bfuel\b/i,
  /\binsurance premium\b/i,
  /\bsupplies\b/i,
  /\brentals?\b/i,
  /\blease payment\b/i,
];

// Words that SUGGEST capital (installations, replacements, purchases of durable goods).
const CAPITAL_HINTS: RegExp[] = [
  /\binstall(ation|ed|ing)?\b/i,
  /\breplace(ment|d)?\b/i,
  /\bpurchase of (?:new )?equipment\b/i,
  /\bnew\s+(?:equipment|machinery|asset)\b/i,
  /\bcapital\b/i,
  /\bimprovement\b/i,
  /\brebuild\b/i,
  /\bacquisition\b/i,
  /\bupgrade\b/i,
];

export interface CapitalVsOperatingArgs {
  extraction: ExtractedInvoice;
  clubCapitalMinCents: number; // club setting `capital_expense_min` * 100
}

export interface CapitalVsOperatingRecommendation {
  state: CapitalVsOperatingState;
  ruleVersion: number;
  capitalClass: CapitalClass | null;
  reasoning: string;
  supportingEvidence: string[];
}

export function classifyCapitalVsOperating(
  args: CapitalVsOperatingArgs,
): CapitalVsOperatingRecommendation {
  const { extraction } = args;
  const evidence: string[] = [];

  const totalCents = extraction.total ? Math.round(toMoney(extraction.total).mul(100).toNumber()) : null;
  const overThreshold = totalCents !== null && totalCents >= args.clubCapitalMinCents;

  const surface = joinSurface(extraction);

  const operatingKeyword = detectFirst(surface, OPERATING_HINTS);
  const capitalKeyword = detectFirst(surface, CAPITAL_HINTS);
  const classMatch = classifyCapitalClass(surface);

  if (extraction.state === "DOCUMENT_UNREADABLE") {
    return {
      state: "INSUFFICIENT_EVIDENCE",
      ruleVersion: RULE_VERSION,
      capitalClass: null,
      reasoning: "The PDF could not be parsed, so no capital/operating judgement is possible.",
      supportingEvidence: [],
    };
  }
  if (totalCents === null) {
    evidence.push("No invoice total was extracted.");
    return {
      state: "INSUFFICIENT_EVIDENCE",
      ruleVersion: RULE_VERSION,
      capitalClass: null,
      reasoning: "Cannot classify without an invoice total to compare to the capitalisation threshold.",
      supportingEvidence: evidence,
    };
  }

  if (operatingKeyword && !capitalKeyword) {
    evidence.push(`Operating-suggesting keyword: "${operatingKeyword}".`);
    return {
      state: "OPERATING",
      ruleVersion: RULE_VERSION,
      capitalClass: null,
      reasoning: `The invoice describes an operating expense (${operatingKeyword}); recommend expense treatment regardless of amount ($${(totalCents/100).toFixed(2)}).`,
      supportingEvidence: evidence,
    };
  }

  if (overThreshold && capitalKeyword) {
    evidence.push(`Invoice total $${(totalCents/100).toFixed(2)} exceeds the capitalisation threshold of $${(args.clubCapitalMinCents/100).toFixed(2)}.`);
    evidence.push(`Capital-suggesting keyword: "${capitalKeyword}".`);
    if (classMatch) evidence.push(`Capital class inferred: ${classMatch.cls} (matched "${classMatch.matchText}").`);
    return {
      state: "CAPITAL",
      ruleVersion: RULE_VERSION,
      capitalClass: classMatch?.cls ?? "OTHER_CAPITAL",
      reasoning: `The invoice describes a purchase or installation of a durable good with an expected benefit beyond one reporting period; the total also exceeds the club's capitalisation threshold. Recommend capital treatment.`,
      supportingEvidence: evidence,
    };
  }

  if (overThreshold && !capitalKeyword) {
    evidence.push(`Invoice total $${(totalCents/100).toFixed(2)} exceeds the capitalisation threshold of $${(args.clubCapitalMinCents/100).toFixed(2)}.`);
    evidence.push("No explicit capital-suggesting keyword in the description.");
    return {
      state: "AMBIGUOUS",
      ruleVersion: RULE_VERSION,
      capitalClass: null,
      reasoning: "The total is over the capitalisation threshold but the description does not clearly indicate a durable asset. Reviewer judgement required.",
      supportingEvidence: evidence,
    };
  }

  if (!overThreshold && capitalKeyword) {
    evidence.push(`Capital-suggesting keyword: "${capitalKeyword}".`);
    evidence.push(`Total $${(totalCents/100).toFixed(2)} is below the capitalisation threshold of $${(args.clubCapitalMinCents/100).toFixed(2)}.`);
    return {
      state: "AMBIGUOUS",
      ruleVersion: RULE_VERSION,
      capitalClass: null,
      reasoning: "The description suggests a capital purchase but the amount is under the threshold. Reviewer judgement required (some clubs capitalise sub-threshold items when part of a larger project).",
      supportingEvidence: evidence,
    };
  }

  evidence.push(`Total $${(totalCents/100).toFixed(2)} is below the capitalisation threshold of $${(args.clubCapitalMinCents/100).toFixed(2)}.`);
  evidence.push("No capital keywords detected.");
  return {
    state: "OPERATING",
    ruleVersion: RULE_VERSION,
    capitalClass: null,
    reasoning: "Small-value invoice with no capital-suggesting language; recommend operating expense treatment.",
    supportingEvidence: evidence,
  };
}

function joinSurface(extraction: ExtractedInvoice): string {
  const parts: string[] = [];
  if (extraction.description) parts.push(extraction.description);
  for (const l of extraction.lineItems) parts.push(l.description);
  if (extraction.vendor.guessedName) parts.push(extraction.vendor.guessedName);
  return parts.join(" \n ").toLowerCase();
}

function detectFirst(surface: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const m = surface.match(p);
    if (m) return m[0];
  }
  return null;
}

function classifyCapitalClass(surface: string): { cls: CapitalClass; matchText: string } | null {
  for (const { cls, patterns } of CAPITAL_CLASS_HINTS) {
    for (const p of patterns) {
      const m = surface.match(p);
      if (m) return { cls, matchText: m[0] };
    }
  }
  return null;
}
