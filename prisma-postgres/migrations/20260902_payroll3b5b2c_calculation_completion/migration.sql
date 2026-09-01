-- Payroll-3B-5B-2c Gross-to-Net Completion (2026-09-02).
-- Additive forward-only migration. Single nullable text column
-- for the versioned per-employee calculation explanation snapshot
-- (see prisma/schema.prisma for the doc block). Zero data-loss
-- risk; nothing is deployed to staging or production yet.

ALTER TABLE "PayrollBatchEmployee"
  ADD COLUMN "calculationExplanationJson" TEXT;
