-- Payroll-3B-5B-1a (2026-08-31)
-- Employee date of birth + CPP age eligibility foundation.
-- Additive-only; existing employees stay valid (nullable field).

ALTER TABLE "Employee"
  ADD COLUMN IF NOT EXISTS "dateOfBirth" TIMESTAMP(3);

ALTER TABLE "PayrollBatchEmployee"
  ADD COLUMN IF NOT EXISTS "dateOfBirthSnapshot" TIMESTAMP(3);

-- CPT30 election foundation (schema only — no UI in this slice).
CREATE TABLE IF NOT EXISTS "EmployeeCppElection" (
  "id"              TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "employeeId"      TEXT NOT NULL,
  "kind"            TEXT NOT NULL,
  "receivedOn"      TIMESTAMP(3) NOT NULL,
  "effectiveOn"     TIMESTAMP(3) NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'ACTIVE',
  "supersededById"  TEXT,
  "notes"           TEXT,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeCppElection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "EmployeeCppElection_club_employee_status_ix"
  ON "EmployeeCppElection"("clubId", "employeeId", "status");
CREATE INDEX IF NOT EXISTS "EmployeeCppElection_club_employee_effectiveOn_ix"
  ON "EmployeeCppElection"("clubId", "employeeId", "effectiveOn");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmployeeCppElection_clubId_fkey') THEN
    ALTER TABLE "EmployeeCppElection"
      ADD CONSTRAINT "EmployeeCppElection_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "Club"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmployeeCppElection_employeeId_fkey') THEN
    ALTER TABLE "EmployeeCppElection"
      ADD CONSTRAINT "EmployeeCppElection_employeeId_fkey"
      FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmployeeCppElection_supersededById_fkey') THEN
    ALTER TABLE "EmployeeCppElection"
      ADD CONSTRAINT "EmployeeCppElection_supersededById_fkey"
      FOREIGN KEY ("supersededById") REFERENCES "EmployeeCppElection"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
