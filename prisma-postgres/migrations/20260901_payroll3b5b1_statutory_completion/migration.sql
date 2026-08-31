-- Payroll-3B-5B-1 (2026-08-31)
-- CPT30 evidence + effective-date facts, CPP disability status,
-- Employee terminationReason, PayrollBatchEmployee calc result
-- contract, PayrollOpeningBalance CPP split + prior-employer
-- distinction.
--
-- Additive-only; existing rows remain valid.

-- ---- Employee -------------------------------------------------------
ALTER TABLE "Employee"
  ADD COLUMN IF NOT EXISTS "terminationReason" TEXT;

-- ---- EmployeeCppElection -------------------------------------------
ALTER TABLE "EmployeeCppElection"
  ADD COLUMN IF NOT EXISTS "pensionType"                 TEXT,
  ADD COLUMN IF NOT EXISTS "retirementPensionReceived"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "employeeSignedOn"            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revokesElectionId"           TEXT,
  ADD COLUMN IF NOT EXISTS "evidenceDocumentId"          TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmployeeCppElection_revokesElectionId_fkey') THEN
    ALTER TABLE "EmployeeCppElection"
      ADD CONSTRAINT "EmployeeCppElection_revokesElectionId_fkey"
      FOREIGN KEY ("revokesElectionId") REFERENCES "EmployeeCppElection"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS "EmployeeCppElection_revokesElectionId_ix"
  ON "EmployeeCppElection"("revokesElectionId");

-- ---- EmployeeCppDisability (new) -----------------------------------
CREATE TABLE IF NOT EXISTS "EmployeeCppDisability" (
  "id"                TEXT NOT NULL,
  "clubId"            TEXT NOT NULL,
  "employeeId"        TEXT NOT NULL,
  "status"            TEXT NOT NULL,
  "effectiveFrom"     TIMESTAMP(3) NOT NULL,
  "effectiveTo"       TIMESTAMP(3),
  "sourceBasis"       TEXT,
  "recordedByUserId"  TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeCppDisability_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "EmployeeCppDisability_club_employee_from_ix"
  ON "EmployeeCppDisability"("clubId", "employeeId", "effectiveFrom");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmployeeCppDisability_clubId_fkey') THEN
    ALTER TABLE "EmployeeCppDisability"
      ADD CONSTRAINT "EmployeeCppDisability_clubId_fkey"
      FOREIGN KEY ("clubId") REFERENCES "Club"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'EmployeeCppDisability_employeeId_fkey') THEN
    ALTER TABLE "EmployeeCppDisability"
      ADD CONSTRAINT "EmployeeCppDisability_employeeId_fkey"
      FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- ---- PayrollBatchEmployee: calc result contract --------------------
ALTER TABLE "PayrollBatchEmployee"
  ADD COLUMN IF NOT EXISTS "earningsTaxable"        DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "earningsPensionable"    DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "earningsInsurable"      DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "deductionCppEeBase"     DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "deductionCppEeFirstAdd" DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "deductionCpp2Ee"        DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "deductionEiEe"          DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "deductionFederalTax"    DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "deductionProvincialTax" DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "employerCppBase"        DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "employerCppFirstAdd"    DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "employerCpp2"           DECIMAL(65,30),
  ADD COLUMN IF NOT EXISTS "employerEi"             DECIMAL(65,30);

-- ---- PayrollOpeningBalance: CPP split + prior-employer ------------
ALTER TABLE "PayrollOpeningBalance"
  ADD COLUMN IF NOT EXISTS "ytdCppEE_Base"      DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "ytdCppEE_FirstAdd"  DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "ytdCppER_Base"      DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "ytdCppER_FirstAdd"  DECIMAL(65,30) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "priorPayrollKind"   TEXT NOT NULL DEFAULT 'PRIOR_SYSTEM_SAME_EMPLOYER',
  ADD COLUMN IF NOT EXISTS "priorEmployerId"    TEXT;
