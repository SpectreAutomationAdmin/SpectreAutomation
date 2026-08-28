-- HR-2C Anonymous Employee Feedback (2026-08-27) — tenant-scoped,
-- author-less feedback records. The row intentionally does NOT
-- carry any column that could link back to the submitting employee.
-- Never add employeeId / userId / name / email / employee-number
-- to this table.

CREATE TABLE "AnonymousFeedback" (
  "id"          TEXT NOT NULL,
  "clubId"      TEXT NOT NULL,
  "category"    TEXT,
  "message"     TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'NEW',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt"  TIMESTAMP(3),

  CONSTRAINT "AnonymousFeedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AnonymousFeedback_clubId_createdAt_idx"
  ON "AnonymousFeedback" ("clubId", "createdAt");

CREATE INDEX "AnonymousFeedback_clubId_status_idx"
  ON "AnonymousFeedback" ("clubId", "status");

ALTER TABLE "AnonymousFeedback"
  ADD CONSTRAINT "AnonymousFeedback_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
