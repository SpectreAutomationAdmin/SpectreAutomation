// Sprint 3 · Checkpoint 15P-6 (2026-07-28) — vendor resolution
// UNIFIED with the 15P-3 evidence-based matcher.
//
// Founder-observed root cause (15P-5 rejection):
//   The Mission Control card's projection was resolving vendors
//   with the pre-15P-3 `matchVendorForClub` (email-domain / sender
//   name / tax-exact / fallback fuzzy). The Create-Vendor modal's
//   own POST /api/vendors/search endpoint uses the newer 15P-3
//   evidence-based matcher (retrieveCandidates → evaluateVendorMatch).
//   The two matchers disagreed for the Microsoft Corporation
//   record: the modal saw an EXACT match on 10 fields, but the
//   projection saw NOT_FOUND. Result: workflowState =
//   VENDOR_MATCH_REQUIRED → card label "Create vendor & post" →
//   modal opens on Step 1 (Vendor Profile), and the user has to
//   click the exact-match chip to advance — the drift the founder
//   flagged four times.
//
// The fix: one matcher, canonical for both surfaces. The projection
// now consumes the SAME domain modules the modal uses. When the
// modal's search finds an unambiguous exact/strong vendor, the
// projection sees the same result and returns state=MATCHED with
// that vendor's id. The card's `deriveApAction` then routes to
// APPROVE_AND_POST → single-step AP-Coding modal opens directly.

import { prisma } from "@/lib/prisma";
import type { ExtractedInvoice, VendorMatchState } from "./types";
import { retrieveCandidates } from "@/lib/vendor-matching/retrieve";
import { evaluateVendorMatch } from "@/lib/vendor-matching/evaluate";
import { resolveModalEntry, type CandidateForResolution } from "@/lib/vendor-matching/resolve-modal-entry";
import type { MatchInputProfile } from "@/lib/vendor-matching/compare";
import { logger } from "@/lib/observability/logger";

export interface VendorMatchCandidate {
  id: string;
  operatingName: string | null;
  legalName: string;
  matchSignals: string[];
}

export interface VendorResolveResult {
  state: VendorMatchState;
  candidates: VendorMatchCandidate[];
  ruleVersion: number;
}

// 15P-6: bumped from 1 → 2 to reflect the matcher swap. Any
// downstream cache keying on ruleVersion will invalidate cleanly.
const RULE_VERSION = 2;

export async function resolveVendorForExtraction(args: {
  clubId: string;
  extraction: ExtractedInvoice;
  // 15P-6: the AP analyser's second-pass extractor produces a much
  // richer profile than parse-invoice.ts. When both are available
  // we prefer the extractor's fields for retrieval + scoring. When
  // only the parse-invoice guess is present we still function.
  extractedProfile?: {
    address?: { line1?: { value: string | null }; city?: { value: string | null }; provinceState?: { value: string | null }; postalCode?: { value: string | null }; country?: { value: string | null } };
    phone?: { value: string | null };
    website?: { value: string | null };
    customerSupportEmail?: { value: string | null };
    taxRegistrationNumber?: { value: string | null };
  } | null;
}): Promise<VendorResolveResult> {
  const { clubId, extraction, extractedProfile } = args;

  // Build a MatchInputProfile from the extracted evidence. Prefer
  // extractedProfile fields (from the 15P-1 vendor-profile
  // extractor) when present; fall back to parse-invoice guesses.
  const extractedFor: MatchInputProfile = {
    legalName: extraction.vendor.guessedName,
    email: extractedProfile?.customerSupportEmail?.value ?? extraction.vendor.guessedEmail,
    phone: extractedProfile?.phone?.value ?? null,
    website: extractedProfile?.website?.value ?? null,
    addressLine1: extractedProfile?.address?.line1?.value ?? null,
    city: extractedProfile?.address?.city?.value ?? null,
    provinceState: extractedProfile?.address?.provinceState?.value ?? null,
    postalCode: extractedProfile?.address?.postalCode?.value ?? null,
    country: extractedProfile?.address?.country?.value ?? null,
    taxRegistrationNumber: extractedProfile?.taxRegistrationNumber?.value ?? extraction.vendor.guessedTaxNumber,
  };

  // Retrieve tenant-scoped candidates via the identifying signals
  // (name / operating name / tax id / email domain / phone / website
  // / postal). This is the SAME retrieval path the modal uses.
  const candidates = await retrieveCandidates({ clubId, extracted: extractedFor });

  if (candidates.length === 0) {
    // Sanity check: does any usable signal exist at all? Absent all
    // identifying evidence, mark INSUFFICIENT_SIGNAL — the operator
    // will get "Create vendor & post" without any suggested match.
    const anySignal =
      !!(extractedFor.legalName || extractedFor.taxRegistrationNumber || extractedFor.email || extractedFor.phone || extractedFor.website);
    return {
      state: anySignal ? "NOT_FOUND" : "INSUFFICIENT_SIGNAL",
      candidates: [],
      ruleVersion: RULE_VERSION,
    };
  }

  // Score every candidate with the SAME evaluator the modal uses.
  const evaluated = candidates.map((c) => {
    const ev = evaluateVendorMatch(extractedFor, c.profile);
    return {
      id: c.id,
      legalName: c.legalName,
      operatingName: c.operatingName,
      classification: ev.classification,
      matchedWeight: ev.matchedWeight,
      differedFields: ev.differedFields,
      matchedFields: ev.matchedFields,
    };
  });

  // Sort best-first (same ordering the API applies). Then feed to
  // resolveModalEntry for the SAME auto-resolve rule the modal uses.
  const CLASSIFICATION_RANK: Record<string, number> = { exact: 4, strong: 3, possible: 2, conflicting: 1 };
  evaluated.sort((a, b) => {
    if (a.classification !== b.classification) return CLASSIFICATION_RANK[b.classification] - CLASSIFICATION_RANK[a.classification];
    return b.matchedWeight - a.matchedWeight;
  });
  const forResolution: CandidateForResolution[] = evaluated.map((c) => ({
    id: c.id, legalName: c.legalName,
    classification: c.classification, matchedWeight: c.matchedWeight,
    differedFields: c.differedFields,
  }));
  const resolution = resolveModalEntry(forResolution);

  // Map the shared resolution back to the VendorMatchState enum the
  // projection consumes.
  //
  // resolved                  → MATCHED (leader is sole candidate in
  //                             the response; downstream card reads
  //                             candidates[0].id as matchedVendorId)
  // review_required no_match  → NOT_FOUND
  // review_required limited   → the projection has real candidates
  //                             — return AMBIGUOUS so the card asks
  //                             for review rather than "create new"
  // review_required ambiguous → AMBIGUOUS
  // review_required conflicting → AMBIGUOUS (needs review; not a
  //                             clean auto-resolve)
  let state: VendorMatchState;
  let outCandidates: VendorMatchCandidate[];
  if (resolution.status === "resolved") {
    state = "MATCHED";
    outCandidates = [{
      id: resolution.candidate.id,
      legalName: resolution.candidate.legalName,
      operatingName: evaluated.find((e) => e.id === resolution.candidate.id)?.operatingName ?? null,
      matchSignals: evaluated.find((e) => e.id === resolution.candidate.id)?.matchedFields ?? [],
    }];
  } else if (resolution.reason === "no_match") {
    state = "NOT_FOUND";
    outCandidates = [];
  } else {
    state = "AMBIGUOUS";
    outCandidates = evaluated.map((c) => ({
      id: c.id, legalName: c.legalName, operatingName: c.operatingName,
      matchSignals: c.matchedFields,
    }));
  }

  // 15P-6 instrumentation — staging-only structured log of the
  // derivation for the Microsoft-style acceptance case. Never
  // logs invoice contents, tax numbers, or banking details.
  if (process.env.SPECTRE_ENV !== "production") {
    logger.info("ap-intelligence.vendor-resolve", {
      clubId,
      extractedNameKind: extractedFor.legalName ? "present" : "absent",
      candidateCount: candidates.length,
      leaderClassification: evaluated[0]?.classification ?? null,
      leaderMatchedWeight: evaluated[0]?.matchedWeight ?? null,
      resolution: resolution.status,
      resolutionReason: resolution.status === "review_required" ? resolution.reason : null,
      state,
      matchedVendorId: state === "MATCHED" ? outCandidates[0]?.id ?? null : null,
    });
  }

  return { state, candidates: outCandidates, ruleVersion: RULE_VERSION };
}
