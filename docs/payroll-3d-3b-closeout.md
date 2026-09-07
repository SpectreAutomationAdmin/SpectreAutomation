# Payroll-3D-3B — Closeout

**Status:** ACCEPTED AND CLOSED (2026-09-06)
**Branch:** `payroll-3d-3b`
**Final SHA:** `73fbe45`

## Final deployed versions (staging)

| App | Release | Rollback anchor |
|---|---|---|
| `spectre-staging` (web) | **v345** | v344 |
| `spectre-staging-worker` | **v121** | v120 |

Tenant: **Coulee Ridge Golf & Country Club**
Club id: `cmrvdeny7000144372ktmmg9c`
Slug: `spectre-staging-platform`
Data mode: `FOUNDER_REVIEW`

## Migrations applied (2026-09-06)

Prior last-applied on staging: `20260910_payroll_3c6_component_gl_mapping`.

Applied by this deploy (in order, via `prisma migrate deploy` release_command):

1. `20260911_payroll_3d3b_correction_review_partial_unique`
2. `20260912_payroll_3d3b_scope_approval_partial_unique`
3. `20260913_payroll_3d3b_scope_state_cas`

Migration 3 introduced:

- New table `PayrollDepartmentTimeScopeState` (`clubId`, `payPeriodId`, `departmentId`, `version`, unique + 2 indexes).
- New nullable column `PayrollDepartmentTimeApproval.approvedScopeVersion` (`INTEGER`).

Postgres metadata-only operations; zero row rewrites; zero destructive SQL.

## Accepted automated evidence

- Staging migrations applied cleanly.
- Web v345 healthy.
- Worker v121 healthy.
- `/api/health` returned 200 pre-deploy, post-web, post-worker.
- Neon recovery branch `pre-payroll-3c-3d-staging-deploy-2026-09-05` preserved (founder-confirmed).
- Real PostgreSQL 16 scope-version + CAS validation: `scripts/pg-validate-slice7b.mjs` → 20/20 pass (14 Slice 7B + 6 Slice 7C).
- Zero SQLSTATE 25P02 / 23505 in concurrency validation.
- Regression suites green:
  - `tests/work-intake` + `tests/timesheets`: **341/341** (19 files).
  - `tests/payroll`: **678 pass / 3 skip** (58 files).
- Staging Playwright suite (`tests/e2e/payroll-3d3b-slice8-staging.staging.spec.ts`): **6/6 pass**.
- Events Manager positive staging routing proven.
- Grounds Manager negative staging routing proven.
- Taylor employee-portal authentication proven (`taylor.hourly@fixture.spectre.test` + `TA1C-Preview-99`).
- Taylor `/employee/timesheets` staging render proven.
- Chris Turcato preserved byte-identical across all audits.
- Lise Montsion preserved byte-identical across all audits.
- `PayrollApprovedTimeEntry` delta: **0**.
- `PayrollBatch` delta: **0** (baseline 1 unchanged).
- `JournalEntry` delta: **0** (baseline 1 unchanged).
- Payment transmission: **0**.
- No known runtime defect discovered by Slice 8/8A.

## Explicitly deferred E2E scenarios (regression obligations for the upcoming employee-portal/time-attendance UI phase)

None of the below are blockers to closing 3D-3B. They MUST be automated as regression requirements once the related UI surfaces are redesigned.

1. Open shift → employee timesheet
2. Correction submission (employee portal)
3. Manager correction **Approve**
4. Manager correction **Reject**
5. Ready-scope Work Intake card
6. **Approve Time** (scope approval)
7. Material drift → REVIEW_REQUIRED
8. Re-approval
9. Configuration gap creation + remediation deep link
10. Payroll Admin Work Intake denial vs. detailed-workspace override
11. Worker recovery (requires a safe test-only BackgroundJob seam)
12. Sweep idempotency
13. Email-card regression (AI Summary tab, Conversation, Attachments)
14. AP-card regression (`IntelligenceReviewCard`)
15. Mixed Work Intake feed (email + AP + payroll + generic in same view)
16. Feed switching (email → payroll → AP → payroll → email)
17. Work Intake deep links (View timesheet · Review timesheets · Configure approver)
18. Keyboard / accessibility smoke on Approve / Reject / notes / Cancel / Approve Time

Preserved in-repo:

- `tests/e2e/payroll-3d3b-slice8-staging.staging.spec.ts` — 6/6 passing staging smoke.
- `scripts/pg-validate-slice7b.mjs` — real-Postgres concurrency validator.
- `scripts/payroll-staging-ta-fixture.ts` — extended `--reset-acceptance` including scope-state + approval + canonical WI cleanup.
- `scratchpad/slice8a-taylor-reset.js` — companion staging-container reset script (guarded).
- `scratchpad/slice8-founder-walkthrough.md` — interactive founder walkthrough for the deferred scenarios.

## Known Fly remote-builder OOM (workaround documented)

Fly's shared-cpu-2x remote builder SIGKILLs `prisma generate` against `prisma-postgres/schema.prisma` (>11k lines) at every tested heap ceiling (1536 / 2048 / 2560 / 2880 MB). Deterministic ~17 s to failure. Documented in `Dockerfile` around the `NODE_OPTIONS="--max-old-space-size=2560"` block and in commits `97ad8ff` + `b815e8e`.

**Workaround:** deploy with `flyctl deploy --local-only`. The local Docker daemon has full workstation memory. Used successfully for the Slice 7B/7C/8 deploy on 2026-09-06. Web + worker both deployed cleanly.

**Follow-up needed (out of scope for 3D-3B):** open a Fly infra ticket to bump the remote builder VM size, then revert to `--remote-only` deploys.

## Current synthetic fixture state (staging)

Verified via `staging-audit-post.js` and `slice8a-taylor-reset.js` runs on 2026-09-06:

- Taylor Fixture (`cmtjc2zux002tgnjulrcn7edv`) — PRIMARY→Grounds, SECONDARY→Events, `personalEmail=taylor.hourly@fixture.spectre.test`, portal credential active.
- `events.manager@fixture.spectre.test` (`cmtp9qg500007rcqlc81txj8y`) — DEPARTMENT_MANAGER, ACTIVE, owns Events `DEPARTMENT_TIME_APPROVAL`.
- `grounds.manager@fixture.spectre.test` — DEPARTMENT_MANAGER, ACTIVE, owns Grounds `DEPARTMENT_TIME_APPROVAL`.
- `fixture.pa@spectre.test` — PAYROLL_ADMIN, ACTIVE, **`passwordHash="!disabled"`** (created by `payroll-3b5b3a-staging-fixture.ts:98`; cannot authenticate via the standard `/login` form; interactive PA verification uses the founder session).
- `fixture.controller@spectre.test` — CONTROLLER, ACTIVE.
- Post-reset Taylor state: 0 clock events, 0 timesheets, 0 corrections, 0 approvals, 0 scope-state rows.
- Pre-existing pre-Slice-7B legacy `approvedScopeVersion=NULL` row (`cmtpdxamy00354mv0henucd1f`, Events, `approvedRevision='464aaeecc...'`) was Taylor's synthetic approval; deleted by the extended reset per §3 contract. §11 legacy-fallback code path remains proven by `tests/work-intake/slice7c-postgres-attribution.test.ts §11`.
- Fixture password contract: `TA1C-Preview-99` (per `scripts/payroll-staging-ta-fixture.ts`).

## No known functional blocker

- All shipped 7B/7C code behaves correctly on real Postgres 16 and on the deployed staging binary.
- No error / warning surfaced in `flyctl logs --app spectre-staging` post-deploy (checked; only benign mission-control.ap-review.loaded / statement-review.loaded polling info entries).
- Legacy `approvedScopeVersion=NULL` rows are handled via the §11 revision-only fallback and do not require backfill.

## Next recommended development phase

**Employee-portal / Time & Attendance UI redesign.**

Substantial UI work is expected on:

- Clock In / Clock Out
- Active-shift presentation
- Breaks
- Employee timesheets
- Correction requests
- Payroll / time information
- Responsive desktop + mobile employee experience

The 18 deferred regression obligations above become the acceptance checklist for that phase — each redesigned surface must ship with the corresponding automated coverage. Building exhaustive Slice 8A automation against the current UI would create disposable test effort that the redesign would immediately invalidate.

## Rollback plan (retained for reference)

- Web: `flyctl releases rollback --app spectre-staging v344`
- Worker: `flyctl releases rollback --app spectre-staging-worker v120`
- Neon: recovery branch `pre-payroll-3c-3d-staging-deploy-2026-09-05` remains available.

---

**Final status:** Payroll-3D-3B — ACCEPTED AND CLOSED.
