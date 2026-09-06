# Backlog · Work Intake PRIMARY origin uniqueness — platform hardening

**Filed:** 2026-09-06 during Payroll-3D-3B Slice 0 audit.
**Priority:** platform hygiene (not urgent, but a latent bug across the platform).
**Deferred from:** Payroll-3D-3B (explicit founder decision, 2026-09-06).

## Problem

`WorkIntakeOrigin` has a Prisma-level composite unique
`@@unique([workIntakeItemId, kind, referenceId, role])` — but the
`workIntakeItemId` is in the key, so **two different `WorkIntakeItem` rows
can share the same `(clubId, kind, referenceId, role='PRIMARY')` tuple**
under a concurrent-producer race. Nothing in the database prevents it.

Every current PRIMARY-origin creator uses the convention
`findFirst → create` (see e.g.
[timesheets/orchestration.ts:79](../../src/lib/timesheets/orchestration.ts#L79),
[payroll/orchestration.ts:133](../../src/lib/payroll/orchestration.ts#L133),
[calculation-execute.ts:642](../../src/lib/payroll/calculation-execute.ts#L642),
[ar-aging.ts:241](../../src/lib/intelligence/materialisers/ar-aging.ts#L241)),
which is race-prone. Under load, two concurrent producers can both
`findFirst` → both `create` → duplicate WI cards for the same obligation.

## Why this was NOT retrofitted in Payroll-3D-3B

Slice 0 audit determined that a global
`UNIQUE (clubId, kind, referenceId) WHERE role='PRIMARY'` cannot be
applied today because:

- **`INGESTED_DOCUMENT`** PRIMARY origins are written by two independent
  materialisers (AP invoice + AP statement) that dedupe against different
  views. See separate backlog item
  [ap-intake-ingested-document-dual-writer.md](./ap-intake-ingested-document-dual-writer.md).
- **`PAYROLL_DEPARTMENT_APPROVAL`** carries a code comment authorising
  two `referenceId` shapes
  ([payroll/orchestration.ts:23](../../src/lib/payroll/orchestration.ts#L23)):
  either `${payPeriodId}:${departmentId}` (used today) or a bare approval
  row id (permitted by the doc). Global unique would foreclose that
  latent option without an explicit decision.

3D-3B ships the narrow variant filtered to
`kind IN ('TIMECLOCK_CORRECTION_REVIEW', 'TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP')`.

## Proposed hardening slice

1. Resolve the `INGESTED_DOCUMENT` dual-writer semantics (see linked
   backlog item) — decide whether the two pipelines converge on one card
   or intentionally produce two.
2. Resolve the `PAYROLL_DEPARTMENT_APPROVAL` two-shape ambiguity —
   converge on the composite shape actually used in code today; update
   the comment; ship a defensive backfill check.
3. Add per-kind partial-unique indexes (or a global unique with
   documented exceptions) for the remaining `kind` values enumerated in
   [Slice 0 audit](../../scratchpad/…) — MEMBER_ACCOUNT, MEMBER,
   PAYROLL_TIMESHEET_APPROVAL, PAYROLL_TIMESHEET_APPROVAL_CONFIG_GAP,
   PAYROLL_DEPARTMENT_APPROVAL, PAYROLL_ADMIN_PROCESSING, PAYROLL_REVIEW,
   PAYROLL_FINAL_APPROVAL, PAYROLL_OPENING_BALANCE_REVIEW.
4. Refactor every creator to `try { create } catch (P2002) → refetch`
   (already the pattern being introduced in 3D-3B Slice 1 for
   TIMECLOCK_CORRECTION_REVIEW — extract as a shared helper).

## Existing race exposure — measurement first

Before shipping the migrations, count duplicate tuples in staging
(`clubId, kind, referenceId, role='PRIMARY'` GROUP BY HAVING COUNT > 1)
per kind. If any exist, decide per-kind: merge / delete duplicates /
grandfather.

## Not this slice

Do NOT expand Payroll-3D-3B to touch this. This is its own scope with
its own founder-authorised checkpoint sequence.
