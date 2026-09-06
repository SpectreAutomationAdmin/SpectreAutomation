-- Payroll MVP posting (2026-09-05) — Approve + Post + GL + paystubs.
--
-- Additive only. Introduces one new table and one new nullable column.

-- PayrollGlAccountingProfile — per-Club GL mapping.
CREATE TABLE "PayrollGlAccountingProfile" (
  "id"                             TEXT NOT NULL,
  "clubId"                         TEXT NOT NULL,
  "salaryExpenseAccountId"         TEXT NOT NULL,
  "employerCppExpenseAccountId"    TEXT NOT NULL,
  "employerEiExpenseAccountId"     TEXT NOT NULL,
  "netPayPayableAccountId"         TEXT NOT NULL,
  "cppPayableAccountId"            TEXT NOT NULL,
  "eiPayableAccountId"             TEXT NOT NULL,
  "federalTaxPayableAccountId"     TEXT NOT NULL,
  "provincialTaxPayableAccountId"  TEXT NOT NULL,
  "createdAt"                      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayrollGlAccountingProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PayrollGlAccountingProfile_clubId_key"
  ON "PayrollGlAccountingProfile"("clubId");
ALTER TABLE "PayrollGlAccountingProfile" ADD CONSTRAINT "PayrollGlAccountingProfile_clubId_fkey"
  FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollGlAccountingProfile" ADD CONSTRAINT "PayrollGlAccountingProfile_salaryExpenseAccountId_fkey"
  FOREIGN KEY ("salaryExpenseAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollGlAccountingProfile" ADD CONSTRAINT "PayrollGlAccountingProfile_employerCppExpenseAccountId_fkey"
  FOREIGN KEY ("employerCppExpenseAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollGlAccountingProfile" ADD CONSTRAINT "PayrollGlAccountingProfile_employerEiExpenseAccountId_fkey"
  FOREIGN KEY ("employerEiExpenseAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollGlAccountingProfile" ADD CONSTRAINT "PayrollGlAccountingProfile_netPayPayableAccountId_fkey"
  FOREIGN KEY ("netPayPayableAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollGlAccountingProfile" ADD CONSTRAINT "PayrollGlAccountingProfile_cppPayableAccountId_fkey"
  FOREIGN KEY ("cppPayableAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollGlAccountingProfile" ADD CONSTRAINT "PayrollGlAccountingProfile_eiPayableAccountId_fkey"
  FOREIGN KEY ("eiPayableAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollGlAccountingProfile" ADD CONSTRAINT "PayrollGlAccountingProfile_federalTaxPayableAccountId_fkey"
  FOREIGN KEY ("federalTaxPayableAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollGlAccountingProfile" ADD CONSTRAINT "PayrollGlAccountingProfile_provincialTaxPayableAccountId_fkey"
  FOREIGN KEY ("provincialTaxPayableAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PayrollClubConfig.glAccountingProfileId already existed as a nullable
-- String. Add the FK constraint pointing at the new profile table.
ALTER TABLE "PayrollClubConfig" ADD CONSTRAINT "PayrollClubConfig_glAccountingProfileId_fkey"
  FOREIGN KEY ("glAccountingProfileId") REFERENCES "PayrollGlAccountingProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- PayrollBatch.glJournalEntryId — link to the posted JournalEntry.
-- Unique so a batch can only be posted once.
ALTER TABLE "PayrollBatch" ADD COLUMN "glJournalEntryId" TEXT;
CREATE UNIQUE INDEX "PayrollBatch_glJournalEntryId_key"
  ON "PayrollBatch"("glJournalEntryId");
ALTER TABLE "PayrollBatch" ADD CONSTRAINT "PayrollBatch_glJournalEntryId_fkey"
  FOREIGN KEY ("glJournalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
