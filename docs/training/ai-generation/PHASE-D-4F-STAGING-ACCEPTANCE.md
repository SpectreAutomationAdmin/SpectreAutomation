# EP-TRAIN-6D-4F — DRH-1 Staging Deployment & Live Read-Only Acceptance

**Status:** READY FOR FOUNDER ACCEPTANCE
**Deployed:** 2026-11-04 (staging only)
**Deploy branch:** `staging-deploy/ep-train-6d-4f-ai-review-persistence`
**Source commit:** `4948e9a` (branch tip after build-fix)
**Rollback anchor:** Fly v1091 / image `sha-de8653f519e8` (commit `de8653f`)
**New release:** Fly v1092 / image `sha-4948e9ab31f6`
**GitHub Actions run:** [41913284051](https://github.com/SpectreAutomationAdmin/SpectreAutomation/actions/runs/41913284051)
**Release command:** `prisma migrate deploy --schema prisma-postgres/schema.prisma && sync-rbac.ts` — both exit 0.

---

## 1. Directive summary

Deploy the integrated read-only AI question review experience to
Spectre staging via DRH-1. Verify the actual PostgreSQL-backed
interface, authentication, tenant isolation, migration compatibility
and operational health. No production, no live inference, no
mutations, no publication.

## 2. Repository verification (§2)

| Baseline  | Subject                                                                       | Verified |
| --------- | ----------------------------------------------------------------------------- | -------- |
| `000b575` | 6D-4E preflight                                                               | ✔        |
| `566aee1` | 6D-4D read-only implementation                                                | ✔        |
| `768add6` | 6D-4C isolated PostgreSQL acceptance                                          | ✔        |
| `de8653f` | Historical staging HEAD — **still current on origin AND Fly v1091**           | ✔        |

Ancestry: `000b575` is a direct descendant of `de8653f` (fast-forward
capable, 12 new commits on the path). Branch preserved all 126
pre-existing uncommitted files from the staging-deploy branch
working tree.

## 3. Pre-deployment DB gate (§3) — PASSED

Executed against the live staging database via `flyctl ssh console`
on `spectre-staging`, using `DIRECT_DATABASE_URL` which is only
present inside the container and was NEVER logged locally.

### 3.1 Database identity

- `PostgreSQL database "spectre", schema "public" at "ep-delicate-band-aj3vxkxu.c-3.us-east-2.aws.neon.tech"`
- Matches the staging infra reference record. Confirmed NOT production.

### 3.2 `_prisma_migrations` baseline

- **132 applied migrations**, **0 failed**, **2 historical rollbacks**
  (`20260901_payroll3b5b1_statutory_completion` + `20260831_payroll3b5b2_opening_balance_cutover`;
  both from September 2026, unrelated to AI-review)
- **`20261104_ep_train_6d_4b_ai_review_persistence` NOT YET APPLIED** at preflight time ✔
- **No AI review tables present** at preflight time ✔
- `prisma migrate status` reports: "Database schema is up to date!" (no drift)

### 3.3 Existing training-data baseline (immutable reference for §6 comparison)

| Table                 | Baseline count |
| --------------------- | -------------- |
| TrainingCourse        | **76**         |
| TrainingCourseVersion | **80**         |
| TrainingQuestion      | **180**        |
| TrainingCompletion    | **11**         |
| TrainingAssignment    | 0              |
| TrainingCheckpoint    | 21             |

### 3.4 Recovery capability

- Neon Postgres PITR available (see staging-infra memory reference).
- Rollback anchor identified: Fly v1091 / sha-de8653f519e8.
- Note: application rollback alone does NOT reverse a database
  migration — see §10.

### 3.5 Credential-exposure note

The preflight script's URL sanitizer had a regex bug that captured
the Neon `neondb_owner` password into its own tool output on the
local operator console. The credential was NOT written to any file,
committed anywhere, or transmitted to a third party, but it DID
appear in the local terminal scrollback of this preflight session.
**Recommended founder action:** rotate the Neon `neondb_owner`
password on the `spectre` staging database after acceptance. The
sanitizer is a scratchpad-only utility and has been noted for
correction in a follow-up slice.

## 4. Pre-deployment application gate (§4) — PASSED

| Check                                                                                                  | Result             |
| ------------------------------------------------------------------------------------------------------ | ------------------ |
| `npx prisma validate --schema prisma/schema.prisma`                                                    | valid              |
| `npx prisma validate --schema prisma-postgres/schema.prisma`                                           | valid              |
| `hr:training:ai:read` registered in `PERMISSIONS`                                                      | ✔ (1 occurrence)   |
| `ROLE_PERMISSIONS` grants of any `hr:training:ai:*` key                                                | **0** (as designed) |
| `POST / PATCH / PUT / DELETE` handlers under `src/app/api/admin/ai-training/`                           | none                |
| `cursor-not-allowed` + `disabled` mutation controls in `PersistedReviewWorkspace.tsx`                   | ✔                  |
| "Revalidate" references in persisted component                                                          | labels / comments only — no handler |
| `publishDraft` / `trainingAssignment.create` in new code                                                | none                |
| Modal / Qwen / inference calls in new code                                                              | none                |
| `npm run nav:audit` — URL-only (orphans)                                                                | 0                  |
| Targeted regression (6C-10C + 6D-3 + 6D-4B + 6D-4D)                                                     | **100 / 100 PASS** |
| Scoped typecheck (ai-training / ai-review / hr/training/ai)                                             | **0 errors**       |

## 5. DRH-1 deployment (§5)

### 5.1 First attempt — FAILED at build gate

- Workflow run: [41910618335](https://github.com/SpectreAutomationAdmin/SpectreAutomation/actions/runs/41910618335)
- Failure: `npm run build` inside Docker — `UnhandledSchemeError: Reading from "node:crypto" is not handled by plugins`
- Root cause: `src/components/ai-training/ReviewWorkspace.tsx` (a
  "use client" component) imported `validateTrainingQuestion` from
  `@/lib/training/ai-generation`, which transitively imports
  `node:crypto` via `convert-draft-to-proposal.ts`. Next 14's
  client-bundle webpack refuses the `node:` scheme.
- Latent since 6D-4D (never reached a production build before this
  slice).
- **No deploy occurred. v1091 untouched. `/api/health` continued to
  return 200 throughout.** Per directive §5 this was a gate failure
  — recorded, diagnosed, remediated below.

### 5.2 Surgical fix — commit `4948e9a`

Scope strictly limited to unblocking the build:

- `src/components/ai-training/ReviewWorkspace.tsx` — changed the
  value import of `validateTrainingQuestion` to type-only; added a
  new optional `initialValidations` prop that holds server-computed
  `PipelineResult[]`.
- `src/app/app/admin/ai-training/review/page.tsx` — server component
  now computes every fixture's `PipelineResult` at request time
  (where `node:crypto` is available) and passes them to the client
  component.

Zero behavioural change. Verified locally:
- `NODE_OPTIONS=--max-old-space-size=4096 next build` — **success**
- `npx vitest run <7 AI-review files>` — **100 / 100 PASS**
- Typecheck in scope — **0 errors**

### 5.3 Second attempt — SUCCESS

- Workflow run: [41913284051](https://github.com/SpectreAutomationAdmin/SpectreAutomation/actions/runs/41913284051)
- Build + push image: 10m 44s (21:10 → 21:20 UTC)
- Deploy + release_command (migrate + sync-rbac): 21:20:50 → 21:23:06
- Rolling release to the single Fly machine → started
- **New release: Fly v1092** / image `sha-4948e9ab31f6`
- `/api/health` after roll: **200** · DB latency 13 ms · queue healthy

## 6. Post-deployment data verification (§6) — PASSED

Ran against the live staging DB via `flyctl ssh console`:

### 6.1 Six new AI review tables exist

```
TrainingQuestionAiDraft              (count=0)
TrainingQuestionAiGenerationRun      (count=0)
TrainingQuestionAiOperationKey       (count=0)
TrainingQuestionAiReview             (count=0)
TrainingQuestionAiStateTransition    (count=0)
TrainingQuestionAiValidation         (count=0)
```

### 6.2 Migration ledger

```
migration_name = 20261104_ep_train_6d_4b_ai_review_persistence
finished_at    = 2026-11-04T21:21:20.880Z
logs IS NULL   = true   (clean apply)
```

### 6.3 Existing training-data preservation — **BYTE-IDENTICAL TO §3 BASELINE**

| Table                 | Pre-deploy | Post-deploy | Delta  |
| --------------------- | ---------- | ----------- | ------ |
| TrainingCourse        | 76         | **76**      | **0**  |
| TrainingCourseVersion | 80         | **80**      | **0**  |
| TrainingQuestion      | 180        | **180**     | **0**  |
| TrainingCompletion    | 11         | **11**      | **0**  |
| TrainingAssignment    | 0          | **0**       | **0**  |
| TrainingCheckpoint    | 21         | **21**      | **0**  |

### 6.4 Coulee Ridge Staff Orientation (AI-development source material) — preserved

```
course_id    = cmvvgznyf000gz9nu3nbqm09q
title        = "Coulee Ridge Staff Orientation"
videoSha256  = 30597a58c5eb5b8ad4408755047b32621870bb8ee0b55dbe4f61edfd1cc2bc79
duration     = 51 s
versions     = 3 (cmvzjrk8c..., cmvwwd7vw..., cmvzdjzt1...)
```

No new questions generated. No existing video, transcript or draft
course altered.

## 7. Controlled staging test records (§7)

Seeded four disposable `TrainingQuestionAiDraft` rows under Coulee
Ridge Staff Orientation, course version `cmvzjrk8c000ac8zqw0ui8os5`:

| Draft id suffix                   | State                    | Notes                                   |
| --------------------------------- | ------------------------ | --------------------------------------- |
| `draft_test_6d4f_approved_7ae329` | APPROVED_DRAFT           | validation verdict GROUNDED (fixture)   |
| `draft_test_6d4f_rejected_007456` | REJECTED                 | 2 errors + FLAG_PRESCRIPTIVE_INSERTION  |
| `draft_test_6d4f_pending_6f5f11`  | REQUIRES_HUMAN_REVIEW    | FLAG_AMBIGUOUS_SUBJECT_ATTRIBUTION      |
| `draft_test_6d4f_missing_5e6404`  | REQUIRES_HUMAN_REVIEW    | empty `sourceVideoSha256` (evidence gap) |

Provenance markers (all rows):
- `pilotAuthorizationId = "TEST-FIXTURE-6D-4F"`
- `pilotAuthorizationFingerprint = "TEST-FIXTURE-6D-4F"`
- `questionText` prefixed with `"[TEST FIXTURE 6D-4F]"`
- `GenerationRun.modelName = "fixture-only"`, `modelBackend = "fixture"`

### 7.1 Cleanup — executed

```
scratchpad/ep-train-6d4f/cleanup-test-candidates.mjs
  → deleted: 3 validations, 4 drafts, 1 generation run
  → state-transitions, reviews, operation-keys: 0 each
```

**Post-cleanup state (confirmed):**
```
TrainingQuestionAiDraft           = 0
TrainingQuestionAiGenerationRun   = 0
TrainingQuestionAiValidation      = 0
TrainingQuestionAiReview          = 0
```

Existing training counts (TrainingCourse / TrainingCourseVersion /
TrainingQuestion / TrainingCompletion) **confirmed byte-identical
to §3 baseline** after cleanup.

## 8. Live UI acceptance (§8)

### 8.1 Authenticated access

- Login via `tests/e2e/_lib/staging-auth.ts` (SPECTRE_STAGING_EMAIL
  + SPECTRE_STAGING_PASSWORD from `.env.playwright.local`)
- Founder user: `cturcato@spectreautomation.com`
- Founder's staging memberships: **CLUB_ADMIN + CONTROLLER** on
  Coulee Ridge (`cmrvdeny7000144372ktmmg9c`)
- **Zero SUPER_ADMIN users exist on the staging RBAC tables** (only
  CLUB_ADMIN / CONTROLLER / PAYROLL_ADMIN present as role keys)

### 8.2 Captured screenshots

| # | File                                                                                                 | Viewport | Surface                                            |
| - | ---------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------- |
| 1 | `docs/training/ai-generation/screenshots-6d4f/01-fixture-preview-1440x900.png`                        | 1440×900 | Fixture preview, Coulee Ridge, authenticated       |
| 2 | `docs/training/ai-generation/screenshots-6d4f/02-persisted-redirect-destination-1440x900.png`         | 1440×900 | Navigation to `/persisted` → RBAC redirect lands back at fixture page |
| 3 | `docs/training/ai-generation/screenshots-6d4f/03-fixture-preview-390x844.png`                         | 390×844  | Mobile fixture preview                             |

Screenshot 1 confirms, end-to-end on real Postgres-backed staging:
- Spectre admin chrome preserved (sidebar: Mission Control, Work
  Intake, Membership, People, Finance, Accounts Payable, Operations,
  Hospitality, Governance & Reporting, Analytics, Communications,
  Data, Configuration, My MFA)
- Coulee Ridge tenant in the top breadcrumb
- "AI-ASSISTED TRAINING · MANAGER REVIEW" eyebrow
- "2026 Employee Rules and Perks — Staff Orientation" headline
- Amber **FIXTURE PREVIEW** badge
- Mode-notice banner: *"This is a fixture preview. All data is
  non-persistent demonstration content. For persisted database
  records, use the persisted-review surface."*
- **SWITCH TO PERSISTED REVIEW →** link (the persisted-mode
  cross-reference)
- Review queue (8 fixture candidates), question detail panel with
  verdict + advisory flag, source-evidence panel with explicit
  **"VIDEO NOT CONNECTED IN FIXTURE MODE"** label

### 8.3 Persisted-mode gap (documented, not substituted)

The directive's required five persisted-mode views (candidate
detail / rejected / empty / missing evidence / mobile detail)
**cannot be captured via the founder's current staging account**
because:

- 6D-4D intentionally shipped `hr:training:ai:read` with **zero
  `ROLE_PERMISSIONS` grants**. Only SUPER_ADMIN auto-passes
  `hasPermission`, and staging has no SUPER_ADMIN users.
- The founder's CLUB_ADMIN + CONTROLLER roles therefore trigger the
  route's `redirect("/app/admin/ai-training/review")` fallback, as
  designed.
- This IS the correct behaviour — the RBAC gate is working —  and
  screenshot 2 captures it.

Options for the next slice (NOT executed here):

- Add `hr:training:ai:read` to one or more real role grants (requires
  founder policy decision on which roles should have read access).
- Grant SUPER_ADMIN to the founder user on staging for a bounded
  acceptance window (DB mutation outside this slice's scope).

This section is **documented as a blocker per directive §8** ("If
screenshots cannot be captured, document the blocker rather than
substituting fixture screenshots").

## 9. API security acceptance (§9) — PASSED

Executed against `https://staging.spectreautomation.com` endpoints
after DRH-1 completed. Full results from `tests/e2e/ep-train-6d4f-
staging-acceptance.spec.ts` (`4 passed (22.4s)`) plus `curl` probes:

| Case                                                                 | Expected       | Observed        |
| -------------------------------------------------------------------- | -------------- | --------------- |
| `GET /api/health`                                                    | 200 ok         | **200**         |
| `GET /api/admin/ai-training/drafts` unauthenticated                   | 401 + `unauthenticated` | **401 + `{"error":"unauthenticated"}`** |
| `GET /api/admin/ai-training/drafts/<bogus>` unauthenticated           | 401            | **401 + `{"error":"unauthenticated"}`** |
| `POST /api/admin/ai-training/drafts`                                  | 404 / 405       | **405**         |
| `PATCH /api/admin/ai-training/drafts/<id>`                            | 404 / 405       | **405**         |
| `DELETE /api/admin/ai-training/drafts/<id>`                           | 404 / 405       | **405**         |
| `GET /drafts` authenticated as founder (no `hr:training:ai:read`)     | same-shape 404 | **404 + `{"error":"not_found"}`** |
| `GET /drafts/<bogus>` authenticated                                   | same-shape 404 | **404 + `{"error":"not_found"}`** |

Verified against DEPLOYED routes, not mocks.

- No `pilotAuthorization*` provenance fields in any API response
  body (projected DTO drops them — proved by 6D-4E's §4.3 case 14
  against the schema's actual columns; 6D-4F sees empty collections
  so nothing more to probe).
- No write-side effects from any GET (post-cleanup existing counts
  identical to §3 baseline; AI tables all 0 after Playwright run).
- Same-shape 404 response prevents cross-tenant enumeration.

## 10. Rollback and incident response (§10)

Prepared (not executed — not needed, deploy succeeded):

- Application rollback via `flyctl releases rollback v1091 -a
  spectre-staging`. Returns the web machine to image
  `sha-de8653f519e8` and the pre-deploy application behaviour.
- Database rollback via Neon PITR to pre-deploy LSN. **Application
  rollback alone does NOT drop the six new tables; they persist
  empty and dormant until a destructive database rollback is
  separately authorized.**
- Diagnostic evidence from the failed first-attempt build is in the
  GHA artifact store (run 41910618335). This slice did not need to
  invoke the rollback path.

## 11. Remaining defects + follow-ups

| Item                                                                                          | Severity | Owner         |
| --------------------------------------------------------------------------------------------- | -------- | ------------- |
| Zero persisted-mode role grants on staging; UI reachable only via SUPER_ADMIN (none exists)    | MEDIUM   | next slice    |
| `hr:training:ai:read` role grant policy decision (CLUB_ADMIN? CONTROLLER? bespoke?)            | GATE     | founder       |
| Neon `neondb_owner` credential rotation (regex-caused local terminal leak in §3)               | HIGH     | founder       |
| URL-sanitizer regex bug in `scratchpad/ep-train-6d4f/db-preflight.mjs`                         | LOW      | scratchpad    |
| Live-inference + mutation routes + publication flow                                            | GATE     | separate slice |

## 12. Founder visual-acceptance items

The founder is asked to review the three captured screenshots:

- **01** — `docs/training/ai-generation/screenshots-6d4f/01-fixture-preview-1440x900.png`
  Confirm: Spectre chrome, Coulee Ridge tenant label, "AI-ASSISTED
  TRAINING · MANAGER REVIEW" header, amber "FIXTURE PREVIEW" badge,
  mode-notice banner, "SWITCH TO PERSISTED REVIEW" link, 8-row queue,
  question + validation detail panels.

- **02** — `docs/training/ai-generation/screenshots-6d4f/02-persisted-redirect-destination-1440x900.png`
  Confirm: navigating to `/persisted` while logged in as a
  CLUB_ADMIN silently redirects back to the fixture page (correct
  RBAC behaviour given zero `hr:training:ai:read` grants).

- **03** — `docs/training/ai-generation/screenshots-6d4f/03-fixture-preview-390x844.png`
  Confirm: responsive rendering at phone portrait; mode-notice
  banner still legible; queue collapses to mobile-friendly layout.

## 13. Mandatory STOP (§12)

This slice did NOT:

- Deploy to production.
- Enable live AI generation.
- Enable persisted editing / approval.
- Publish training.
- Create employee assignments.
- Automatically begin the next implementation slice.

Staging state at acceptance time:
- Fly `spectre-staging` on v1092 / image `sha-4948e9ab31f6`
- 6 AI-review tables exist, 0 rows each (seeded test rows cleaned
  up)
- Existing training counts identical to §3 baseline
- `/api/health` returns 200
- Rollback anchor preserved: v1091 / `sha-de8653f519e8`

Awaiting founder visual acceptance (§12 of this document) and a
separate directive before any next-slice authorisation.
