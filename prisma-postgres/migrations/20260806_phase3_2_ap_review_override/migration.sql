-- Sprint 3 · Post-16H Phase 3.2 (2026-08-06) — AP review-override
-- audit table. Immutable per correction; captures the founder's
-- §3 audit requirement (distinguish machine extraction from user
-- correction) AND the server-side proof (§2 REQUIRES_EXPLICIT_REVIEW)
-- that a blocker was actually reviewed before posting.

CREATE TABLE "ApReviewOverride" (
  "id"                    TEXT NOT NULL,
  "clubId"                TEXT NOT NULL,
  "workIntakeItemId"      TEXT NOT NULL,
  "reviewedByUserId"      TEXT NOT NULL,
  "reviewedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "overrideKind"          TEXT NOT NULL,
  "satisfiesBlocker"      TEXT,
  "originalValueJson"     TEXT,
  "correctedValueJson"    TEXT,
  "reason"                TEXT,
  "resultingDecisionJson" TEXT,

  CONSTRAINT "ApReviewOverride_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ApReviewOverride_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ApReviewOverride_workIntakeItemId_fkey"
    FOREIGN KEY ("workIntakeItemId") REFERENCES "WorkIntakeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ApReviewOverride_reviewedByUserId_fkey"
    FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "ApReviewOverride_workIntakeItemId_reviewedAt_idx"
  ON "ApReviewOverride" ("workIntakeItemId", "reviewedAt");
CREATE INDEX "ApReviewOverride_clubId_reviewedAt_idx"
  ON "ApReviewOverride" ("clubId", "reviewedAt");
CREATE INDEX "ApReviewOverride_satisfiesBlocker_idx"
  ON "ApReviewOverride" ("satisfiesBlocker");
