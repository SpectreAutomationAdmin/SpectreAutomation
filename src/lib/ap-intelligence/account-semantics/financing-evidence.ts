// Sprint 3 · Phase 4 Slice 5.7A (2026-08-09) — Financing evidence
// detector.
//
// Founder FINANCING RULE (approved):
//   An account such as "Equipment under financing" must NOT
//   automatically become PREFERRED simply because the purchased
//   object is equipment. Require affirmative financing evidence.
//   Do not infer financing from price.

import type { PurchasedObjectIdentity } from "../purchased-object-identity";

export interface FinancingEvidenceResult {
  found: boolean;
  strength: "strong" | "medium" | "weak" | "absent";
  supportingEvidence: string[];
}

// Strong signals — explicit financing / lease terms.
const STRONG_FINANCING_RE: RegExp[] = [
  /\bfinance\s+agreement\b/i,
  /\bequipment\s+financing\b/i,
  /\blease\s+financing\b/i,
  /\bloan[-\s]?financed\b/i,
  /\binstallment\s+obligation\b/i,
  /\binstallment\s+(?:contract|agreement)\b/i,
  /\bcapital\s+lease\b/i,
  /\boperating\s+lease\b/i,
];

// Medium signals — require corroboration.
const MEDIUM_FINANCING_RE: RegExp[] = [
  /\bfinanced\s+(?:by|through|via)\b/i,
  /\bunder\s+(?:financing|lease)\b/i,
  /\bmonthly\s+lease\s+payment\b/i,
  /\bfinancing\s+reference\b/i,
  /\bfinance\s+(?:co|company|corp|corporation)\b/i,
];

// Weak signals — insufficient alone.
const WEAK_FINANCING_RE: RegExp[] = [
  /\blease\b/i,
  /\brental\b/i,
  /\bfinanc(?:e|ing|ed)\b/i,
];

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export function detectFinancingEvidence(
  purchasedObjects: PurchasedObjectIdentity[],
  additionalTexts: string[] = [],
): FinancingEvidenceResult {
  const supporting: string[] = [];
  const surface = [
    ...purchasedObjects.map((o) => o.description),
    ...additionalTexts,
  ].filter((s) => typeof s === "string" && s.length > 0).join("\n");

  if (surface.trim().length === 0) {
    return { found: false, strength: "absent", supportingEvidence: [] };
  }

  let strongHits = 0;
  let mediumHits = 0;
  let weakHits = 0;

  for (const re of STRONG_FINANCING_RE) {
    if (re.test(surface)) {
      strongHits++;
      supporting.push(`strong: ${re.source}`);
    }
  }
  for (const re of MEDIUM_FINANCING_RE) {
    if (re.test(surface)) {
      mediumHits++;
      supporting.push(`medium: ${re.source}`);
    }
  }
  for (const re of WEAK_FINANCING_RE) {
    if (re.test(surface)) {
      weakHits++;
      supporting.push(`weak: ${re.source}`);
    }
  }

  if (strongHits >= 1) {
    return { found: true, strength: "strong", supportingEvidence: supporting };
  }
  if (mediumHits >= 2 || (mediumHits >= 1 && weakHits >= 1)) {
    return { found: true, strength: "medium", supportingEvidence: supporting };
  }
  if (mediumHits === 1) {
    return { found: true, strength: "weak", supportingEvidence: supporting };
  }
  return { found: false, strength: "absent", supportingEvidence: supporting };
}
