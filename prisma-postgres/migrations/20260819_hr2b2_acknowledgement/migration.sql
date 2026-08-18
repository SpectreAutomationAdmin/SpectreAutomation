-- HR-2B.2 final (2026-08-19) — EmployeeOnboardingAcknowledgement.
--
-- Durable record of a positive assertion the employee makes during
-- self-service onboarding. HR-2B.2 uses the single `kind =
-- 'employment_confirmation'` — the employee explicitly stating that
-- the Club-provided position/department/employment type/expected
-- start date bundle is correct.

CREATE TABLE "EmployeeOnboardingAcknowledgement" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actorEmployeeId" TEXT,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeOnboardingAcknowledgement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmployeeOnboardingAcknowledgement_sessionId_kind_key"
  ON "EmployeeOnboardingAcknowledgement"("sessionId", "kind");

CREATE INDEX "EmployeeOnboardingAcknowledgement_clubId_sessionId_idx"
  ON "EmployeeOnboardingAcknowledgement"("clubId", "sessionId");

CREATE INDEX "EmployeeOnboardingAcknowledgement_clubId_employeeId_idx"
  ON "EmployeeOnboardingAcknowledgement"("clubId", "employeeId");

ALTER TABLE "EmployeeOnboardingAcknowledgement"
  ADD CONSTRAINT "EmployeeOnboardingAcknowledgement_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmployeeOnboardingAcknowledgement"
  ADD CONSTRAINT "EmployeeOnboardingAcknowledgement_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "EmployeeOnboardingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmployeeOnboardingAcknowledgement"
  ADD CONSTRAINT "EmployeeOnboardingAcknowledgement_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
