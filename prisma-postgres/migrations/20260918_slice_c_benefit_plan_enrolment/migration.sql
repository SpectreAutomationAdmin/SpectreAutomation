-- Slice C (2026-09-18) — Payroll benefit plans + enrolments.
-- Additive: two new tables + two nullable columns on
-- PayrollBatchComponentSnapshot. No breaking change.

-- 1. Club-level benefit plans.
CREATE TABLE "PayrollBenefitPlan" (
    "id"                     TEXT NOT NULL,
    "clubId"                 TEXT NOT NULL,
    "kind"                   TEXT NOT NULL,
    "code"                   TEXT NOT NULL,
    "name"                   TEXT NOT NULL,
    "description"            TEXT,
    "providerName"           TEXT,
    "active"                 BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom"          TIMESTAMP(3) NOT NULL,
    "effectiveTo"            TIMESTAMP(3),
    "employeeComponentId"    TEXT,
    "employerComponentId"    TEXT,
    "defaultElectionKind"    TEXT NOT NULL DEFAULT 'FIXED_AMOUNT',
    "eligibleEarningsBasis"  TEXT,
    "employerMatchBps"       INTEGER,
    "employerMatchCapBps"    INTEGER,
    "notes"                  TEXT,
    "createdByUserId"        TEXT,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollBenefitPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayrollBenefitPlan_clubId_code_key"
    ON "PayrollBenefitPlan"("clubId", "code");
CREATE INDEX "PayrollBenefitPlan_clubId_kind_active_idx"
    ON "PayrollBenefitPlan"("clubId", "kind", "active");

ALTER TABLE "PayrollBenefitPlan"
    ADD CONSTRAINT "PayrollBenefitPlan_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayrollBenefitPlan"
    ADD CONSTRAINT "PayrollBenefitPlan_employeeComponentId_fkey"
    FOREIGN KEY ("employeeComponentId") REFERENCES "PayrollComponent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PayrollBenefitPlan"
    ADD CONSTRAINT "PayrollBenefitPlan_employerComponentId_fkey"
    FOREIGN KEY ("employerComponentId") REFERENCES "PayrollComponent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 2. Employee enrolments.
CREATE TABLE "EmployeeBenefitPlanEnrolment" (
    "id"                TEXT NOT NULL,
    "clubId"            TEXT NOT NULL,
    "employeeId"        TEXT NOT NULL,
    "planId"            TEXT NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'ACTIVE',
    "effectiveFrom"     TIMESTAMP(3) NOT NULL,
    "effectiveTo"       TIMESTAMP(3),
    "electionKind"      TEXT NOT NULL,
    "amount"            DECIMAL(65,30),
    "percentBps"        INTEGER,
    "notes"             TEXT,
    "enteredByUserId"   TEXT,
    "changedByUserId"   TEXT,
    "endedByUserId"     TEXT,
    "endReason"         TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EmployeeBenefitPlanEnrolment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmployeeBenefitPlanEnrolment_clubId_employeeId_planId_effectiveFrom_idx"
    ON "EmployeeBenefitPlanEnrolment"("clubId", "employeeId", "planId", "effectiveFrom");
CREATE INDEX "EmployeeBenefitPlanEnrolment_clubId_planId_status_idx"
    ON "EmployeeBenefitPlanEnrolment"("clubId", "planId", "status");

ALTER TABLE "EmployeeBenefitPlanEnrolment"
    ADD CONSTRAINT "EmployeeBenefitPlanEnrolment_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmployeeBenefitPlanEnrolment"
    ADD CONSTRAINT "EmployeeBenefitPlanEnrolment_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmployeeBenefitPlanEnrolment"
    ADD CONSTRAINT "EmployeeBenefitPlanEnrolment_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "PayrollBenefitPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. Snapshot provenance columns for benefit-driven snapshots.
ALTER TABLE "PayrollBatchComponentSnapshot"
    ADD COLUMN "sourceEnrolmentId" TEXT;

CREATE INDEX "PayrollBatchComponentSnapshot_sourceEnrolmentId_idx"
    ON "PayrollBatchComponentSnapshot"("sourceEnrolmentId");

ALTER TABLE "PayrollBatchComponentSnapshot"
    ADD CONSTRAINT "PayrollBatchComponentSnapshot_sourceEnrolmentId_fkey"
    FOREIGN KEY ("sourceEnrolmentId") REFERENCES "EmployeeBenefitPlanEnrolment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
