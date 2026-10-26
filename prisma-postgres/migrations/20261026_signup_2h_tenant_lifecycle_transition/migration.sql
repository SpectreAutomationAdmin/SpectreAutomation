-- SIGNUP-2 Phase 2H (2026-10-26) -- tenant lifecycle transition log.
-- Postgres mirror.  Additive-only.

CREATE TABLE "TenantLifecycleTransition" (
  "id"                  TEXT NOT NULL,
  "clubId"              TEXT NOT NULL,
  "previousStatus"      TEXT NOT NULL,
  "newStatus"           TEXT NOT NULL,
  "previousAccessTier"  TEXT,
  "newAccessTier"       TEXT,
  "trigger"             TEXT NOT NULL,
  "triggerEvidenceJson" TEXT,
  "operatorUserId"      TEXT NOT NULL,
  "authoriserUserId"    TEXT,
  "reasonCode"          TEXT,
  "reasonNotes"         TEXT,
  "effectiveAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversedAt"          TIMESTAMP(3),
  "reversedReason"      TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TenantLifecycleTransition_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TenantLifecycleTransition"
  ADD CONSTRAINT "TenantLifecycleTransition_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "TenantLifecycleTransition_clubId_effectiveAt_idx"
  ON "TenantLifecycleTransition"("clubId", "effectiveAt");
CREATE INDEX "TenantLifecycleTransition_newStatus_effectiveAt_idx"
  ON "TenantLifecycleTransition"("newStatus", "effectiveAt");
CREATE INDEX "TenantLifecycleTransition_trigger_effectiveAt_idx"
  ON "TenantLifecycleTransition"("trigger", "effectiveAt");
CREATE INDEX "TenantLifecycleTransition_operatorUserId_effectiveAt_idx"
  ON "TenantLifecycleTransition"("operatorUserId", "effectiveAt");
