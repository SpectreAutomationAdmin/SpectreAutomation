-- HR-1 (2026-08-16) — Canonical people, employment & payroll
-- infrastructure. Additive migration (SQLite dev variant).
--
--   * extend "Employee" with lifecycle / linkage / manager columns
--   * add 16 new tables for canonical HR
--
-- Every new table carries "clubId" for tenant scoping EXCEPT
-- "EmployeeOnboardingQuestion" which is clubId-nullable (global
-- default question catalogue; inserts are gated by
-- `system:super_admin` at the service layer).
--
-- All ciphertext columns end in "SecretRef" and hold KMS envelope
-- blobs under scope "HR" (see src/lib/kms/index.ts).
--
-- SQLite differences from the Postgres variant:
--   * lifecycle enums are TEXT columns with default values; the
--     allowed value list is documented in schema.prisma comments and
--     enforced by the service layer (matches existing repo convention;
--     Postgres variant is also TEXT to keep both schemas in lockstep).
--   * timestamps use DATETIME (not TIMESTAMP(3)).
--   * Decimal → DECIMAL (SQLite type affinity NUMERIC).
--   * SQLite ALTER TABLE only supports one ADD COLUMN per statement.

-- ===================================================================
-- 1. Extend Employee.
-- ===================================================================
ALTER TABLE "Employee" ADD COLUMN "middleName" TEXT;
ALTER TABLE "Employee" ADD COLUMN "preferredName" TEXT;
ALTER TABLE "Employee" ADD COLUMN "personalEmail" TEXT;
ALTER TABLE "Employee" ADD COLUMN "mobilePhone" TEXT;
ALTER TABLE "Employee" ADD COLUMN "expectedStartDate" DATETIME;
ALTER TABLE "Employee" ADD COLUMN "activatedAt" DATETIME;
ALTER TABLE "Employee" ADD COLUMN "employmentType" TEXT;
ALTER TABLE "Employee" ADD COLUMN "employeeLifecycle" TEXT NOT NULL DEFAULT 'PRE_HIRE';
ALTER TABLE "Employee" ADD COLUMN "onboardingState" TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE "Employee" ADD COLUMN "payrollReadiness" TEXT NOT NULL DEFAULT 'NOT_READY';
ALTER TABLE "Employee" ADD COLUMN "createdByUserId" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Employee" ADD COLUMN "memberId" TEXT REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Employee" ADD COLUMN "profilePhotoDocumentId" TEXT;
ALTER TABLE "Employee" ADD COLUMN "resumeDocumentId" TEXT;
ALTER TABLE "Employee" ADD COLUMN "managerEmployeeId" TEXT REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Employee_memberId_key" ON "Employee"("memberId");
CREATE INDEX "Employee_clubId_employeeLifecycle_idx" ON "Employee"("clubId", "employeeLifecycle");
CREATE INDEX "Employee_clubId_managerEmployeeId_idx" ON "Employee"("clubId", "managerEmployeeId");
-- profilePhotoDocumentId / resumeDocumentId FKs are wired implicitly
-- via Prisma's model relations; SQLite does not enforce them until a
-- new table is rebuilt (which we deliberately avoid here to keep this
-- migration additive). The service layer enforces existence + tenancy.

-- ===================================================================
-- 2. EmploymentPeriod
-- ===================================================================
CREATE TABLE "EmploymentPeriod" (
    "id"                TEXT NOT NULL PRIMARY KEY,
    "clubId"            TEXT NOT NULL,
    "employeeId"        TEXT NOT NULL,
    "effectiveFrom"     DATETIME NOT NULL,
    "effectiveTo"       DATETIME,
    "employmentType"    TEXT NOT NULL,
    "reason"            TEXT NOT NULL,
    "positionId"        TEXT,
    "departmentId"      TEXT,
    "managerEmployeeId" TEXT,
    "actorUserId"       TEXT,
    "notes"             TEXT,
    "createdAt"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         DATETIME NOT NULL,
    CONSTRAINT "EmploymentPeriod_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmploymentPeriod_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE
);
CREATE INDEX "EmploymentPeriod_clubId_idx"                   ON "EmploymentPeriod"("clubId");
CREATE INDEX "EmploymentPeriod_employeeId_effectiveFrom_idx" ON "EmploymentPeriod"("employeeId", "effectiveFrom");

-- ===================================================================
-- 3. EmployeeCompensation
-- ===================================================================
CREATE TABLE "EmployeeCompensation" (
    "id"            TEXT NOT NULL PRIMARY KEY,
    "clubId"        TEXT NOT NULL,
    "employeeId"    TEXT NOT NULL,
    "effectiveFrom" DATETIME NOT NULL,
    "effectiveTo"   DATETIME,
    "cadence"       TEXT NOT NULL,
    "rate"          DECIMAL NOT NULL,
    "currency"      TEXT,
    "notes"         TEXT,
    "actorUserId"   TEXT,
    "createdAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeeCompensation_clubId_fkey"      FOREIGN KEY ("clubId")      REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmployeeCompensation_employeeId_fkey"  FOREIGN KEY ("employeeId")  REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
    CONSTRAINT "EmployeeCompensation_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id")     ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "EmployeeCompensation_clubId_idx"                   ON "EmployeeCompensation"("clubId");
CREATE INDEX "EmployeeCompensation_employeeId_effectiveFrom_idx" ON "EmployeeCompensation"("employeeId", "effectiveFrom");

-- ===================================================================
-- 4. PayrollProfile
-- ===================================================================
CREATE TABLE "PayrollProfile" (
    "id"                  TEXT NOT NULL PRIMARY KEY,
    "clubId"              TEXT NOT NULL,
    "employeeId"          TEXT NOT NULL,
    "jurisdiction"        TEXT NOT NULL,
    "payGroup"            TEXT NOT NULL,
    "payFrequency"        TEXT NOT NULL,
    "directDepositActive" BOOLEAN NOT NULL DEFAULT false,
    "activatedAt"         DATETIME,
    "suspendedAt"         DATETIME,
    "suspensionReason"    TEXT,
    "notes"               TEXT,
    "createdAt"           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           DATETIME NOT NULL,
    CONSTRAINT "PayrollProfile_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PayrollProfile_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PayrollProfile_employeeId_key" ON "PayrollProfile"("employeeId");
CREATE INDEX        "PayrollProfile_clubId_idx"     ON "PayrollProfile"("clubId");

-- ===================================================================
-- 5. PayrollBenefit
-- ===================================================================
CREATE TABLE "PayrollBenefit" (
    "id"                TEXT NOT NULL PRIMARY KEY,
    "clubId"            TEXT NOT NULL,
    "payrollProfileId"  TEXT NOT NULL,
    "benefitCode"       TEXT NOT NULL,
    "displayName"       TEXT NOT NULL,
    "computationKind"   TEXT NOT NULL,
    "amount"            DECIMAL NOT NULL DEFAULT 0,
    "currency"          TEXT,
    "effectiveFrom"     DATETIME NOT NULL,
    "effectiveTo"       DATETIME,
    "employerFundedPct" DECIMAL,
    "employeeFundedPct" DECIMAL,
    "notes"             TEXT,
    "createdAt"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         DATETIME NOT NULL,
    CONSTRAINT "PayrollBenefit_clubId_fkey"           FOREIGN KEY ("clubId")           REFERENCES "Club"("id")           ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PayrollBenefit_payrollProfileId_fkey" FOREIGN KEY ("payrollProfileId") REFERENCES "PayrollProfile"("id") ON DELETE CASCADE  ON UPDATE CASCADE
);
CREATE INDEX "PayrollBenefit_clubId_idx"                         ON "PayrollBenefit"("clubId");
CREATE INDEX "PayrollBenefit_payrollProfileId_effectiveFrom_idx" ON "PayrollBenefit"("payrollProfileId", "effectiveFrom");

-- ===================================================================
-- 6. PayrollDeduction
-- ===================================================================
CREATE TABLE "PayrollDeduction" (
    "id"               TEXT NOT NULL PRIMARY KEY,
    "clubId"           TEXT NOT NULL,
    "payrollProfileId" TEXT NOT NULL,
    "deductionCode"    TEXT NOT NULL,
    "displayName"      TEXT NOT NULL,
    "computationKind"  TEXT NOT NULL,
    "amount"           DECIMAL NOT NULL DEFAULT 0,
    "currency"         TEXT,
    "effectiveFrom"    DATETIME NOT NULL,
    "effectiveTo"      DATETIME,
    "preTax"           BOOLEAN NOT NULL DEFAULT false,
    "notes"            TEXT,
    "createdAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        DATETIME NOT NULL,
    CONSTRAINT "PayrollDeduction_clubId_fkey"           FOREIGN KEY ("clubId")           REFERENCES "Club"("id")           ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PayrollDeduction_payrollProfileId_fkey" FOREIGN KEY ("payrollProfileId") REFERENCES "PayrollProfile"("id") ON DELETE CASCADE  ON UPDATE CASCADE
);
CREATE INDEX "PayrollDeduction_clubId_idx"                         ON "PayrollDeduction"("clubId");
CREATE INDEX "PayrollDeduction_payrollProfileId_effectiveFrom_idx" ON "PayrollDeduction"("payrollProfileId", "effectiveFrom");

-- ===================================================================
-- 7. EmployeeSensitiveIdentity
-- ===================================================================
CREATE TABLE "EmployeeSensitiveIdentity" (
    "id"             TEXT NOT NULL PRIMARY KEY,
    "clubId"         TEXT NOT NULL,
    "employeeId"     TEXT NOT NULL,
    "sinSecretRef"   TEXT NOT NULL,
    "sinLastThree"   TEXT,
    "issuingCountry" TEXT,
    "effectiveFrom"  DATETIME,
    "createdAt"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      DATETIME NOT NULL,
    CONSTRAINT "EmployeeSensitiveIdentity_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmployeeSensitiveIdentity_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmployeeSensitiveIdentity_employeeId_key" ON "EmployeeSensitiveIdentity"("employeeId");
CREATE INDEX        "EmployeeSensitiveIdentity_clubId_idx"     ON "EmployeeSensitiveIdentity"("clubId");

-- ===================================================================
-- 8. EmployeeBankAccount
-- ===================================================================
CREATE TABLE "EmployeeBankAccount" (
    "id"                   TEXT NOT NULL PRIMARY KEY,
    "clubId"               TEXT NOT NULL,
    "employeeId"           TEXT NOT NULL,
    "institutionSecretRef" TEXT NOT NULL,
    "transitSecretRef"     TEXT NOT NULL,
    "accountSecretRef"     TEXT NOT NULL,
    "accountLastFour"      TEXT,
    "holderName"           TEXT NOT NULL,
    "status"               TEXT NOT NULL DEFAULT 'PENDING_PENNY_TEST',
    "activatedAt"          DATETIME,
    "createdAt"            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            DATETIME NOT NULL,
    CONSTRAINT "EmployeeBankAccount_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmployeeBankAccount_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE
);
CREATE INDEX "EmployeeBankAccount_clubId_idx"            ON "EmployeeBankAccount"("clubId");
CREATE INDEX "EmployeeBankAccount_employeeId_status_idx" ON "EmployeeBankAccount"("employeeId", "status");

-- ===================================================================
-- 9. EmployeeTaxProfile
-- ===================================================================
CREATE TABLE "EmployeeTaxProfile" (
    "id"                           TEXT NOT NULL PRIMARY KEY,
    "clubId"                       TEXT NOT NULL,
    "employeeId"                   TEXT NOT NULL,
    "province"                     TEXT NOT NULL,
    "td1FormVersion"               TEXT NOT NULL,
    "effectiveFrom"                DATETIME NOT NULL,
    "effectiveTo"                  DATETIME,
    "federalClaimSecretRef"        TEXT NOT NULL,
    "provincialClaimSecretRef"     TEXT NOT NULL,
    "additionalDeductionSecretRef" TEXT,
    "notes"                        TEXT,
    "createdAt"                    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                    DATETIME NOT NULL,
    CONSTRAINT "EmployeeTaxProfile_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmployeeTaxProfile_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE
);
CREATE INDEX "EmployeeTaxProfile_clubId_idx"                   ON "EmployeeTaxProfile"("clubId");
CREATE INDEX "EmployeeTaxProfile_employeeId_effectiveFrom_idx" ON "EmployeeTaxProfile"("employeeId", "effectiveFrom");

-- ===================================================================
-- 10. EmployeeDocument
-- ===================================================================
CREATE TABLE "EmployeeDocument" (
    "id"               TEXT NOT NULL PRIMARY KEY,
    "clubId"           TEXT NOT NULL,
    "employeeId"       TEXT NOT NULL,
    "storageKey"       TEXT NOT NULL,
    "contentSha256"    TEXT NOT NULL,
    "sizeBytes"        INTEGER NOT NULL,
    "mimeType"         TEXT NOT NULL,
    "category"         TEXT NOT NULL,
    "sensitivity"      TEXT NOT NULL DEFAULT 'STANDARD',
    "displayName"      TEXT,
    "uploadedByUserId" TEXT,
    "uploadedAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeeDocument_clubId_fkey"           FOREIGN KEY ("clubId")           REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmployeeDocument_employeeId_fkey"       FOREIGN KEY ("employeeId")       REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
    CONSTRAINT "EmployeeDocument_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id")     ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "EmployeeDocument_clubId_idx"              ON "EmployeeDocument"("clubId");
CREATE INDEX "EmployeeDocument_employeeId_category_idx" ON "EmployeeDocument"("employeeId", "category");
CREATE INDEX "EmployeeDocument_contentSha256_idx"       ON "EmployeeDocument"("contentSha256");

-- ===================================================================
-- 11. EmployeeCredential
-- ===================================================================
CREATE TABLE "EmployeeCredential" (
    "id"             TEXT NOT NULL PRIMARY KEY,
    "clubId"         TEXT NOT NULL,
    "employeeId"     TEXT NOT NULL,
    "credentialCode" TEXT NOT NULL,
    "displayName"    TEXT NOT NULL,
    "issuer"         TEXT,
    "reference"      TEXT,
    "issuedAt"       DATETIME,
    "expiresAt"      DATETIME,
    "documentId"     TEXT,
    "notes"          TEXT,
    "createdAt"      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      DATETIME NOT NULL,
    CONSTRAINT "EmployeeCredential_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmployeeCredential_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE
);
CREATE INDEX "EmployeeCredential_clubId_idx"               ON "EmployeeCredential"("clubId");
CREATE INDEX "EmployeeCredential_employeeId_expiresAt_idx" ON "EmployeeCredential"("employeeId", "expiresAt");

-- ===================================================================
-- 12. EmployeeEmergencyContact
-- ===================================================================
CREATE TABLE "EmployeeEmergencyContact" (
    "id"           TEXT NOT NULL PRIMARY KEY,
    "clubId"       TEXT NOT NULL,
    "employeeId"   TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    "relation"     TEXT NOT NULL,
    "phone"        TEXT NOT NULL,
    "email"        TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city"         TEXT,
    "province"     TEXT,
    "postalCode"   TEXT,
    "country"      TEXT,
    "isPrimary"    BOOLEAN NOT NULL DEFAULT false,
    "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    DATETIME NOT NULL,
    CONSTRAINT "EmployeeEmergencyContact_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmployeeEmergencyContact_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE
);
CREATE INDEX "EmployeeEmergencyContact_clubId_idx"     ON "EmployeeEmergencyContact"("clubId");
CREATE INDEX "EmployeeEmergencyContact_employeeId_idx" ON "EmployeeEmergencyContact"("employeeId");

-- ===================================================================
-- 13. EmployeeOnboardingInvitation
-- ===================================================================
CREATE TABLE "EmployeeOnboardingInvitation" (
    "id"               TEXT NOT NULL PRIMARY KEY,
    "clubId"           TEXT NOT NULL,
    "employeeId"       TEXT NOT NULL,
    "tokenHash"        TEXT NOT NULL,
    "expiresAt"        DATETIME NOT NULL,
    "revokedAt"        DATETIME,
    "redeemedAt"       DATETIME,
    "redeemedByIpHash" TEXT,
    "issuedByUserId"   TEXT NOT NULL,
    "createdAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeeOnboardingInvitation_clubId_fkey"         FOREIGN KEY ("clubId")         REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmployeeOnboardingInvitation_employeeId_fkey"     FOREIGN KEY ("employeeId")     REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
    CONSTRAINT "EmployeeOnboardingInvitation_issuedByUserId_fkey" FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id")     ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmployeeOnboardingInvitation_tokenHash_key"  ON "EmployeeOnboardingInvitation"("tokenHash");
CREATE INDEX        "EmployeeOnboardingInvitation_clubId_idx"     ON "EmployeeOnboardingInvitation"("clubId");
CREATE INDEX        "EmployeeOnboardingInvitation_employeeId_idx" ON "EmployeeOnboardingInvitation"("employeeId");
CREATE INDEX        "EmployeeOnboardingInvitation_expiresAt_idx"  ON "EmployeeOnboardingInvitation"("expiresAt");

-- ===================================================================
-- 14. EmployeeOnboardingSession
-- ===================================================================
CREATE TABLE "EmployeeOnboardingSession" (
    "id"                TEXT NOT NULL PRIMARY KEY,
    "clubId"            TEXT NOT NULL,
    "employeeId"        TEXT NOT NULL,
    "initiatedByUserId" TEXT NOT NULL,
    "approvedByUserId"  TEXT,
    "state"             TEXT NOT NULL DEFAULT 'DRAFT',
    "startedAt"         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"       DATETIME,
    "submittedAt"       DATETIME,
    "approvedAt"        DATETIME,
    "rejectedAt"        DATETIME,
    "rejectionReason"   TEXT,
    CONSTRAINT "EmployeeOnboardingSession_clubId_fkey"            FOREIGN KEY ("clubId")            REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmployeeOnboardingSession_employeeId_fkey"        FOREIGN KEY ("employeeId")        REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
    CONSTRAINT "EmployeeOnboardingSession_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "User"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmployeeOnboardingSession_approvedByUserId_fkey"  FOREIGN KEY ("approvedByUserId")  REFERENCES "User"("id")     ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "EmployeeOnboardingSession_clubId_idx"           ON "EmployeeOnboardingSession"("clubId");
CREATE INDEX "EmployeeOnboardingSession_employeeId_state_idx" ON "EmployeeOnboardingSession"("employeeId", "state");

-- ===================================================================
-- 15. EmployeeOnboardingStateTransition
-- ===================================================================
CREATE TABLE "EmployeeOnboardingStateTransition" (
    "id"              TEXT NOT NULL PRIMARY KEY,
    "clubId"          TEXT NOT NULL,
    "employeeId"      TEXT NOT NULL,
    "sessionId"       TEXT,
    "fromState"       TEXT NOT NULL,
    "toState"         TEXT NOT NULL,
    "actorSource"     TEXT NOT NULL,
    "actorUserId"     TEXT,
    "actorEmployeeId" TEXT,
    "reason"          TEXT,
    "at"              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeeOnboardingStateTransition_clubId_fkey"      FOREIGN KEY ("clubId")      REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmployeeOnboardingStateTransition_employeeId_fkey"  FOREIGN KEY ("employeeId")  REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
    CONSTRAINT "EmployeeOnboardingStateTransition_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id")     ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "EmployeeOnboardingStateTransition_clubId_idx"        ON "EmployeeOnboardingStateTransition"("clubId");
CREATE INDEX "EmployeeOnboardingStateTransition_employeeId_at_idx" ON "EmployeeOnboardingStateTransition"("employeeId", "at");

-- ===================================================================
-- 16. EmployeeOnboardingQuestion (clubId NULLABLE — global catalogue)
-- ===================================================================
CREATE TABLE "EmployeeOnboardingQuestion" (
    "id"           TEXT NOT NULL PRIMARY KEY,
    "clubId"       TEXT,
    "key"          TEXT NOT NULL,
    "section"      TEXT NOT NULL,
    "prompt"       TEXT NOT NULL,
    "helpText"     TEXT,
    "answerKind"   TEXT NOT NULL,
    "required"     BOOLEAN NOT NULL DEFAULT false,
    "optionsJson"  TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "active"       BOOLEAN NOT NULL DEFAULT true,
    "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    DATETIME NOT NULL,
    CONSTRAINT "EmployeeOnboardingQuestion_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmployeeOnboardingQuestion_clubId_key_key"                  ON "EmployeeOnboardingQuestion"("clubId", "key");
CREATE INDEX        "EmployeeOnboardingQuestion_clubId_section_displayOrder_idx" ON "EmployeeOnboardingQuestion"("clubId", "section", "displayOrder");

-- ===================================================================
-- 17. EmployeeOnboardingResponse
-- ===================================================================
CREATE TABLE "EmployeeOnboardingResponse" (
    "id"           TEXT NOT NULL PRIMARY KEY,
    "clubId"       TEXT NOT NULL,
    "sessionId"    TEXT NOT NULL,
    "questionId"   TEXT NOT NULL,
    "status"       TEXT NOT NULL DEFAULT 'PENDING',
    "responseJson" TEXT,
    "answeredAt"   DATETIME,
    "reviewedAt"   DATETIME,
    "reviewerNote" TEXT,
    "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    DATETIME NOT NULL,
    CONSTRAINT "EmployeeOnboardingResponse_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")                      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmployeeOnboardingResponse_sessionId_fkey"  FOREIGN KEY ("sessionId")  REFERENCES "EmployeeOnboardingSession"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
    CONSTRAINT "EmployeeOnboardingResponse_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "EmployeeOnboardingQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmployeeOnboardingResponse_sessionId_questionId_key" ON "EmployeeOnboardingResponse"("sessionId", "questionId");
CREATE INDEX        "EmployeeOnboardingResponse_clubId_idx"               ON "EmployeeOnboardingResponse"("clubId");
CREATE INDEX        "EmployeeOnboardingResponse_sessionId_idx"            ON "EmployeeOnboardingResponse"("sessionId");
