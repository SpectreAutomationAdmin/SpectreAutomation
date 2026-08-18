-- HR-2B.2 (2026-08-18) — EmployeeOnboardingCorrection.
--
-- Employee-facing onboarding cannot mutate Club-authoritative
-- employment fields directly (positionId, departmentId,
-- expectedStartDate, employmentType). When the employee flags a
-- discrepancy, the fact is captured here for staff review.

CREATE TABLE "EmployeeOnboardingCorrection" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "employeeStatedValue" TEXT NOT NULL,
    "note" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeOnboardingCorrection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmployeeOnboardingCorrection_clubId_sessionId_idx"
  ON "EmployeeOnboardingCorrection"("clubId", "sessionId");

CREATE INDEX "EmployeeOnboardingCorrection_clubId_employeeId_idx"
  ON "EmployeeOnboardingCorrection"("clubId", "employeeId");

ALTER TABLE "EmployeeOnboardingCorrection"
  ADD CONSTRAINT "EmployeeOnboardingCorrection_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmployeeOnboardingCorrection"
  ADD CONSTRAINT "EmployeeOnboardingCorrection_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "EmployeeOnboardingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmployeeOnboardingCorrection"
  ADD CONSTRAINT "EmployeeOnboardingCorrection_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
