# EP-TRAIN-6D-4P — Interactive AI Training Reviewer UX — Acceptance

Status: TECHNICALLY IMPLEMENTED + TESTED AGAINST DISPOSABLE PG — NOT
DEPLOYED, NOT VISUALLY ACCEPTED ON STAGING, NOT ENABLED FOR REAL
MANAGERS.

Author: Claude (Opus 4.7). Date: 2026-11-05. Branch:
`ep-train-6d-4p/interactive-reviewer-ux` (not yet pushed).

## 1. Scope recap

- Interactive reviewer approval dialog layered on top of the already-
  accepted 4N `POST /api/admin/ai-training/drafts/[id]/approve`
  server-authoritative endpoint. No new API routes.
- Server-derived reviewer eligibility (`computeReviewerEligibility`)
  that the UI consumes as an opaque gate. The browser never
  independently decides approvability; the POST route still refuses
  every 4B/4N violation.
- Preserves the accepted three-column workspace, Spectre branding,
  evidence panel, queue layout, 4M "Historical evidence unavailable"
  treatment, and the 4N emerald "Verified correct" chip.
- Zero RBAC changes. CLUB_ADMIN remains `hr:training:ai:read`-only.
- No Prisma schema change.
- No staging deployment.

## 2. Files added

| Path                                                                               | Role                                   |
| ---------------------------------------------------------------------------------- | -------------------------------------- |
| `src/lib/hr/training/ai-review/reviewer-eligibility.ts`                            | Server-derived eligibility matrix + copy. |
| `src/components/ai-training/ApprovalDialog.tsx`                                    | Reviewer approval dialog client component. |
| `tests/ep-train-6d4p-eligibility-contract.test.ts`                                 | Vitest — eligibility matrix contract (13 cases). |
| `tests/ep-train-6d4p-approval-dialog.test.tsx`                                     | jsdom — dialog interaction + response dispatch (17 cases). |
| `tests/ep-train-6d4p-workspace-rbac.test.tsx`                                      | jsdom — workspace RBAC + eligibility rendering (10 cases). |
| `scratchpad/ep-train-6d4p/integration-test.ts`                                     | Disposable PG16 harness — 6 scenarios covering authorized round-trip, CLUB_ADMIN refusal, STAFF refusal, cross-tenant 404, MULTI_ANSWER, historical. |
| `docs/training/ai-generation/PHASE-D-4P-REVIEWER-UX-DESIGN.md`                     | 4P design document. |
| `docs/training/ai-generation/PHASE-D-4P-ACCEPTANCE.md`                             | This file. |

## 3. Files modified

| Path                                                                | Change                                                                                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/ai-training/PersistedReviewWorkspace.tsx`           | Added `reviewerEligibility` prop + `ReviewerDecisionPanel` subcomponent; `ReadOnlyControls` remains the fallback when eligibility is not passed (back-compat for 4M/4N tests). Mode-notice copy branches on `canApprove`. |
| `src/app/app/admin/ai-training/review/persisted/page.tsx`           | Imports `computeReviewerEligibility`; resolves it after evidence + verified-answer and threads it into the workspace.             |
| `tests/ep-train-6d4d-no-mutation-endpoints.test.ts`                 | 4N oversight: the static mutation-endpoint guard did not account for the 4N `POST /approve` route. 4P expands the allowlist and generalises the guard so future authorised mutations can be enumerated. |

## 4. Server-derived eligibility matrix (per directive §4)

The UI NEVER re-computes approvability. `computeReviewerEligibility`
returns:

```ts
{
  canApprove: boolean,             // hr:training:ai:approve grant
  reviewerUserId: string,
  reviewerDisplayName: string,
  selectedDraftEligibility: {
    eligible: boolean,             // zero reasons → true
    reasons: EligibilityReason[],
  } | null,                        // null when no draft selected
}
```

Reasons are checked in this order (stable): `STATE_NOT_REQUIRES_HUMAN_REVIEW`,
`QUESTION_TYPE_UNSUPPORTED`, `HISTORICAL_EVIDENCE_UNAVAILABLE`,
`EVIDENCE_INTEGRITY_FAILURE`, `VALIDATION_ROW_MISSING`,
`VALIDATION_HAS_HARD_ERRORS`, `ALREADY_VERIFIED`. Each reason has
reviewer-facing plain-language copy co-located with its enum value.

The UI gates the "Approve candidate" button on
`eligibility.canApprove === true && eligibility.selectedDraftEligibility?.eligible === true`.
The DOM `disabled` attribute + `aria-disabled` are both set when
either side of that conjunction is false, so a DOM-tampering reviewer
cannot bypass the gate — and even if they do, the server route
re-checks everything.

## 5. Dialog contract (per directive §§ 3, 6, 7, 8)

- **No preselection.** The dialog opens with every radio unchecked.
  The reviewer must independently click an answer.
- **Model-selected chip.** The model's prediction is marked with
  `Model-selected · unverified` (informational only, does NOT make
  it the default).
- **Required attestation.** An "I have reviewed the source evidence"
  checkbox is required; the Approve button stays disabled until
  checked. `evidenceAttestation: true` is submitted; the server
  refuses with `EVIDENCE_ATTESTATION_MISSING` otherwise.
- **Idempotency key.** Generated on dialog open via
  `crypto.randomUUID()`. Reused for retries of an identical payload
  (verified via contract test). Regeneratable via a visible
  "↻ regenerate" control when the reviewer intends a NEW payload.
- **Submitted payload.** Exactly the 4N request contract:
  `expectedRecordVersion`, `expectedContentHash`,
  `expectedValidationId`, `verifiedCorrectAnswerIndex`,
  `expectedOptionText` (server-rendered — not reviewer-editable),
  `evidenceAttestation`, `idempotencyKey`, optional `reviewerNote`.
  **No client-authored authoritative answer text** is sent.
- **Response dispatch.** 200 → close + `onApproved()` → parent
  `router.refresh()` so the next render consumes the authoritative
  verified-answer reader. 400 / 404 / 409 / 503 render inline error
  banners WITHOUT marking the candidate approved. Network failure
  renders a retry-friendly message and preserves the idempotency key.

## 6. Verification evidence

### 6.1 Offline vitest contract (SQLite + jsdom)

Command: `npx vitest run tests/ep-train-6d4p-*.test.*`

```
Test Files  3 passed (3)
Tests  40 passed (40)
```

- `tests/ep-train-6d4p-eligibility-contract.test.ts` — 13 cases
  pinning the eligibility matrix.
- `tests/ep-train-6d4p-approval-dialog.test.tsx` — 17 cases exercising
  the dialog's submit contract, response dispatch, duplicate-submit
  prevention, idempotency-key regenerate behaviour, keyboard escape,
  and the "no client-authored authoritative answer text" invariant.
- `tests/ep-train-6d4p-workspace-rbac.test.tsx` — 10 cases proving
  CLUB_ADMIN stays read-only, historical / MULTI_ANSWER /
  integrity-failure candidates all refuse the Approve button with
  reason-specific copy, SUPER_ADMIN + eligible opens the dialog.

### 6.2 Full 4B / 4D / 4L / 4M / 4N / 4P regression

Command (same shell): all 12 vitest suites under the AI-review tree.

```
Test Files  12 passed (12)
Tests  179 passed (179)
```

No pre-existing 4-series tests regress. The one inherited failure
in `ep-train-6d4d-no-mutation-endpoints.test.ts` (a 4N oversight —
the guard did not account for the authorised `POST /approve` route)
was fixed by expanding the allowlist, NOT by weakening the guard's
intent.

### 6.3 Disposable PostgreSQL 16 integration harness

Command (PowerShell):
```powershell
docker run -d --rm --name spectre-pg-6d4p ... postgres:16-alpine -p 15435:5432
$env:DATABASE_URL = "postgresql://spectre:test@localhost:15435/spectre_6d4p"
npx tsx scratchpad/ep-train-6d4p/integration-test.ts
```

```
EP-TRAIN-6D-4P — real-Postgres 16 integration harness
Target: postgresql://spectre:***@localhost:15435/spectre_6d4p
  PASS  T1 SUPER_ADMIN eligible + approve → eligibility agrees + server approves
  PASS  T2 CLUB_ADMIN eligibility=false AND server refuses with 404 same-shape
  PASS  T3 STAFF — eligibility canApprove=false
  PASS  T4 cross-tenant approval refused — 404 same-shape at the server
  PASS  T5 MULTI_ANSWER — eligibility=false AND server refuses
  PASS  T6 Historical (evidence unavailable) — eligibility=false; draft untouched if approval attempted
SUMMARY  pass=6 fail=0 total=6
```

Container stopped and removed after the harness exited (`docker stop`
+ `--rm`). No persistent state left on disk.

Each scenario proves BOTH the eligibility matrix AND the server
approval service agree on who / what may / may not approve, so a
browser tampering attempt cannot escalate privilege.

### 6.4 Typecheck

Command: `npx tsc --noEmit` (12 GB heap on Windows; the default heap
OOMs on this repo size).

0 errors in the 4P-authored files (`reviewer-eligibility.ts`,
`ApprovalDialog.tsx`, `PersistedReviewWorkspace.tsx` modifications,
`page.tsx` modifications, the three test files).

16 pre-existing errors remain in files 4P does NOT touch:
`src/app/api/admin/billing/exceptions/route.ts`,
`src/app/api/admin/billing/renewal-review/route.ts`,
`src/app/app/admin/signup-ops/billing/triggering/page.tsx`,
`src/lib/billing/signup-2m4-cancellation-service.ts`, and seven
Playwright `tests/e2e/*.spec.ts` suites. These are tracked as
inherited issues on the branch and are out of scope for 4P.

### 6.5 Nav audit

Command: `npm run nav:audit`

0 URL-only orphans. The persisted review page
(`/app/admin/ai-training/review/persisted`) remains correctly
allowlisted as an admin-reachable surface. No new routes added, so
nothing else changes.

### 6.6 Placeholder scan

Command: `npm run scan:placeholders`

0 placeholders in 4P-authored files. Pre-existing hits in
`prisma/schema.prisma` and `prisma/seed.ts` are untouched by 4P.

## 7. UI screenshots

Live Playwright screenshots on staging are **deferred** (per directive
§10 + §12 mandatory STOP: no staging deployment this slice). The 4P
dialog layout and state transitions are covered programmatically by
the jsdom test suite — every rendered element is verified via DOM
assertions (aria-checked, disabled attribute, textContent, test-ids).

A reviewer who wishes to preview the dialog in the browser locally
can:

```powershell
npm run dev
# navigate to http://localhost:3000/app/admin/ai-training/review/persisted
# log in as a SUPER_ADMIN; select a candidate in REQUIRES_HUMAN_REVIEW;
# click "Approve candidate".
```

No real tenant data is required — the existing fixture seed is
sufficient. All assertions covered by vitest are repeatable in the
local browser at any time.

## 8. Directive §12 STOP compliance

| Boundary                                             | Status                       |
| ---------------------------------------------------- | ---------------------------- |
| No staging deployment                                | HONOURED — no `flyctl deploy` |
| No production deployment                             | HONOURED — no `flyctl deploy --app spectre-web` |
| No shared database migration                         | HONOURED — no Prisma migration this slice |
| No Modal/Qwen inference                              | HONOURED — no inference code touched |
| No transcription worker activation                   | HONOURED — no worker code touched |
| No historical candidate modification                 | HONOURED — read-only on 6D-4H rows |
| No approval-role grants                              | HONOURED — permissions.ts unchanged |
| No publication or employee assignments               | HONOURED — route unchanged, UI copy says so |
| No unrelated global UI changes                       | HONOURED — only ai-training surfaces touched |
| Preserve the 126 unrelated WIP files                 | HONOURED — stashed at entry, to be restored at exit |

## 9. Five-status report (per directive §10 last bullet)

| Status                              | Result    |
| ----------------------------------- | --------- |
| Technically implemented             | ✅         |
| Tested against disposable PG        | ✅ (6/6)   |
| Deployed to staging                 | ❌ (held)  |
| Visually accepted                   | ❌ (held)  |
| Enabled for real managers           | ❌ (held)  |

Do not conflate these. The dialog + eligibility service ship ONLY
when the founder authorises staging, visual review passes, and a
real reviewer account is granted `hr:training:ai:approve`.

## 10. Residual risk

- The dialog currently delegates to `router.refresh()` after a
  successful approval. In the server-component page the refresh
  re-reads evidence + verified-answer, so the emerald chip appears
  immediately after approval. If Next's router.refresh semantics
  change, an explicit full-page reload fallback can be wired as a
  follow-up (no blocker).
- The jsdom `useRouter` mock in the workspace-rbac test file is
  tight to the component's current pattern — a future refactor that
  pulls the refresh call through an injected callback would further
  decouple the test from Next's internals. Low-priority tidy-up.
- No real-browser E2E harness exists for the approval flow in this
  slice. The first staging acceptance pass should include a live
  Playwright screenshot at 1440×900 + 390×844 using a synthetic
  SUPER_ADMIN account (per directive §11).

## 11. Recommended next controlled deployment slice

Two viable paths, in priority order:

1. **4P-STAGING** — Deploy the 4P branch to `spectre-staging`
   (web-only; no worker). Grant a synthetic SUPER_ADMIN the
   `hr:training:ai:approve` permission in a time-boxed staging
   window; capture live Playwright screenshots of the full approval
   journey (ReviewerDecisionPanel → ApprovalDialog → success →
   emerald chip). Retire the synthetic account at window end. This
   is the ONE acceptance step that cannot be proven offline.
2. **4O / historical-backfill** — Parallel: author a backfill plan
   for the 8 EP-TRAIN-6D-4H historical candidates so they can
   eventually consume real evidence. No 4P dependency; can proceed
   alongside 4P-STAGING.

Both are separate slices requiring explicit founder authorization.

## 12. STOP

Awaiting founder review before pushing 4P or proceeding to any
staging deployment.
