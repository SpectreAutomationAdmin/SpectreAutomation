-- Sprint 3 · Checkpoint 16G Stage E (2026-08-04) — Today's Commitments.
--
-- Spectre-proposed operational deadlines derived from genuine work
-- intake evidence (invoice due dates, payroll cutoffs, user defer
-- dates, promised responses, aging thresholds). Kept distinct from
-- real Outlook calendar events — the panel joins them at render time
-- but the storage is separate.

CREATE TABLE "ProposedCommitment" (
    "id"                TEXT NOT NULL,
    "clubId"            TEXT NOT NULL,
    "workIntakeItemId"  TEXT,
    "title"             TEXT NOT NULL,
    "dueAt"             TIMESTAMP(3) NOT NULL,
    "sourceRule"        TEXT NOT NULL,
    "rationaleCode"     TEXT NOT NULL,
    "confidence"        DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "status"            TEXT NOT NULL DEFAULT 'PROPOSED',
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProposedCommitment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProposedCommitment_workIntakeItemId_fkey"
      FOREIGN KEY ("workIntakeItemId") REFERENCES "WorkIntakeItem"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ProposedCommitment_clubId_dueAt_idx" ON "ProposedCommitment"("clubId", "dueAt");
CREATE INDEX "ProposedCommitment_clubId_status_idx" ON "ProposedCommitment"("clubId", "status");
