-- HR-1H (2026-08-16) — SQLite mirror of the Postgres partial unique
-- index enforcing "at most one VERIFIED bank account per employee".
-- SQLite 3.8.0+ supports partial indexes with WHERE clauses.
--
-- Prisma cannot declare partial unique indexes for SQLite in its
-- schema DSL, so this migration is applied via `prisma migrate`. In
-- test environments that use `prisma db push --force-reset` (which
-- reads the schema, not migrations), tests/global-setup.ts explicitly
-- re-creates this index after the push so the invariant is present
-- during vitest runs. That guarantees SQLite tests reflect production
-- Postgres behaviour.

CREATE UNIQUE INDEX "EmployeeBankAccount_employeeId_verified_key"
  ON "EmployeeBankAccount" ("employeeId")
  WHERE status = 'VERIFIED';
