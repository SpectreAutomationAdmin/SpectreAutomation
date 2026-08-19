-- HR-1H (2026-08-16) — enforce at most one VERIFIED bank account per
-- employee at the DB level. Complements the service-layer invariant in
-- src/lib/hr/bank-account.ts (at most one non-terminal row per
-- employee). Historical INACTIVE / REJECTED / PENDING_PENNY_TEST rows
-- are unconstrained and permitted.
--
-- "VERIFIED" is the exclusive status that means "current payroll
-- destination" — set only by activateBankAccount, cleared by
-- rejectBankAccount / deactivateBankAccount, and superseded by
-- upsertBankAccount's history-preserving transaction.

CREATE UNIQUE INDEX "EmployeeBankAccount_employeeId_verified_key"
  ON "EmployeeBankAccount" ("employeeId")
  WHERE status = 'VERIFIED';
