// Sprint 3 · Phase 4 Slice 5.7A (2026-08-09) — CIP evidence detector.
//
// Founder §4 + CIP RULE (approved):
//   Construction in Progress accounts must NOT be treated as generic
//   capital asset buckets. A CIP account is only compatible when the
//   transaction contains affirmative evidence that costs are being
//   accumulated toward an asset not yet placed in service.
//
//   A single vague word like "installation" is not enough.
//   §4 requires structured project evidence.

import type { PurchasedObjectIdentity } from "../purchased-object-identity";

export interface CipEvidenceResult {
  found: boolean;
  strength: "strong" | "medium" | "weak" | "absent";
  supportingEvidence: string[];
  contradictions: string[];
}

// Strong signals — any single hit qualifies as strong evidence.
const STRONG_CIP_RE: RegExp[] = [
  /\b(?:construction|constructed|constructing)\b(?!\s+(?:manager|worker|zone|site\s+access|equipment))/i,
  /\bcapital\s+project\s*(?:#|no\.?|number)?\b/i,
  /\bproject\s+(?:#|no\.?|number)\s*[:\-]?\s*[A-Z0-9]/i,
  /\bwork\s+in\s+progress\b/i,
  /\bWIP\b/,
  /\bconstruct\s+in\s+progress\b/i,
];

// Medium signals — require corroborating context.
const MEDIUM_CIP_RE: RegExp[] = [
  /\bprogress\s+(?:bill|billing|draw|payment|invoice)\b/i,
  /\bphase\s*\d+\b/i,
  /\bretainage\b/i,
  /\bhold[-\s]?back\b/i,
  /\binstallation\s+underway\b/i,
  /\bnot\s+yet\s+in\s+service\b/i,
  /\bplaced\s+in\s+service\s+(?:pending|later|when|after)\b/i,
];

// Weak signals — insufficient alone (§4 explicit: "installation"
// alone is not enough).
const WEAK_CIP_RE: RegExp[] = [
  /\binstallation\b/i,
  /\binstall\b/i,
  /\bcontractor\b/i,
  /\bproject\b/i,   // bare "project" without # or "capital" prefix
];

// Contradictions — signals that the transaction is complete /
// placed-in-service, which contradicts CIP.
const IN_SERVICE_RE: RegExp[] = [
  /\bplaced\s+in\s+service\b/i,
  /\bin\s+service\s+as\s+of\b/i,
  /\bready\s+for\s+use\b/i,
  /\bcommissioned\b/i,
  /\bwarranty\s+registration\b/i,
];

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export function detectCipEvidence(
  purchasedObjects: PurchasedObjectIdentity[],
  additionalTexts: string[] = [],
): CipEvidenceResult {
  const supporting: string[] = [];
  const contradictions: string[] = [];

  const surface = [
    ...purchasedObjects.map((o) => o.description),
    ...additionalTexts,
  ].filter((s) => typeof s === "string" && s.length > 0).join("\n");

  if (surface.trim().length === 0) {
    return { found: false, strength: "absent", supportingEvidence: [], contradictions: [] };
  }

  // In-service contradictions inspected first — an explicit
  // in-service statement dominates any weaker CIP token.
  for (const re of IN_SERVICE_RE) {
    if (re.test(surface)) {
      contradictions.push(`in_service_signal: ${re.source}`);
    }
  }

  let strongHits = 0;
  let mediumHits = 0;
  let weakHits = 0;

  for (const re of STRONG_CIP_RE) {
    if (re.test(surface)) {
      strongHits++;
      supporting.push(`strong: ${re.source}`);
    }
  }
  for (const re of MEDIUM_CIP_RE) {
    if (re.test(surface)) {
      mediumHits++;
      supporting.push(`medium: ${re.source}`);
    }
  }
  for (const re of WEAK_CIP_RE) {
    if (re.test(surface)) {
      weakHits++;
      supporting.push(`weak: ${re.source}`);
    }
  }

  if (contradictions.length > 0) {
    return {
      found: false,
      strength: "absent",
      supportingEvidence: supporting,
      contradictions,
    };
  }

  if (strongHits >= 1) {
    return { found: true, strength: "strong", supportingEvidence: supporting, contradictions };
  }
  if (mediumHits >= 2 || (mediumHits >= 1 && weakHits >= 1)) {
    return { found: true, strength: "medium", supportingEvidence: supporting, contradictions };
  }
  if (mediumHits === 1) {
    return { found: true, strength: "weak", supportingEvidence: supporting, contradictions };
  }
  // Weak hits alone are insufficient per §4.
  return { found: false, strength: "absent", supportingEvidence: supporting, contradictions };
}
