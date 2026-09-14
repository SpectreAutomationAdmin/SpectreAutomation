# Canonical Payroll UI Architecture

Payroll Consolidation slice (2026-09-14 · shipped in v397).

## The rule

**`Finance → Payroll` (`/app/admin/payroll`) is the ONE canonical payroll workspace.**

All new payroll features MUST be implemented against this workspace and its canonical domain services under `src/lib/payroll/**`. Do NOT add new user-facing functionality to the retired legacy Ops payroll (`/app/admin/ops/payroll`) or invent a parallel workspace.

## Why this document exists

The founder discovered in v396 that a lifecycle action ("Discard Prepared Payroll") had been implemented against the process subroute (`/app/admin/payroll/process`), invisible from Finance → Payroll where the founder actually operates payroll. This document exists so future sessions do NOT repeat that mistake.

## What's canonical

| Surface | Route | Component | Backing service | Prisma model |
|---|---|---|---|---|
| **Canonical entry** | `/app/admin/payroll` | `PayrollAdminOverview` | `buildPayrollOverview` (`src/lib/payroll/overview-view.ts`) | `PayrollBatch` |
| Setup | `/app/admin/payroll/setup` | `MembershipEditor`, `PayGroupsEditor`, `PayrollConfigForm`, `PayrollCalendarSection`, `GlProfileEditor` | Various under `src/lib/payroll/**` | `PayGroup`, `PayGroupMember`, `PayrollPayPeriod`, `PayrollClubConfig`, `PayrollGlAccountingProfile` |
| Time approvals | `/app/admin/payroll/time` | `PayrollTimeWorkspace`, `TimesheetApprovalWorkspace` | `src/app/app/admin/payroll/time/_timesheet-actions.ts` | `TimesheetEntry`, `PayrollDepartmentTimeApproval` |
| Processing | `/app/admin/payroll/process` | `PayrollProcessWorkspace`, `TimeReadinessSection` | `preparePayrollBatch`, `discardPreparedPayrollBatch`, `voidPayrollBatch` | `PayrollBatch` |
| Batch review | `/app/admin/payroll/batches/[batchId]` | `PayrollReviewWorkspace` | `getBatchReview` | `PayrollBatch` |
| Batch GL preview | `/app/admin/payroll/batches/[batchId]/gl` | GL preview | `gl-readiness` | `PayrollBatch` + `JournalEntry` |
| Paystubs | `/app/admin/payroll/batches/[batchId]/paystubs` | Paystubs | `pay-statement` | `PayrollBatch`, statements |
| History | `/app/admin/payroll/history` | Inline page | `listPostedPayrollHistory` | `PayrollBatch` (filtered POSTED) |

All of the above use the canonical `PayrollBatch` model and services from `src/lib/payroll/**`.

## What's retired

| Legacy route | Legacy component | Legacy service | Status |
|---|---|---|---|
| `/app/admin/ops/payroll` | inline `PayrollPage` | `payrollService` from `@/lib/ops` (`buildRun` / `postRun`, flat 22% tax placeholder) | **Retired** — now `redirect("/app/admin/payroll")` |
| Operations → "Payroll (legacy)" nav | — | — | **Removed from sidebar** |
| Operations → "Payroll setup / time / processing / history" nav | — | — | **Removed from sidebar** — routes remain reachable via deep-links, back-links, and WI cards, but no top-level nav |
| Operations index Card "Payroll" | — | — | **Removed** |
| Search-index Employee URLs pointing at `/app/admin/ops/payroll` | — | — | **Fixed** — Employee search hits now land on `/app/admin/people/employees/[id]` (HR profile, gated by `hr:employee:read`) |

The `payrollService` in `src/lib/ops/payroll.ts` and the `PayrollRun` / `PayrollLine` Prisma models remain in the codebase for now — they are used by tests + seed and the schema itself documents a planned rename (`LegacyOpsPayrollRun`). Deleting them is out of scope for this slice; the important behaviour is that NO production surface still invokes them (the only prior consumer, `/app/admin/ops/payroll/page.tsx`, is now a redirect).

## Where lifecycle actions live in the canonical workspace

The `ActionsCard` inside `PayrollAdminOverview` (right rail, next to Payroll Actions header) renders lifecycle controls state-aware:

- **No batch yet**: Prepare Payroll button lives in the Header (not ActionsCard).
- **PREPARED**: Calculate Payroll (primary), **Discard Prepared Payroll** (secondary/destructive, red-text link below).
- **CALCULATED**: Return to Preparation OR Submit for Approval (depending on attestation state).
- **SUBMITTED_FOR_APPROVAL**: Awaiting Approval status pill.
- **APPROVED**: Approved status pill (Post is a Controller action from the review workspace — SoD).
- **RETURNED_FOR_CORRECTION**: Returned pill + Return-to-Preparation link.
- **POSTED**: Posted status pill.

All action tiles above the state-dependent buttons (Review Exceptions, Add One-Time Adjustment, Manage Recurring Components, View Time Approvals) navigate to the appropriate tab within the canonical workspace via `?tab=<name>`.

## Authoritative domain services

Under `src/lib/payroll/**` (list is authoritative — do NOT duplicate any of these elsewhere):

| Verb | Service | File |
|---|---|---|
| Prepare | `preparePayrollBatch` | `batch-preparation.ts` |
| Void (non-PREPARED pre-Post) | `voidPayrollBatch` | `batch-preparation.ts` |
| Discard Prepared Payroll | `discardPreparedPayrollBatch` | `batch-preparation.ts` |
| Calculate | `calculatePayrollBatch` | `calculation-execute.ts` |
| Return to Preparation | `returnBatchToPreparation` | `return-to-preparation.ts` |
| Submit for Approval | `submitPayrollBatch` | `submit-payroll-batch.ts` |
| Approve | `approveBatch` | `approve-and-post.ts` |
| Post | `postPayrollBatch` | `approve-and-post.ts` |
| Read: prepared batch view | `getPreparedBatch` | `batch-preparation.ts` |
| Read: calculated review | `getBatchReview` | `review-dto.ts` |
| Read: canonical Overview view-model | `buildPayrollOverview` | `overview-view.ts` |
| Read: history | `listPostedPayrollHistory` | `pay-statement.ts` |

## Legacy URL redirect policy

- `/app/admin/ops/payroll` → server-side `redirect("/app/admin/payroll")` (unconditional; the old page component is gone).
- `/app/admin/payroll/setup|time|process|history` are canonical routes and continue to render normally — they are targets of Work Intake deep-links with load-bearing search params. They just no longer appear in the sidebar.

## Do-not-do list

1. **Do not** implement a new payroll UI action anywhere except within `/app/admin/payroll` or one of its canonical subroutes.
2. **Do not** invoke `payrollService` from `@/lib/ops` from any new production code.
3. **Do not** add Sidebar entries pointing at `/app/admin/payroll/setup|time|process|history` or `/app/admin/ops/payroll`.
4. **Do not** implement Prepare / Calculate / Submit / Approve / Post independently of `src/lib/payroll/**`.

## When we can finally delete the legacy code

`src/lib/ops/payroll.ts` + `PayrollRun` / `PayrollLine` models + the schema comment planning `LegacyOpsPayrollRun` rename can be removed once:
- The schema rename lands (`PayrollBatch` → `PayrollRun` and legacy `PayrollRun` → `LegacyOpsPayrollRun`), OR
- All tests and seed are refactored off `PayrollRun`.

That's a separate slice.
