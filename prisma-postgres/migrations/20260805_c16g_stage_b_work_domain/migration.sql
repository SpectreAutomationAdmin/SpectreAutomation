-- Sprint 3 · Checkpoint 16G Stage B (2026-08-04) — work-domain taxonomy.
--
-- Separates the ingestion classifier's initial label (`classification`)
-- from the renderer's ownership decision (`workDomain`), the user
-- intent (`workIntent`), and the specific subtype (`workSubtype`).
-- The renderer picks fields, actions and tabs by workDomain — never
-- by `classification`. Result: a membership inquiry never renders
-- through the AP shell.

ALTER TABLE "WorkIntakeItem" ADD COLUMN "workDomain"                       TEXT;
ALTER TABLE "WorkIntakeItem" ADD COLUMN "workIntent"                       TEXT;
ALTER TABLE "WorkIntakeItem" ADD COLUMN "workSubtype"                      TEXT;
ALTER TABLE "WorkIntakeItem" ADD COLUMN "workDomainConfidence"             DOUBLE PRECISION;
ALTER TABLE "WorkIntakeItem" ADD COLUMN "workDomainSupportingEvidenceJson" TEXT;
ALTER TABLE "WorkIntakeItem" ADD COLUMN "workDomainAlternativesJson"       TEXT;
ALTER TABLE "WorkIntakeItem" ADD COLUMN "workDomainRequiresReview"         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WorkIntakeItem" ADD COLUMN "workDomainClassifiedAt"           TIMESTAMP(3);
ALTER TABLE "WorkIntakeItem" ADD COLUMN "workDomainClassifierVersion"      TEXT;

CREATE INDEX "WorkIntakeItem_clubId_workDomain_idx"
  ON "WorkIntakeItem"("clubId", "workDomain");

CREATE TABLE "WorkDomainCorrection" (
    "id"                TEXT NOT NULL,
    "clubId"            TEXT NOT NULL,
    "workIntakeItemId"  TEXT NOT NULL,
    "originalDomain"    TEXT,
    "correctedDomain"   TEXT NOT NULL,
    "originalSubtype"   TEXT,
    "correctedSubtype"  TEXT,
    "correctedByUserId" TEXT NOT NULL,
    "correctedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason"            TEXT,

    CONSTRAINT "WorkDomainCorrection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkDomainCorrection_workIntakeItemId_fkey"
      FOREIGN KEY ("workIntakeItemId") REFERENCES "WorkIntakeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "WorkDomainCorrection_clubId_correctedAt_idx"
  ON "WorkDomainCorrection"("clubId", "correctedAt");
CREATE INDEX "WorkDomainCorrection_workIntakeItemId_idx"
  ON "WorkDomainCorrection"("workIntakeItemId");
