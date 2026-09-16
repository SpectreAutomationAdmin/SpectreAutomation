-- v-slice-1-followup-7 (2026-09-15) — Payroll implementation cutover.
-- See prisma/schema.prisma for the full block comment.
--
-- One row per (clubId, taxYear). Prepare/Calculate refuses when no
-- confirmed row exists for the batch's tax year (must never silently
-- assume zero YTD). Under MID_YEAR_MIGRATION, Prepare/Calculate also
-- refuses when any included employee lacks an ACTIVE PayrollOpeningBalance.

CREATE TABLE "PayrollImplementationDeclaration" (
    "id"                    TEXT NOT NULL,
    "clubId"                TEXT NOT NULL,
    "taxYear"               INTEGER NOT NULL,
    "mode"                  TEXT NOT NULL,
    "firstSpectrePayDate"   TIMESTAMP(3),
    "confirmedAt"           TIMESTAMP(3),
    "confirmedByUserId"     TEXT,
    "notes"                 TEXT,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PayrollImplementationDeclaration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayrollImplementationDeclaration_clubId_taxYear_key"
    ON "PayrollImplementationDeclaration"("clubId", "taxYear");

CREATE INDEX "PayrollImplementationDeclaration_clubId_taxYear_idx"
    ON "PayrollImplementationDeclaration"("clubId", "taxYear");

ALTER TABLE "PayrollImplementationDeclaration"
    ADD CONSTRAINT "PayrollImplementationDeclaration_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
