-- Payroll-3A (2026-08-29) — Canonical payroll foundation.
--
-- Additive-only: no existing rows are modified, no columns dropped,
-- no HR-2C tables touched. All tables are tenant-scoped via clubId
-- and use the (clubId, primary-lookup-key) index pattern established
-- across HR-2C. Effective-dated rows use half-open [from, to)
-- semantics consistent with EmployeeEmploymentAssignment.
--
-- Nothing here calculates gross-to-net. Payroll-3A is structural
-- only — see prisma-postgres/schema.prisma for the block-level
-- design notes.

CREATE TABLE "PayrollClubConfig" (
  "id"                     TEXT NOT NULL,
  "clubId"                 TEXT NOT NULL,
  "enabled"                BOOLEAN NOT NULL DEFAULT false,
  "country"                TEXT NOT NULL DEFAULT 'CA',
  "provinceOfEmployment"   TEXT,
  "defaultPayFrequency"    TEXT NOT NULL DEFAULT 'BIWEEKLY',
  "defaultPaymentMethod"   TEXT NOT NULL DEFAULT 'DIRECT_DEPOSIT',
  "payrollAdminUserId"     TEXT,
  "controllerUserId"       TEXT,
  "glAccountingProfileId"  TEXT,
  "paystubNumberPrefix"    TEXT,
  "paystubNumberSequence"  INTEGER NOT NULL DEFAULT 0,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollClubConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollClubConfig_clubId_key" ON "PayrollClubConfig"("clubId");
CREATE INDEX "PayrollClubConfig_clubId_idx" ON "PayrollClubConfig"("clubId");
ALTER TABLE "PayrollClubConfig" ADD CONSTRAINT "PayrollClubConfig_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PayrollPayGroup" (
  "id"                TEXT NOT NULL,
  "clubId"            TEXT NOT NULL,
  "code"              TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "payFrequency"      TEXT NOT NULL,
  "active"            BOOLEAN NOT NULL DEFAULT true,
  "payDateOffsetDays" INTEGER NOT NULL DEFAULT 5,
  "notes"             TEXT,
  "createdByUserId"   TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollPayGroup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollPayGroup_clubId_code_key" ON "PayrollPayGroup"("clubId", "code");
CREATE INDEX "PayrollPayGroup_clubId_active_idx" ON "PayrollPayGroup"("clubId", "active");
ALTER TABLE "PayrollPayGroup" ADD CONSTRAINT "PayrollPayGroup_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PayrollPayGroupMember" (
  "id"              TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "payGroupId"      TEXT NOT NULL,
  "employeeId"      TEXT NOT NULL,
  "effectiveFrom"   TIMESTAMP(3) NOT NULL,
  "effectiveTo"     TIMESTAMP(3),
  "notes"           TEXT,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollPayGroupMember_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PayrollPayGroupMember_clubId_payGroupId_effectiveFrom_idx"
  ON "PayrollPayGroupMember"("clubId", "payGroupId", "effectiveFrom");
CREATE INDEX "PayrollPayGroupMember_clubId_employeeId_effectiveFrom_idx"
  ON "PayrollPayGroupMember"("clubId", "employeeId", "effectiveFrom");
ALTER TABLE "PayrollPayGroupMember" ADD CONSTRAINT "PayrollPayGroupMember_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollPayGroupMember" ADD CONSTRAINT "PayrollPayGroupMember_payGroupId_fkey"
  FOREIGN KEY ("payGroupId") REFERENCES "PayrollPayGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollPayGroupMember" ADD CONSTRAINT "PayrollPayGroupMember_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PayrollPayPeriod" (
  "id"             TEXT NOT NULL,
  "clubId"         TEXT NOT NULL,
  "payGroupId"     TEXT NOT NULL,
  "sequenceInYear" INTEGER NOT NULL,
  "taxYear"        INTEGER NOT NULL,
  "periodStart"    TIMESTAMP(3) NOT NULL,
  "periodEnd"      TIMESTAMP(3) NOT NULL,
  "payDate"        TIMESTAMP(3) NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'FUTURE',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollPayPeriod_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollPayPeriod_clubId_payGroupId_taxYear_sequenceInYear_key"
  ON "PayrollPayPeriod"("clubId", "payGroupId", "taxYear", "sequenceInYear");
CREATE UNIQUE INDEX "PayrollPayPeriod_clubId_payGroupId_periodStart_key"
  ON "PayrollPayPeriod"("clubId", "payGroupId", "periodStart");
CREATE INDEX "PayrollPayPeriod_clubId_payGroupId_periodStart_idx"
  ON "PayrollPayPeriod"("clubId", "payGroupId", "periodStart");
ALTER TABLE "PayrollPayPeriod" ADD CONSTRAINT "PayrollPayPeriod_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollPayPeriod" ADD CONSTRAINT "PayrollPayPeriod_payGroupId_fkey"
  FOREIGN KEY ("payGroupId") REFERENCES "PayrollPayGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PayrollBatch" (
  "id"                TEXT NOT NULL,
  "clubId"            TEXT NOT NULL,
  "payGroupId"        TEXT NOT NULL,
  "payPeriodId"       TEXT NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'DRAFT',
  "sequence"          INTEGER NOT NULL DEFAULT 1,
  "preparedAt"        TIMESTAMP(3),
  "preparedByUserId"  TEXT,
  "submittedAt"       TIMESTAMP(3),
  "submittedByUserId" TEXT,
  "approvedAt"        TIMESTAMP(3),
  "approvedByUserId"  TEXT,
  "postedAt"          TIMESTAMP(3),
  "postedByUserId"    TEXT,
  "voidedAt"          TIMESTAMP(3),
  "voidedByUserId"    TEXT,
  "voidReason"        TEXT,
  "workIntakeItemId"  TEXT,
  "notes"             TEXT,
  "createdByUserId"   TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollBatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollBatch_workIntakeItemId_key" ON "PayrollBatch"("workIntakeItemId");
CREATE UNIQUE INDEX "PayrollBatch_clubId_payGroupId_payPeriodId_sequence_key"
  ON "PayrollBatch"("clubId", "payGroupId", "payPeriodId", "sequence");
CREATE INDEX "PayrollBatch_clubId_status_idx" ON "PayrollBatch"("clubId", "status");
CREATE INDEX "PayrollBatch_clubId_payPeriodId_idx" ON "PayrollBatch"("clubId", "payPeriodId");
ALTER TABLE "PayrollBatch" ADD CONSTRAINT "PayrollBatch_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollBatch" ADD CONSTRAINT "PayrollBatch_payGroupId_fkey"
  FOREIGN KEY ("payGroupId") REFERENCES "PayrollPayGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollBatch" ADD CONSTRAINT "PayrollBatch_payPeriodId_fkey"
  FOREIGN KEY ("payPeriodId") REFERENCES "PayrollPayPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PayrollBatchEmployee" (
  "id"                      TEXT NOT NULL,
  "clubId"                  TEXT NOT NULL,
  "batchId"                 TEXT NOT NULL,
  "employeeId"              TEXT NOT NULL,
  "payGroupMemberId"        TEXT,
  "jurisdictionCountry"     TEXT NOT NULL,
  "jurisdictionProvince"    TEXT,
  "employeeLifecycleAtPrep" TEXT NOT NULL,
  "bankingReady"            BOOLEAN NOT NULL DEFAULT false,
  "bankingStatus"           TEXT,
  "sinReady"                BOOLEAN NOT NULL DEFAULT false,
  "federalTd1Ready"         BOOLEAN NOT NULL DEFAULT false,
  "provincialTd1Ready"      BOOLEAN NOT NULL DEFAULT false,
  "compensationReady"       BOOLEAN NOT NULL DEFAULT false,
  "status"                  TEXT NOT NULL DEFAULT 'PENDING',
  "grossPay"                DECIMAL(65,30),
  "netPay"                  DECIMAL(65,30),
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollBatchEmployee_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollBatchEmployee_batchId_employeeId_key"
  ON "PayrollBatchEmployee"("batchId", "employeeId");
CREATE INDEX "PayrollBatchEmployee_clubId_batchId_idx" ON "PayrollBatchEmployee"("clubId", "batchId");
CREATE INDEX "PayrollBatchEmployee_clubId_employeeId_idx" ON "PayrollBatchEmployee"("clubId", "employeeId");
ALTER TABLE "PayrollBatchEmployee" ADD CONSTRAINT "PayrollBatchEmployee_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollBatchEmployee" ADD CONSTRAINT "PayrollBatchEmployee_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "PayrollBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayrollBatchEmployee" ADD CONSTRAINT "PayrollBatchEmployee_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PayrollApprovedTimeEntry" (
  "id"                       TEXT NOT NULL,
  "clubId"                   TEXT NOT NULL,
  "employeeId"               TEXT NOT NULL,
  "employmentAssignmentId"   TEXT,
  "workDate"                 TIMESTAMP(3) NOT NULL,
  "hours"                    DECIMAL(65,30) NOT NULL,
  "earningClassification"    TEXT NOT NULL DEFAULT 'REGULAR',
  "approvalState"            TEXT NOT NULL DEFAULT 'DRAFT',
  "approvedAt"               TIMESTAMP(3),
  "approvedByUserId"         TEXT,
  "consumedByBatchId"        TEXT,
  "consumedByBatchEmployeeId" TEXT,
  "notes"                    TEXT,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollApprovedTimeEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PayrollApprovedTimeEntry_clubId_employeeId_workDate_idx"
  ON "PayrollApprovedTimeEntry"("clubId", "employeeId", "workDate");
CREATE INDEX "PayrollApprovedTimeEntry_clubId_approvalState_workDate_idx"
  ON "PayrollApprovedTimeEntry"("clubId", "approvalState", "workDate");
CREATE INDEX "PayrollApprovedTimeEntry_employmentAssignmentId_workDate_idx"
  ON "PayrollApprovedTimeEntry"("employmentAssignmentId", "workDate");
ALTER TABLE "PayrollApprovedTimeEntry" ADD CONSTRAINT "PayrollApprovedTimeEntry_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollApprovedTimeEntry" ADD CONSTRAINT "PayrollApprovedTimeEntry_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollApprovedTimeEntry" ADD CONSTRAINT "PayrollApprovedTimeEntry_employmentAssignmentId_fkey"
  FOREIGN KEY ("employmentAssignmentId") REFERENCES "EmployeeEmploymentAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PayrollBatchEarning" (
  "id"                     TEXT NOT NULL,
  "clubId"                 TEXT NOT NULL,
  "batchId"                TEXT NOT NULL,
  "batchEmployeeId"        TEXT NOT NULL,
  "employeeId"             TEXT NOT NULL,
  "employmentAssignmentId" TEXT,
  "earningType"            TEXT NOT NULL,
  "description"            TEXT,
  "quantity"               DECIMAL(65,30) NOT NULL DEFAULT 0,
  "rate"                   DECIMAL(65,30) NOT NULL DEFAULT 0,
  "currency"               TEXT NOT NULL DEFAULT 'CAD',
  "rateSource"             TEXT NOT NULL DEFAULT 'MANUAL',
  "approvedTimeEntryId"    TEXT,
  "notes"                  TEXT,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollBatchEarning_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PayrollBatchEarning_clubId_batchId_idx" ON "PayrollBatchEarning"("clubId", "batchId");
CREATE INDEX "PayrollBatchEarning_clubId_employeeId_earningType_idx"
  ON "PayrollBatchEarning"("clubId", "employeeId", "earningType");
CREATE INDEX "PayrollBatchEarning_batchEmployeeId_earningType_idx"
  ON "PayrollBatchEarning"("batchEmployeeId", "earningType");
ALTER TABLE "PayrollBatchEarning" ADD CONSTRAINT "PayrollBatchEarning_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollBatchEarning" ADD CONSTRAINT "PayrollBatchEarning_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "PayrollBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayrollBatchEarning" ADD CONSTRAINT "PayrollBatchEarning_batchEmployeeId_fkey"
  FOREIGN KEY ("batchEmployeeId") REFERENCES "PayrollBatchEmployee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayrollBatchEarning" ADD CONSTRAINT "PayrollBatchEarning_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollBatchEarning" ADD CONSTRAINT "PayrollBatchEarning_employmentAssignmentId_fkey"
  FOREIGN KEY ("employmentAssignmentId") REFERENCES "EmployeeEmploymentAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PayrollBatchEarning" ADD CONSTRAINT "PayrollBatchEarning_approvedTimeEntryId_fkey"
  FOREIGN KEY ("approvedTimeEntryId") REFERENCES "PayrollApprovedTimeEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PayrollBatchDeduction" (
  "id"              TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "batchId"         TEXT NOT NULL,
  "batchEmployeeId" TEXT NOT NULL,
  "employeeId"      TEXT NOT NULL,
  "deductionType"   TEXT NOT NULL,
  "description"     TEXT,
  "amount"          DECIMAL(65,30) NOT NULL,
  "currency"        TEXT NOT NULL DEFAULT 'CAD',
  "source"          TEXT NOT NULL DEFAULT 'MANUAL',
  "notes"           TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollBatchDeduction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PayrollBatchDeduction_clubId_batchId_idx" ON "PayrollBatchDeduction"("clubId", "batchId");
CREATE INDEX "PayrollBatchDeduction_clubId_employeeId_deductionType_idx"
  ON "PayrollBatchDeduction"("clubId", "employeeId", "deductionType");
CREATE INDEX "PayrollBatchDeduction_batchEmployeeId_deductionType_idx"
  ON "PayrollBatchDeduction"("batchEmployeeId", "deductionType");
ALTER TABLE "PayrollBatchDeduction" ADD CONSTRAINT "PayrollBatchDeduction_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollBatchDeduction" ADD CONSTRAINT "PayrollBatchDeduction_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "PayrollBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayrollBatchDeduction" ADD CONSTRAINT "PayrollBatchDeduction_batchEmployeeId_fkey"
  FOREIGN KEY ("batchEmployeeId") REFERENCES "PayrollBatchEmployee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayrollBatchDeduction" ADD CONSTRAINT "PayrollBatchDeduction_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PayrollBatchAllowanceSnapshot" (
  "id"                  TEXT NOT NULL,
  "clubId"              TEXT NOT NULL,
  "batchId"             TEXT NOT NULL,
  "batchEmployeeId"     TEXT NOT NULL,
  "employeeId"          TEXT NOT NULL,
  "sourceAllowanceId"   TEXT NOT NULL,
  "allowanceType"       TEXT NOT NULL,
  "description"         TEXT,
  "amount"              DECIMAL(65,30) NOT NULL,
  "currency"            TEXT NOT NULL DEFAULT 'CAD',
  "frequency"           TEXT NOT NULL,
  "taxable"             BOOLEAN NOT NULL,
  "sourceEffectiveFrom" TIMESTAMP(3) NOT NULL,
  "sourceEffectiveTo"   TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollBatchAllowanceSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollBatchAllowanceSnapshot_batchEmployeeId_sourceAllowanceId_key"
  ON "PayrollBatchAllowanceSnapshot"("batchEmployeeId", "sourceAllowanceId");
CREATE INDEX "PayrollBatchAllowanceSnapshot_clubId_batchId_idx"
  ON "PayrollBatchAllowanceSnapshot"("clubId", "batchId");
ALTER TABLE "PayrollBatchAllowanceSnapshot" ADD CONSTRAINT "PayrollBatchAllowanceSnapshot_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollBatchAllowanceSnapshot" ADD CONSTRAINT "PayrollBatchAllowanceSnapshot_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "PayrollBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayrollBatchAllowanceSnapshot" ADD CONSTRAINT "PayrollBatchAllowanceSnapshot_batchEmployeeId_fkey"
  FOREIGN KEY ("batchEmployeeId") REFERENCES "PayrollBatchEmployee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayrollBatchAllowanceSnapshot" ADD CONSTRAINT "PayrollBatchAllowanceSnapshot_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollBatchAllowanceSnapshot" ADD CONSTRAINT "PayrollBatchAllowanceSnapshot_sourceAllowanceId_fkey"
  FOREIGN KEY ("sourceAllowanceId") REFERENCES "EmployeeAllowance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
