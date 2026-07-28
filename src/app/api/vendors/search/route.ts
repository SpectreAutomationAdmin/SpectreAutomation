// Sprint 3 · Checkpoint 15P-3 (2026-07-27) — vendor-match endpoint,
// rewritten to score against the FULL extracted profile.
//
// The pre-15P-3 GET endpoint returned a fake "confidence" from a
// five-tier lookup on which of four hardcoded reason strings were
// pushed onto an array. That produced an unavoidable 65 % ceiling
// for a name-only search even when every persisted field matched
// (the founder-observed Microsoft case).
//
// The new endpoint:
//
//   • Accepts POST with a typed body containing the full extracted
//     vendor profile.
//   • Retrieves candidates by identifying signals (name / operating
//     name / tax id / email domain / phone / website / postal) —
//     never by every-field-required.
//   • Evaluates each candidate with the shared vendor-matching
//     domain functions (normalize → compare → evaluate).
//   • Returns classification + matched/differed/notComparable field
//     lists + ranking score for stable sort.
//   • NEVER selects or returns bank / EFT / processor-token data.
//   • Preserves tenant scoping + auth.
//
// See src/lib/vendor-matching/{normalize,compare,weights,evaluate,retrieve}.ts
// for the formulas + weight table.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { retrieveCandidates } from "@/lib/vendor-matching/retrieve";
import { evaluateVendorMatch } from "@/lib/vendor-matching/evaluate";
import type { MatchInputProfile } from "@/lib/vendor-matching/compare";
import type { MatchClassification } from "@/lib/vendor-matching/evaluate";

const bodySchema = z.object({
  extracted: z.object({
    legalName:             z.string().nullish(),
    operatingName:         z.string().nullish(),
    addressLine1:          z.string().nullish(),
    addressLine2:          z.string().nullish(),
    city:                  z.string().nullish(),
    provinceState:         z.string().nullish(),
    postalCode:            z.string().nullish(),
    country:               z.string().nullish(),
    phone:                 z.string().nullish(),
    website:               z.string().nullish(),
    email:                 z.string().nullish(),
    arEmail:               z.string().nullish(),
    apRemittanceEmail:     z.string().nullish(),
    taxRegistrationNumber: z.string().nullish(),
    paymentTermsDays:      z.number().int().nonnegative().nullish(),
    mainContactName:       z.string().nullish(),
    mainContactEmail:      z.string().nullish(),
  }),
});

export interface VendorSearchMatch {
  id: string;
  legalName: string;
  operatingName: string | null;
  lastInvoiceDate: string | null;
  status: string;

  // Evidence — the founder-required shape.
  classification: MatchClassification;
  matchedFields: string[];
  differedFields: string[];
  notComparableFields: string[];
  fieldsCompared: number;
  matchedWeight: number;
  differedWeight: number;
  netEvidenceWeight: number;
  rankingScore: number;   // integer 0..100, for sort tie-breaking only

  // Human-facing summary (kept for backward compatibility with
  // existing modal chip fallback + prior 15L tenant-isolation tests).
  matchEvidence: string;
}

export async function POST(req: Request) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ matches: [] }, { status: 401 });
  const clubId = principal.activeClubId;
  if (!clubId) return NextResponse.json({ matches: [] }, { status: 400 });

  const raw = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ matches: [], error: "bad_body" }, { status: 400 });

  const extracted: MatchInputProfile = parsed.data.extracted;

  const candidates = await retrieveCandidates({ clubId, extracted });

  const evaluated: VendorSearchMatch[] = candidates.map((c) => {
    const ev = evaluateVendorMatch(extracted, c.profile);
    return {
      id: c.id,
      legalName: c.legalName,
      operatingName: c.operatingName,
      lastInvoiceDate: c.lastInvoiceDate,
      status: c.status,
      classification: ev.classification,
      matchedFields: ev.matchedFields,
      differedFields: ev.differedFields,
      notComparableFields: ev.notComparableFields,
      fieldsCompared: ev.fieldsCompared,
      matchedWeight: ev.matchedWeight,
      differedWeight: ev.differedWeight,
      netEvidenceWeight: ev.netEvidenceWeight,
      rankingScore: ev.rankingScore,
      matchEvidence: buildEvidenceSummary(ev.classification, ev.matchedFields.length, ev.differedFields.length),
    };
  });

  // Sort:
  //   1. Non-conflicting first
  //   2. Higher classification first (exact > strong > possible)
  //   3. Higher rankingScore first
  //   4. Higher matchedWeight first (breaks ties among equal ranks)
  const CLASSIFICATION_RANK: Record<MatchClassification, number> = {
    exact: 4, strong: 3, possible: 2, conflicting: 1,
  };
  evaluated.sort((a, b) => {
    if (a.classification !== b.classification) {
      return CLASSIFICATION_RANK[b.classification] - CLASSIFICATION_RANK[a.classification];
    }
    if (b.rankingScore !== a.rankingScore) return b.rankingScore - a.rankingScore;
    return b.matchedWeight - a.matchedWeight;
  });

  return NextResponse.json({ matches: evaluated.slice(0, 10) });
}

function buildEvidenceSummary(cls: MatchClassification, matchedCount: number, differedCount: number): string {
  switch (cls) {
    case "exact":       return `Exact match · ${matchedCount} field${matchedCount === 1 ? "" : "s"} verified`;
    case "strong":      return `Strong match · ${matchedCount} field${matchedCount === 1 ? "" : "s"} verified`;
    case "possible":    return matchedCount === 1
      ? "Exact name match · limited evidence"
      : `Possible match · ${matchedCount} field${matchedCount === 1 ? "" : "s"} verified`;
    case "conflicting": return `Possible match · ${differedCount} field${differedCount === 1 ? "" : "s"} differ`;
  }
}
