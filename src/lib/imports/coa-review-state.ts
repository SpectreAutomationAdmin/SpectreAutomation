// DIM-2b (2026-09-29) — Review state pure helpers.
//
// Distinct from prediction confidence. `reviewed = true` means the
// operator has explicitly confirmed the row's proposal (either by
// editing it or by clicking Mark Reviewed). HIGH prediction
// confidence does NOT imply reviewed (per Section 8 directive).
//
// Stored on ImportRow.rawJson under `_review` — transient import-
// preview metadata that never reaches Account.

export type CoaReviewMetadata = {
  reviewed: boolean;
  reviewedAt: string | null;
};

export function readReviewState(raw: Record<string, unknown> | null | undefined): CoaReviewMetadata {
  const r = (raw?._review ?? null) as { reviewed?: unknown; reviewedAt?: unknown } | null;
  if (r && typeof r === "object") {
    return {
      reviewed: r.reviewed === true,
      reviewedAt: typeof r.reviewedAt === "string" ? r.reviewedAt : null,
    };
  }
  return { reviewed: false, reviewedAt: null };
}
