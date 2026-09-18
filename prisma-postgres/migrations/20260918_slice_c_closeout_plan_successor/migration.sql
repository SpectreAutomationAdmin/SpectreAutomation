-- Slice C final UI acceptance (2026-09-18)
-- Adds self-referential `predecessorPlanId` to PayrollBenefitPlan so an
-- effective-dated Change Plan can preserve historical configuration by
-- inserting a successor row that points back at the row it replaced.
-- Metadata-only edits (name / description / providerName / notes) still
-- update in place — they never create a successor.

ALTER TABLE "PayrollBenefitPlan"
  ADD COLUMN "predecessorPlanId" TEXT;

ALTER TABLE "PayrollBenefitPlan"
  ADD CONSTRAINT "PayrollBenefitPlan_predecessorPlanId_fkey"
  FOREIGN KEY ("predecessorPlanId") REFERENCES "PayrollBenefitPlan"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "PayrollBenefitPlan_predecessorPlanId_idx"
  ON "PayrollBenefitPlan"("predecessorPlanId");
