# Payroll — staging migration audit (2026-09-01)

Audit performed for Payroll-3B-5B-3A before the first deliberate
Payroll staging deployment. All Payroll-related migrations that
have accumulated between HR-2B3 and Payroll-3B-5B-2c are listed
below in application order (Prisma applies by directory name
alphanumerically, which matches the intended timeline).

| # | Directory | Slice | Additive? | Notes |
|---|-----------|-------|-----------|-------|
| 1 | `20260822_hr2b3_club_payroll_province` | HR-2B3 | ✅ | Adds `Club.payrollProvince` (nullable). |
| 2 | `20260829_payroll3a_foundation` | Payroll-3A | ✅ | Adds `PayrollLedger` / `PayrollProfile` / KMS-wrapped SIN / bank-account model foundations. |
| 3 | `20260830_payroll3b2_pay_group_calendar_anchor` | Payroll-3B-2 | ✅ | Adds `PayrollPayGroup.calendarAnchorDate` (nullable). |
| 4 | `20260831_payroll3b3_department_time_approval` | Payroll-3B-3 | ✅ | Adds `PayrollDepartmentTimeApproval` + `PayrollApprovedTimeEntry`. |
| 5 | `20260901_payroll3b4_batch_preparation` | Payroll-3B-4 | ✅ | Adds `PayrollBatch`, `PayrollBatchEmployee`, `PayrollBatchException`, `PayrollBatchEarning`, `PayrollBatchDeduction`, `PayrollBatchAllowanceSnapshot`. |
| 6 | `20260901_payroll3b5a_statutory_ytd_foundation` | Payroll-3B-5A | ✅ | Adds `PayrollStatutoryPackage`, `PayrollOpeningBalance`. |
| 7 | `20260901_payroll3b5b1_a_employee_dob_cpp_eligibility` | Payroll-3B-5B-1a | ✅ | Adds `Employee.dateOfBirth`, `EmployeeCppElection`, `EmployeeCppDisabilityStatus`. **Renamed from `20260901_payroll3b5b1a_…` on 2026-09-01 (closeout) — the original name sorted AFTER `20260901_payroll3b5b1_statutory_completion` (underscore < 'a' in ASCII), so `statutory_completion` tried to reference `EmployeeCppElection` before it was created. Rename is safe because the migration had never been recorded on any deployed database.** |
| 8 | `20260901_payroll3b5b1_statutory_completion` | Payroll-3B-5B-1 | ✅ | Adds YTD split columns on `PayrollOpeningBalance` + `PayrollBatch.statutoryPackageId`. |
| 9 | `20260901_payroll3b5b1b_cra_verification` | Payroll-3B-5B-1b | ✅ | Adds classification-decoupled `pensionable` / `insurable` columns on `EmployeeAllowance` and `PayrollBatchAllowanceSnapshot`; adds TD1 supplementary columns on `EmployeeTaxProfile`. |
| 10 | `20260901aa_payroll3b5b2_opening_balance_cutover` | Payroll-3B-5B-2 pre-calc gate | ✅ | Adds `PayrollOpeningBalance.throughPayDate` (nullable). **Renamed from `20260831_…` on 2026-09-01 to fix Prisma migration ordering — the original date sorted before `20260901_payroll3b5a_statutory_ytd_foundation` (which creates the `PayrollOpeningBalance` table), causing `ALTER TABLE … relation does not exist` on the first staging deploy attempt. Rename is safe because the migration had never been recorded on any deployed database.** |
| 11 | `20260901_payroll3b5b2a_calculation_foundation` | Payroll-3B-5B-2a | ✅ | Adds `PayrollBatch.calculatedAt/calculationVersion/algorithmVersion/packageChecksum` + 5 new statutory result columns on `PayrollBatchEmployee` + `ytdSnapshotJson`. |
| 12 | `20260902_payroll3b5b2c_calculation_completion` | Payroll-3B-5B-2c | ✅ | Adds `PayrollBatchEmployee.calculationExplanationJson`. |

## Additive / forward-only confirmation

Every migration in the list is **`ALTER TABLE … ADD COLUMN …`** or
**`CREATE TABLE …`** — no `DROP`, no `RENAME`, no data-loss
default changes on existing columns. All new columns are either
nullable, or take a safe `DEFAULT` value (integer 0 for
`calculationVersion`). No migration issues a data-mutating
statement.

## Prisma migration engine

Postgres schema at `prisma-postgres/schema.prisma`. Applied via the
staging release command `prisma migrate deploy` (see
`deploy/fly.web.toml`).

## Staging data-safety review

- The synthetic staging fixture (`scripts/payroll-3b5b3a-staging-fixture.ts`)
  creates its own tagged Employees (`employeeNumber` prefixed with
  `payroll-3b5b3a-staging-fixture:`), never touching real staff.
- The fixture assigns synthetic Payroll Admin + Controller users
  (`fixture.pa@spectre.test`, `fixture.controller@spectre.test`).
  These are fixture-owned and password-disabled — they do not
  provide login capability.
- No real HR employee record is edited by the fixture.
- No real SIN, banking, or TD1 information is generated.

## Deployment readiness gate

Before running `flyctl deploy --config deploy/fly.web.toml`:

- [x] `npx tsc --noEmit` clean locally.
- [x] Full Payroll regression green (`npx vitest run tests/payroll/`).
- [x] Every migration in this list has run against local dev DB
      via `npx prisma db push --schema=prisma/schema.prisma`.
- [x] Migration list confirmed additive-only (above).
- [x] Fixture is idempotent — repeated `npx tsx scripts/payroll-3b5b3a-staging-fixture.ts <clubId>`
      does not create duplicate batches / employees / pay periods.

## Rollback anchor

Prior to deployment:
- Record the current staging release version + image via
  `flyctl status -a spectre-staging`.
- If deployment causes an issue, roll back with
  `flyctl releases rollback <n> -a spectre-staging`.

## Worker deploy decision

**No** — this slice adds no worker changes. Only web is deployed.
