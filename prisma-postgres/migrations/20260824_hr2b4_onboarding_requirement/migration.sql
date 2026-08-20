-- HR-2B.4 (2026-08-19) — OnboardingRequirement
--
-- Club-configurable onboarding requirements presented to the employee
-- during the Documents & Credentials stage. Fulfillment is queried
-- through EXISTING canonical rows (EmployeeDocument, EmployeeCredential,
-- EmployeeOnboardingAcknowledgement) keyed on the requirement's `code` —
-- no new fulfillment table is introduced.
--
-- Additive-only. No back-fill required.

CREATE TABLE "OnboardingRequirement" (
  "id"                    TEXT NOT NULL PRIMARY KEY,
  "clubId"                TEXT NOT NULL,
  "code"                  TEXT NOT NULL,
  "displayName"           TEXT NOT NULL,
  "explanation"           TEXT,
  "kind"                  TEXT NOT NULL,
  "documentCategory"      TEXT,
  "appliesToAll"          BOOLEAN NOT NULL DEFAULT false,
  "appliesToDeptIds"      TEXT,
  "appliesToPositionIds"  TEXT,
  "required"              BOOLEAN NOT NULL DEFAULT true,
  "requireExpiry"         BOOLEAN NOT NULL DEFAULT false,
  "active"                BOOLEAN NOT NULL DEFAULT true,
  "displayOrder"          INTEGER NOT NULL DEFAULT 0,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  "createdByUserId"       TEXT,
  CONSTRAINT "OnboardingRequirement_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OnboardingRequirement_clubId_code_key"
  ON "OnboardingRequirement"("clubId", "code");
CREATE INDEX "OnboardingRequirement_clubId_active_idx"
  ON "OnboardingRequirement"("clubId", "active");
