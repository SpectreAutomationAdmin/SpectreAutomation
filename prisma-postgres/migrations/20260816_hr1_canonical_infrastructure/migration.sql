-- HR-1 (2026-08-16) — Canonical people, employment & payroll
-- infrastructure. Additive migration:
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
-- Postgres variant. Safe under the release_command rolling deploy
-- because every column added to Employee is nullable (or has a
-- default) and no existing column is dropped or narrowed.

-- ═══════════════════════════════════════════════════════════════════
-- 1. Extend Employee.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE "Employee"
  ADD COLUMN "middleName"             TEXT,
  ADD COLUMN "preferredName"          TEXT,
  ADD COLUMN "personalEmail"          TEXT,
  ADD COLUMN "mobilePhone"            TEXT,
  ADD COLUMN "expectedStartDate"      TIMESTAMP(3),
  ADD COLUMN "activatedAt"            TIMESTAMP(3),
  ADD COLUMN "employmentType"         TEXT,
  ADD COLUMN "employeeLifecycle"      TEXT NOT NULL DEFAULT 'PRE_HIRE',
  ADD COLUMN "onboardingState"        TEXT NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN "payrollReadiness"       TEXT NOT NULL DEFAULT 'NOT_READY',
  ADD COLUMN "createdByUserId"        TEXT,
  ADD COLUMN "memberId"               TEXT,
  ADD COLUMN "profilePhotoDocumentId" TEXT,
  ADD COLUMN "resumeDocumentId"       TEXT,
  ADD COLUMN "managerEmployeeId"      TEXT;

CREATE UNIQUE INDEX "Employee_memberId_key"          ON "Employee"("memberId");
CREATE INDEX        "Employee_clubId_employeeLifecycle_idx"
  ON "Employee"("clubId", "employeeLifecycle");
CREATE INDEX        "Employee_clubId_managerEmployeeId_idx"
  ON "Employee"("clubId", "managerEmployeeId");

ALTER TABLE "Employee"
  ADD CONSTRAINT "Employee_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Employee_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "Member"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Employee_managerEmployeeId_fkey"
    FOREIGN KEY ("managerEmployeeId") REFERENCES "Employee"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
-- profilePhotoDocumentId / resumeDocumentId FK are added later, after
-- EmployeeDocument exists (see §11).

-- ═══════════════════════════════════════════════════════════════════
-- 2. EmploymentPeriod
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "EmploymentPeriod" (
  "id"                TEXT NOT NULL,
  "clubId"            TEXT NOT NULL,
  "employeeId"        TEXT NOT NULL,
  "effectiveFrom"     TIMESTAMP(3) NOT NULL,
  "effectiveTo"       TIMESTAMP(3),
  "employmentType"    TEXT NOT NULL,
  "reason"            TEXT NOT NULL,
  "positionId"        TEXT,
  "departmentId"      TEXT,
  "managerEmployeeId" TEXT,
  "actorUserId"       TEXT,
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmploymentPeriod_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmploymentPeriod_clubId_idx"                    ON "EmploymentPeriod"("clubId");
CREATE INDEX "EmploymentPeriod_employeeId_effectiveFrom_idx"  ON "EmploymentPeriod"("employeeId", "effectiveFrom");
ALTER TABLE "EmploymentPeriod"
  ADD CONSTRAINT "EmploymentPeriod_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmploymentPeriod_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 3. EmployeeCompensation
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "EmployeeCompensation" (
  "id"            TEXT NOT NULL,
  "clubId"        TEXT NOT NULL,
  "employeeId"    TEXT NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo"   TIMESTAMP(3),
  "cadence"       TEXT NOT NULL,
  "rate"          DECIMAL(65,30) NOT NULL,
  "currency"      TEXT,
  "notes"         TEXT,
  "actorUserId"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeeCompensation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmployeeCompensation_clubId_idx"                   ON "EmployeeCompensation"("clubId");
CREATE INDEX "EmployeeCompensation_employeeId_effectiveFrom_idx" ON "EmployeeCompensation"("employeeId", "effectiveFrom");
ALTER TABLE "EmployeeCompensation"
  ADD CONSTRAINT "EmployeeCompensation_clubId_fkey"      FOREIGN KEY ("clubId")      REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeCompensation_employeeId_fkey"  FOREIGN KEY ("employeeId")  REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeCompensation_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id")     ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 4. PayrollProfile
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "PayrollProfile" (
  "id"                  TEXT NOT NULL,
  "clubId"              TEXT NOT NULL,
  "employeeId"          TEXT NOT NULL,
  "jurisdiction"        TEXT NOT NULL,
  "payGroup"            TEXT NOT NULL,
  "payFrequency"        TEXT NOT NULL,
  "directDepositActive" BOOLEAN NOT NULL DEFAULT false,
  "activatedAt"         TIMESTAMP(3),
  "suspendedAt"         TIMESTAMP(3),
  "suspensionReason"    TEXT,
  "notes"               TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollProfile_employeeId_key" ON "PayrollProfile"("employeeId");
CREATE INDEX        "PayrollProfile_clubId_idx"     ON "PayrollProfile"("clubId");
ALTER TABLE "PayrollProfile"
  ADD CONSTRAINT "PayrollProfile_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PayrollProfile_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 5. PayrollBenefit
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "PayrollBenefit" (
  "id"                TEXT NOT NULL,
  "clubId"            TEXT NOT NULL,
  "payrollProfileId"  TEXT NOT NULL,
  "benefitCode"       TEXT NOT NULL,
  "displayName"       TEXT NOT NULL,
  "computationKind"   TEXT NOT NULL,
  "amount"            DECIMAL(65,30) NOT NULL DEFAULT 0,
  "currency"          TEXT,
  "effectiveFrom"     TIMESTAMP(3) NOT NULL,
  "effectiveTo"       TIMESTAMP(3),
  "employerFundedPct" DECIMAL(65,30),
  "employeeFundedPct" DECIMAL(65,30),
  "notes"             TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollBenefit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PayrollBenefit_clubId_idx"                            ON "PayrollBenefit"("clubId");
CREATE INDEX "PayrollBenefit_payrollProfileId_effectiveFrom_idx"    ON "PayrollBenefit"("payrollProfileId", "effectiveFrom");
ALTER TABLE "PayrollBenefit"
  ADD CONSTRAINT "PayrollBenefit_clubId_fkey"           FOREIGN KEY ("clubId")           REFERENCES "Club"("id")           ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PayrollBenefit_payrollProfileId_fkey" FOREIGN KEY ("payrollProfileId") REFERENCES "PayrollProfile"("id") ON DELETE CASCADE  ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 6. PayrollDeduction
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "PayrollDeduction" (
  "id"               TEXT NOT NULL,
  "clubId"           TEXT NOT NULL,
  "payrollProfileId" TEXT NOT NULL,
  "deductionCode"    TEXT NOT NULL,
  "displayName"      TEXT NOT NULL,
  "computationKind"  TEXT NOT NULL,
  "amount"           DECIMAL(65,30) NOT NULL DEFAULT 0,
  "currency"         TEXT,
  "effectiveFrom"    TIMESTAMP(3) NOT NULL,
  "effectiveTo"      TIMESTAMP(3),
  "preTax"           BOOLEAN NOT NULL DEFAULT false,
  "notes"            TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollDeduction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PayrollDeduction_clubId_idx"                            ON "PayrollDeduction"("clubId");
CREATE INDEX "PayrollDeduction_payrollProfileId_effectiveFrom_idx"    ON "PayrollDeduction"("payrollProfileId", "effectiveFrom");
ALTER TABLE "PayrollDeduction"
  ADD CONSTRAINT "PayrollDeduction_clubId_fkey"           FOREIGN KEY ("clubId")           REFERENCES "Club"("id")           ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PayrollDeduction_payrollProfileId_fkey" FOREIGN KEY ("payrollProfileId") REFERENCES "PayrollProfile"("id") ON DELETE CASCADE  ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 7. EmployeeSensitiveIdentity
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "EmployeeSensitiveIdentity" (
  "id"             TEXT NOT NULL,
  "clubId"         TEXT NOT NULL,
  "employeeId"     TEXT NOT NULL,
  "sinSecretRef"   TEXT NOT NULL,
  "sinLastThree"   TEXT,
  "issuingCountry" TEXT,
  "effectiveFrom"  TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeSensitiveIdentity_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmployeeSensitiveIdentity_employeeId_key" ON "EmployeeSensitiveIdentity"("employeeId");
CREATE INDEX        "EmployeeSensitiveIdentity_clubId_idx"     ON "EmployeeSensitiveIdentity"("clubId");
ALTER TABLE "EmployeeSensitiveIdentity"
  ADD CONSTRAINT "EmployeeSensitiveIdentity_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeSensitiveIdentity_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 8. EmployeeBankAccount
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "EmployeeBankAccount" (
  "id"                   TEXT NOT NULL,
  "clubId"               TEXT NOT NULL,
  "employeeId"           TEXT NOT NULL,
  "institutionSecretRef" TEXT NOT NULL,
  "transitSecretRef"     TEXT NOT NULL,
  "accountSecretRef"     TEXT NOT NULL,
  "accountLastFour"      TEXT,
  "holderName"           TEXT NOT NULL,
  "status"               TEXT NOT NULL DEFAULT 'PENDING_PENNY_TEST',
  "activatedAt"          TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeBankAccount_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmployeeBankAccount_clubId_idx"              ON "EmployeeBankAccount"("clubId");
CREATE INDEX "EmployeeBankAccount_employeeId_status_idx"   ON "EmployeeBankAccount"("employeeId", "status");
ALTER TABLE "EmployeeBankAccount"
  ADD CONSTRAINT "EmployeeBankAccount_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeBankAccount_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 9. EmployeeTaxProfile
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "EmployeeTaxProfile" (
  "id"                           TEXT NOT NULL,
  "clubId"                       TEXT NOT NULL,
  "employeeId"                   TEXT NOT NULL,
  "province"                     TEXT NOT NULL,
  "td1FormVersion"               TEXT NOT NULL,
  "effectiveFrom"                TIMESTAMP(3) NOT NULL,
  "effectiveTo"                  TIMESTAMP(3),
  "federalClaimSecretRef"        TEXT NOT NULL,
  "provincialClaimSecretRef"     TEXT NOT NULL,
  "additionalDeductionSecretRef" TEXT,
  "notes"                        TEXT,
  "createdAt"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeTaxProfile_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmployeeTaxProfile_clubId_idx"                     ON "EmployeeTaxProfile"("clubId");
CREATE INDEX "EmployeeTaxProfile_employeeId_effectiveFrom_idx"   ON "EmployeeTaxProfile"("employeeId", "effectiveFrom");
ALTER TABLE "EmployeeTaxProfile"
  ADD CONSTRAINT "EmployeeTaxProfile_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeTaxProfile_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 10. EmployeeDocument
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "EmployeeDocument" (
  "id"               TEXT NOT NULL,
  "clubId"           TEXT NOT NULL,
  "employeeId"       TEXT NOT NULL,
  "storageKey"       TEXT NOT NULL,
  "contentSha256"    TEXT NOT NULL,
  "sizeBytes"        INTEGER NOT NULL,
  "mimeType"         TEXT NOT NULL,
  "category"         TEXT NOT NULL,
  "sensitivity"     TEXT NOT NULL DEFAULT 'STANDARD',
  "displayName"      TEXT,
  "uploadedByUserId" TEXT,
  "uploadedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeeDocument_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmployeeDocument_clubId_idx"              ON "EmployeeDocument"("clubId");
CREATE INDEX "EmployeeDocument_employeeId_category_idx" ON "EmployeeDocument"("employeeId", "category");
CREATE INDEX "EmployeeDocument_contentSha256_idx"       ON "EmployeeDocument"("contentSha256");
ALTER TABLE "EmployeeDocument"
  ADD CONSTRAINT "EmployeeDocument_clubId_fkey"           FOREIGN KEY ("clubId")           REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeDocument_employeeId_fkey"       FOREIGN KEY ("employeeId")       REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeDocument_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id")     ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 11. Wire Employee.profilePhotoDocumentId / resumeDocumentId FKs.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE "Employee"
  ADD CONSTRAINT "Employee_profilePhotoDocumentId_fkey"
    FOREIGN KEY ("profilePhotoDocumentId") REFERENCES "EmployeeDocument"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "Employee_resumeDocumentId_fkey"
    FOREIGN KEY ("resumeDocumentId") REFERENCES "EmployeeDocument"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 12. EmployeeCredential
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "EmployeeCredential" (
  "id"             TEXT NOT NULL,
  "clubId"         TEXT NOT NULL,
  "employeeId"     TEXT NOT NULL,
  "credentialCode" TEXT NOT NULL,
  "displayName"    TEXT NOT NULL,
  "issuer"         TEXT,
  "reference"      TEXT,
  "issuedAt"       TIMESTAMP(3),
  "expiresAt"      TIMESTAMP(3),
  "documentId"     TEXT,
  "notes"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeCredential_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmployeeCredential_clubId_idx"                ON "EmployeeCredential"("clubId");
CREATE INDEX "EmployeeCredential_employeeId_expiresAt_idx"  ON "EmployeeCredential"("employeeId", "expiresAt");
ALTER TABLE "EmployeeCredential"
  ADD CONSTRAINT "EmployeeCredential_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeCredential_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 13. EmployeeEmergencyContact
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "EmployeeEmergencyContact" (
  "id"           TEXT NOT NULL,
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
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeEmergencyContact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmployeeEmergencyContact_clubId_idx"     ON "EmployeeEmergencyContact"("clubId");
CREATE INDEX "EmployeeEmergencyContact_employeeId_idx" ON "EmployeeEmergencyContact"("employeeId");
ALTER TABLE "EmployeeEmergencyContact"
  ADD CONSTRAINT "EmployeeEmergencyContact_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeEmergencyContact_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 14. EmployeeOnboardingInvitation
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "EmployeeOnboardingInvitation" (
  "id"               TEXT NOT NULL,
  "clubId"           TEXT NOT NULL,
  "employeeId"       TEXT NOT NULL,
  "tokenHash"        TEXT NOT NULL,
  "expiresAt"        TIMESTAMP(3) NOT NULL,
  "revokedAt"        TIMESTAMP(3),
  "redeemedAt"       TIMESTAMP(3),
  "redeemedByIpHash" TEXT,
  "issuedByUserId"   TEXT NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeeOnboardingInvitation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmployeeOnboardingInvitation_tokenHash_key" ON "EmployeeOnboardingInvitation"("tokenHash");
CREATE INDEX        "EmployeeOnboardingInvitation_clubId_idx"    ON "EmployeeOnboardingInvitation"("clubId");
CREATE INDEX        "EmployeeOnboardingInvitation_employeeId_idx" ON "EmployeeOnboardingInvitation"("employeeId");
CREATE INDEX        "EmployeeOnboardingInvitation_expiresAt_idx" ON "EmployeeOnboardingInvitation"("expiresAt");
ALTER TABLE "EmployeeOnboardingInvitation"
  ADD CONSTRAINT "EmployeeOnboardingInvitation_clubId_fkey"         FOREIGN KEY ("clubId")         REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeOnboardingInvitation_employeeId_fkey"     FOREIGN KEY ("employeeId")     REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeOnboardingInvitation_issuedByUserId_fkey" FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id")     ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 15. EmployeeOnboardingSession
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "EmployeeOnboardingSession" (
  "id"                TEXT NOT NULL,
  "clubId"            TEXT NOT NULL,
  "employeeId"        TEXT NOT NULL,
  "initiatedByUserId" TEXT NOT NULL,
  "approvedByUserId"  TEXT,
  "state"             TEXT NOT NULL DEFAULT 'DRAFT',
  "startedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"       TIMESTAMP(3),
  "submittedAt"       TIMESTAMP(3),
  "approvedAt"        TIMESTAMP(3),
  "rejectedAt"        TIMESTAMP(3),
  "rejectionReason"   TEXT,
  CONSTRAINT "EmployeeOnboardingSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmployeeOnboardingSession_clubId_idx"           ON "EmployeeOnboardingSession"("clubId");
CREATE INDEX "EmployeeOnboardingSession_employeeId_state_idx" ON "EmployeeOnboardingSession"("employeeId", "state");
ALTER TABLE "EmployeeOnboardingSession"
  ADD CONSTRAINT "EmployeeOnboardingSession_clubId_fkey"            FOREIGN KEY ("clubId")            REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeOnboardingSession_employeeId_fkey"        FOREIGN KEY ("employeeId")        REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeOnboardingSession_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "User"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeOnboardingSession_approvedByUserId_fkey"  FOREIGN KEY ("approvedByUserId")  REFERENCES "User"("id")     ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 16. EmployeeOnboardingStateTransition
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "EmployeeOnboardingStateTransition" (
  "id"              TEXT NOT NULL,
  "clubId"          TEXT NOT NULL,
  "employeeId"      TEXT NOT NULL,
  "sessionId"       TEXT,
  "fromState"       TEXT NOT NULL,
  "toState"         TEXT NOT NULL,
  "actorSource"     TEXT NOT NULL,
  "actorUserId"     TEXT,
  "actorEmployeeId" TEXT,
  "reason"          TEXT,
  "at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeeOnboardingStateTransition_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmployeeOnboardingStateTransition_clubId_idx"        ON "EmployeeOnboardingStateTransition"("clubId");
CREATE INDEX "EmployeeOnboardingStateTransition_employeeId_at_idx" ON "EmployeeOnboardingStateTransition"("employeeId", "at");
ALTER TABLE "EmployeeOnboardingStateTransition"
  ADD CONSTRAINT "EmployeeOnboardingStateTransition_clubId_fkey"      FOREIGN KEY ("clubId")      REFERENCES "Club"("id")     ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeOnboardingStateTransition_employeeId_fkey"  FOREIGN KEY ("employeeId")  REFERENCES "Employee"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeOnboardingStateTransition_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id")     ON DELETE SET NULL ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 17. EmployeeOnboardingQuestion (clubId NULLABLE — global catalogue)
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "EmployeeOnboardingQuestion" (
  "id"           TEXT NOT NULL,
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
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeOnboardingQuestion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmployeeOnboardingQuestion_clubId_key_key"                    ON "EmployeeOnboardingQuestion"("clubId", "key");
CREATE INDEX        "EmployeeOnboardingQuestion_clubId_section_displayOrder_idx"   ON "EmployeeOnboardingQuestion"("clubId", "section", "displayOrder");
ALTER TABLE "EmployeeOnboardingQuestion"
  ADD CONSTRAINT "EmployeeOnboardingQuestion_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- 18. EmployeeOnboardingResponse
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE "EmployeeOnboardingResponse" (
  "id"           TEXT NOT NULL,
  "clubId"       TEXT NOT NULL,
  "sessionId"    TEXT NOT NULL,
  "questionId"   TEXT NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'PENDING',
  "responseJson" TEXT,
  "answeredAt"   TIMESTAMP(3),
  "reviewedAt"   TIMESTAMP(3),
  "reviewerNote" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeOnboardingResponse_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmployeeOnboardingResponse_sessionId_questionId_key" ON "EmployeeOnboardingResponse"("sessionId", "questionId");
CREATE INDEX        "EmployeeOnboardingResponse_clubId_idx"               ON "EmployeeOnboardingResponse"("clubId");
CREATE INDEX        "EmployeeOnboardingResponse_sessionId_idx"            ON "EmployeeOnboardingResponse"("sessionId");
ALTER TABLE "EmployeeOnboardingResponse"
  ADD CONSTRAINT "EmployeeOnboardingResponse_clubId_fkey"     FOREIGN KEY ("clubId")     REFERENCES "Club"("id")                      ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeOnboardingResponse_sessionId_fkey"  FOREIGN KEY ("sessionId")  REFERENCES "EmployeeOnboardingSession"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeOnboardingResponse_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "EmployeeOnboardingQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
