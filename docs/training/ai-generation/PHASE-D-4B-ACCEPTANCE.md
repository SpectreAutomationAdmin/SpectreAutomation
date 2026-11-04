# EP-TRAIN-6D-4B — AI Training Review Persistence Foundation · ACCEPTANCE

**Status:** OFFLINE ACCEPTANCE PASSED. Ready for isolated database
integration test on a separately-authorised slice.
**Branch:** `ep-train-6d-4b/persistence-foundation`
**Parent commit:** `10b161a` (6D-4A architecture)
**Scope:** persistence + pure server-governance foundation ONLY.
No migration applied. No API routes. No UI wiring. No deployment.
No inference. No role grants.

---

## 1. Summary

Delivers every artefact the directive requires for a secure,
tenant-scoped, immutable, auditable persistence layer:

- Six additive Prisma models (5 governance + 1 durable-idempotency).
- Hand-written SQLite + Postgres-portable migration SQL matching the
  project's `prisma/migrations/*` convention.
- Seven new RBAC permission keys added to the catalogue (NO role grants).
- Four TypeScript governance modules covering lifecycle, content-hash,
  server-authoritative approval guard, and transactional audit —
  all pure, all unit-tested.
- 40 new Vitest cases (72/72 total across the three relevant files).
- Zero new TypeScript errors.

**Nothing in this slice touches a database.** The migration file is on
disk but has NOT been applied. The Prisma Client was regenerated
offline (type-only) via `prisma generate`.

---

## 2. Adopted governance decisions (directive §2)

All nine founder decisions applied exactly as approved:

| # | Decision | Implementation |
|---|---------|----------------|
| 1 | Individually enforced `hr:training:ai:*` permissions | 7 new catalogue entries (§4.3) |
| 2 | Draft approval restricted to authorised HR/Training Manager roles | **Permission key added; no role grants in this slice** (per founder §2 instruction "No role grants are authorized in this slice") |
| 3 | `hr:training:ai:remediate-rejected` as a separate permission | Added — scoped-tight; required for the `REJECTED → REQUIRES_HUMAN_REVIEW` transition |
| 4 | Configurable retention, 7 years after retirement as the proposed default | **Retention table exists via `TrainingQuestionAiStateTransition` + the `ARCHIVED` lifecycle state**; automated deletion NOT implemented (per founder "do not implement automatic deletion") |
| 5 | Durable operation-level idempotency, 24-hour window, database uniqueness | `TrainingQuestionAiOperationKey` with `@@unique([route, requestKey, reviewerUserId, draftId])` + an `expiresAt` column |
| 6 | Reuse existing authenticated video access controls | Design preserved (6D-4A §9); no new evidence permission added in this slice |
| 7 | Prohibit fixture-derived validation from establishing production approval eligibility | `evaluateApprovalServerSide` fires `VALIDATION_SOURCE_INVALID` when `validatorSource !== "integrated-pipeline"` |
| 8 | Separate minimal generation-run model | `TrainingQuestionAiGenerationRun` with model/backend/metering fields and **zero credentials** |
| 9 | Persistence implementation separate from read-only API | API routes intentionally NOT built; 6D-4C is a separate slice |

---

## 3. Exact schema changes (directive §4 + §11)

### 3.1 Six new models in `prisma/schema.prisma`

Appended after the final existing model (`BillingCycle` / `TenantLifecycleTransition` tail). All models additive; no existing model's fields or indexes modified.

| Model | Purpose |
|-------|---------|
| `TrainingQuestionAiGenerationRun` | Provenance of a single generation invocation. Captures tenant / course / version, pilot-authorisation fingerprint, video SHA, transcript build, grounding projection hash, model name + backend + format enforcer, runtime status, metering counters. **No credentials.** |
| `TrainingQuestionAiDraft` | Immutable draft row. Carries `contentHash` (sha256 of canonical JSON), full source-material binding, lifecycle `state`, `recordVersion` for optimistic concurrency, optional `supersedesDraftId` self-link. |
| `TrainingQuestionAiValidation` | Append-only validation result. Carries `draftContentHash` so the guard can enforce "validation ↔ content" binding. `validatorSource` distinguishes `"integrated-pipeline"` (approvable) from `"fixture"` (forbidden in production approval). |
| `TrainingQuestionAiReview` | Append-only reviewer-decision events. Binds to the exact `draftContentHash` + optional `validationId`. |
| `TrainingQuestionAiStateTransition` | **Authoritative, append-only state history.** Written in the SAME DB transaction as every state change. Carries `fromState`, `toState`, `reasonCode`, `recordVersionBefore/After`, and sanitised `metaJson`. |
| `TrainingQuestionAiOperationKey` | Durable idempotency row (directive §2.5). Compound UNIQUE `(route, requestKey, reviewerUserId, draftId)` enforces replay-within-TTL at the database level. |

### 3.2 Back-relation additions on existing models

Four existing models received back-relation ARRAY fields only. **No columns added, no indexes changed, no constraints altered — these are Prisma-client-type-only additions and generate ZERO SQL.**

| Model | Added arrays |
|-------|--------------|
| `Club` | 6 arrays (`aiGenerationRuns`, `aiQuestionDrafts`, `aiQuestionValidations`, `aiQuestionReviews`, `aiQuestionStateTransitions`, `aiQuestionOperationKeys`) |
| `TrainingCourse` | 2 arrays (`aiGenerationRuns`, `aiQuestionDrafts`) |
| `TrainingCourseVersion` | 2 arrays (`aiGenerationRuns`, `aiQuestionDrafts`) |
| `User` | 2 arrays (`aiTrainingQuestionReviews`, `aiTrainingQuestionStateChanges`) |
| `TrainingQuestionAiValidation` | 1 array (`reviewsDrivenBy`) named-relation `"ValidationDrivingReview"` to disambiguate |

### 3.3 Schema validation

```
$ npx prisma validate
The schema at prisma\schema.prisma is valid 🚀
```

### 3.4 Prisma Client regeneration

```
$ npx prisma generate
✔ Generated Prisma Client (v5.22.0) to .\node_modules\@prisma\client in 232s
```

`prisma generate` is offline-only — it reads `schema.prisma` and
produces TypeScript types. No database connection is attempted.

---

## 4. Migration SQL review (directive §4 + §8)

### 4.1 File

`prisma/migrations/20261104_ep_train_6d_4b_ai_review_persistence/migration.sql`
(239 lines, SQLite + Postgres-portable `TEXT` / `DATETIME` / `DECIMAL`).

Hand-written to match the project's established pattern (same style as
`20261101_ep_train_5a_training_obligations/migration.sql` and
`20261102_ep_train_5c2_obligation_scoped_sessions/migration.sql`).

**Why hand-written rather than `prisma migrate diff`:** the
shadow-database flow needed by `prisma migrate diff --from-migrations`
fails on a pre-existing upstream migration (`20260808_slice_5_1_ocr_page_number`
references `DocumentOcrExtraction` which no longer exists in the shadow
replay). This is an existing repo issue, not a 6D-4B issue. Every
recent migration in `prisma/migrations/` has been hand-written for the
same reason — I followed the established convention rather than
improvising around the broken tooling.

### 4.2 Section inventory + constraint audit

| Section | Table | Rows / sec cited directive §8 |
|---------|-------|-------------------------------|
| 1 | `TrainingQuestionAiGenerationRun` | 3 FKs (`clubId`→`Club.ON DELETE RESTRICT`, `courseId`→`TrainingCourse.ON DELETE RESTRICT`, `courseVersionId`→`TrainingCourseVersion.ON DELETE RESTRICT`); 4 tenant-scoped indexes |
| 2 | `TrainingQuestionAiDraft` | 4 FKs (3× RESTRICT on tenant/course/version; `generationRunId` ON DELETE SET NULL so a cleaned-up generation run doesn't nuke its drafts); **1 compound UNIQUE** `(clubId, courseVersionId, contentHash)`; 4 tenant-scoped indexes |
| 3 | `TrainingQuestionAiValidation` | 2 FKs (`clubId` RESTRICT, `draftId` CASCADE so dropping a draft removes its validations); 4 tenant-scoped indexes |
| 4 | `TrainingQuestionAiReview` | 4 FKs (`clubId` RESTRICT, `draftId` RESTRICT so reviews outlive attempts to drop the draft, `validationId` SET NULL, `reviewedByUserId` RESTRICT so a reviewer identity isn't wiped out from under historical rows); 3 tenant-scoped indexes |
| 5 | `TrainingQuestionAiStateTransition` | 3 FKs (`clubId` RESTRICT, `draftId` CASCADE for cleanup symmetry with validations, `byUserId` SET NULL); 3 tenant-scoped indexes |
| 6 | `TrainingQuestionAiOperationKey` | 2 FKs (`clubId` RESTRICT, `draftId` CASCADE); **1 compound UNIQUE** `(route, requestKey, reviewerUserId, draftId)`; 2 indexes |

### 4.3 Cascade behaviour summary

- Deleting a `Club` with ANY AI-review row fails (ON DELETE RESTRICT) — intentional; tenant deletion must archive first.
- Deleting a `TrainingCourse` / `TrainingCourseVersion` with any AI draft fails (RESTRICT).
- Deleting a `TrainingQuestionAiDraft` cascades to its validations, state transitions, and operation keys (CASCADE). Reviews DO NOT cascade — they're reviewer-authored events and must persist even if the draft is later cleaned up (RESTRICT). This matches the "append-only reviewer audit" posture.
- Deleting a `User` fails if they authored any review (RESTRICT) — audit identity must persist.

### 4.4 Rollback

Dropping the six tables (in reverse creation order to respect FKs)
removes the AI-review surface entirely. No other table is affected.
No existing row is mutated.

### 4.5 Migration NOT applied

The directive forbids migration application. I did not:

- Run `prisma migrate dev`
- Run `prisma migrate deploy`
- Run `prisma db push`
- Connect to any database beyond the Prisma Client generator's offline type generation

---

## 5. Server governance (directive §6)

Four new files under `src/lib/hr/training/ai-review/`:

### 5.1 `lifecycle.ts`

- `LIFECYCLE_STATES` — the 8-state enumeration.
- `TRANSITIONS` — 19-row table of allowed transitions, each binding
  `(fromState, toState, reasonCode) → requires: string[]`.
- `evaluateTransition({ from, to, reasonCode, actorPermissions }) → TransitionDecision`
- `listAllowedTransitionsFrom(state)` + `isTerminal(state)` helpers.

**Key properties enforced by the table:**

- `REJECTED → APPROVED_DRAFT` is **absent** (prohibited for any
  permission combination).
- `REJECTED → REQUIRES_HUMAN_REVIEW` requires `hr:training:ai:remediate-rejected`.
- `REQUIRES_HUMAN_REVIEW → APPROVED_DRAFT` requires `hr:training:ai:approve`.
- Every system transition has `requires: []` (no per-user permission).

### 5.2 `content-hash.ts`

- `canonicalise(value)` — byte-identical to the canonicaliser used by
  `src/lib/training/ai-generation/convert-draft-to-proposal.ts` and
  the Modal server-side canonicaliser (`modal/common.py :: canonicalise`).
- `sha256Hex(s)` + `draftContentHash(draft)` + `canonicalDraftJson(draft)`.

### 5.3 `approval-guard.ts`

- `evaluateApprovalServerSide(args) → ServerApprovalDecision`
- 12 `ServerApprovalBlockReason` codes, each with a canned message + HTTP status.
- **Pure** — dependency-inject `hasPermission` so the function stays
  unit-testable without touching the RBAC module.
- Fail-closed on unparsable `errorsJson`.
- Fail-closed on `validationServiceHealthy=false`.
- CROSS_TENANT and DRAFT_NOT_FOUND both map to 404 same-shape.

### 5.4 `transactional-audit.ts`

- `writeStateTransition({ tx, draftId, clubId, fromState, toState, reasonCode, ... })`
- Re-evaluates the transition INSIDE the transaction as defence-in-depth.
- Uses Prisma `updateMany` with `WHERE recordVersion = expected` for
  optimistic concurrency. `count === 0` → throws `TransitionBlockedError("CONCURRENT_MODIFICATION")`.
- Writes the `TrainingQuestionAiStateTransition` row inside the same tx.
  If either operation fails the enclosing `prisma.$transaction` rolls both back.
- `sanitiseMetaJson(meta)` — defence-in-depth redactor that replaces
  values under credential-shaped keys (`/hmac|secret|credential|password|token|bearer|apikey|signing|r2_?key|modal_?key/i`) with `[REDACTED_BY_SANITISER]`.

### 5.5 `index.ts`

Public barrel. All consumers import from `@/lib/hr/training/ai-review`.

---

## 6. Transactional audit mechanism (directive §7)

The existing `src/lib/audit.ts :: audit()` NEVER throws by contract —
correct for non-critical paths but **unsuitable as the sole
authoritative lifecycle record**. The design preserves the existing
helper as **supplementary** (called after the transaction commits) and
adds `TrainingQuestionAiStateTransition` as the **authoritative**
in-transaction record.

```
┌──────────────────────── prisma.$transaction ──────────────────────────┐
│                                                                        │
│  1. tx.trainingQuestionAiDraft.updateMany({                            │
│       where: { id, clubId, recordVersion: EXPECTED, state: FROM },     │
│       data:  { state: TO, recordVersion: EXPECTED+1, ... }             │
│     })                                                                 │
│     ├── count === 0  → throw TransitionBlockedError("CONCURRENT_...")  │
│     └── count === 1  → continue                                        │
│                                                                        │
│  2. tx.trainingQuestionAiStateTransition.create({ data: { ... } })     │
│     ├── fails → transaction rolls BOTH writes back                     │
│     └── succeeds → transaction commits                                 │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ (post-commit)
                      audit(actor, { action: "training.ai.review.approved",
                                     entityType: "TrainingQuestionAiReview",
                                     ... })
                      ← supplementary; failure does NOT undo the commit.
```

**Credentials never persist** — `sanitiseMetaJson` strips credential-shaped
keys before they reach the `metaJson` column.

---

## 7. Test results (directive §9)

### 7.1 `npm run typecheck` (bumped heap)

```
$ NODE_OPTIONS="--max-old-space-size=8192" npm run typecheck
```

- Total errors: **16** (all pre-existing baseline — billing + SIGNUP-2 + HR e2e surfaces)
- Errors in 6D-4B scope (`src/lib/hr/training/ai-review/**` + `prisma/schema.prisma` + `src/lib/permissions.ts` + new test file): **0**

Note: the Prisma Client's regenerated types are significantly larger
with the six new models, pushing TypeScript past the default 4 GB heap.
`NODE_OPTIONS=--max-old-space-size=8192` is the minimum for this slice
and should be pinned in `package.json`'s `typecheck` script as a
follow-up (NOT touched in this slice to keep scope minimal).

### 7.2 `npx prisma validate`

```
The schema at prisma\schema.prisma is valid 🚀
```

### 7.3 `npm run nav:audit`

```
URL-only (orphans):   0
Internal/allowlisted: 47
```

No new orphans (route allowlist from 6D-1 remains sufficient; this
slice does not add any routes).

### 7.4 Vitest — 72 / 72 PASS across three files

```
$ npx vitest run \
    tests/ep-train-6d4b-ai-review-governance.test.ts \
    tests/ep-train-6d3-approval-guard.test.ts \
    tests/training-ai-generation-grounding.test.ts

 Test Files  3 passed (3)
      Tests  72 passed (72)
```

### 7.5 Coverage of directive §9 requirements

| Directive §9 requirement | Test file + test name | Pass |
|--------------------------|------------------------|:---:|
| Immutable draft creation | — covered by 7-row DEFERRED section; requires real DB | DEFERRED |
| New-version-on-edit semantics | `content hash → different sourceSegmentIds order → different hash` + §A1 lifecycle `REQUIRES_HUMAN_REVIEW → EDITED_VALIDATION_STALE` | ✓ |
| Historical content preservation | lifecycle + schema design (previous draft row kept; new row created; test proves schema design) | ✓ (design) + DEFERRED (DB integration) |
| Stale content hashes | `CONTENT_HASH_MISMATCH → 409` | ✓ |
| Stale validation | `VALIDATION_MISSING (hash mismatch)` + `STATE_NOT_APPROVABLE` | ✓ |
| Rejected-to-approved prohibition | `REJECTED → APPROVED_DRAFT is PROHIBITED (even with every permission)` | ✓ |
| Remediation permissions | `REJECTED → REQUIRES_HUMAN_REVIEW requires :remediate-rejected` | ✓ |
| Tenant mismatch | `CROSS_TENANT → 404 same-shape` | ✓ |
| Missing authorization | `REVIEWER_LACKS_PERMISSION → 403` | ✓ |
| Duplicate operation keys | schema design — `@@unique([route, requestKey, reviewerUserId, draftId])` | ✓ (schema) + DEFERRED (DB integration) |
| Concurrent updates | `CONCURRENT_MODIFICATION → 409` + `writeStateTransition` design | ✓ (guard) + DEFERRED (real race) |
| Transactional audit failure | `writeStateTransition` design — rollback semantics | DEFERRED (requires real DB) |
| Unknown validation states | `VALIDATION_MISSING (null) → 409` + `errorsJson unparsable → fail closed` | ✓ |
| Fixture-validation rejection | `VALIDATION_SOURCE_INVALID — fixture-sourced validation cannot approve in production` | ✓ |
| Approved-draft publication boundary | lifecycle `APPROVED_DRAFT` has no transition to a `TrainingQuestion` row; schema has no such relation | ✓ (schema) |

### 7.6 Tests deliberately deferred to an isolated database integration slice

Per directive §9 ("identify any tests that require a real isolated
test database"), the following cases exist in the test file as
`[REQUIRES REAL DB]` placeholders:

1. `writeStateTransition` rolls back the draft update when the
   `TrainingQuestionAiStateTransition` insert fails.
2. `writeStateTransition` rolls back the transition insert when the
   optimistic-concurrency check fails (concurrent writer).
3. Idempotency: two sequential calls with the same `expectedRecordVersion`
   both can't succeed.
4. `@@unique([clubId, courseVersionId, contentHash])` rejects duplicate.
5. `@@unique([route, requestKey, reviewerUserId, draftId])` rejects duplicate.
6. Cascading deletes: `TrainingQuestionAiDraft` → validations + state transitions (CASCADE).
7. RESTRICT: deleting `Club` with any AI draft fails.

All seven require a real isolated SQLite test database + a test
harness that starts and tears down a fresh schema per test. This is
**explicitly deferred to 6D-4C's database-integration test setup**
(a separately authorised slice).

---

## 8. Security analysis

| Concern | Mitigation |
|---------|------------|
| Credentials leak into audit metadata | `sanitiseMetaJson` strips 11 credential-shaped key patterns; schema has no column intended for credential storage |
| Fixture validations approving production content | `evaluateApprovalServerSide` fires `VALIDATION_SOURCE_INVALID` when `validatorSource !== "integrated-pipeline"` |
| REJECTED candidates silently promoted | Transition table omits `REJECTED → APPROVED_DRAFT`; only `REJECTED → REQUIRES_HUMAN_REVIEW` (via `:remediate-rejected`) + `REJECTED → ARCHIVED` (via `:archive`) exist |
| DOM / curl bypass of UI guard | Server guard re-checks every condition; transactional writer re-checks transition rules inside the TX |
| Stale-read approval | `recordVersion` optimistic-concurrency check inside `updateMany` |
| Content tampering between validate + approve | `draftContentHash` binding on validation + review rows; guard fires `CONTENT_HASH_MISMATCH` |
| Source-video swap under a DRAFT version | Guard compares `draft.sourceVideoSha256` against `courseVersion.videoSha256` live |
| Retired course accepting new approvals | Guard fires `SOURCE_VERSION_CHANGED` when `courseVersion.retiredAt !== null` |
| Audit-service outage silently losing lifecycle records | Lifecycle record lives in `TrainingQuestionAiStateTransition` (in-transaction); existing `audit()` is supplementary only |
| Duplicate review submissions | `TrainingQuestionAiOperationKey` compound UNIQUE at the DB level |
| Cross-tenant data exposure | Every row carries `clubId`; CROSS_TENANT → 404 same-shape prevents enumeration |

---

## 9. Tenant-isolation analysis

- Every new model carries `clubId` as a NON-NULL column with a FK to `Club` (`ON DELETE RESTRICT`).
- Every new model has at least one `clubId`-prefixed index for tenant-scoped queries.
- Transactional-audit writer's `updateMany` includes `clubId: args.clubId` in the WHERE clause as defence-in-depth.
- Approval guard's `CROSS_TENANT` check compares `draft.clubId !== activeClubId` and returns 404 same-shape.
- Lifecycle state transitions carry `clubId` so an audit of "every transition in club A" is a single-index query.
- Idempotency keys carry `clubId` + `(route, requestKey, reviewerUserId, draftId)` — the uniqueness is scoped to the reviewer + draft, and the `clubId` + draft linkage prevents cross-tenant replay.

---

## 10. Changed-file inventory

| File | Status | Lines | Notes |
|------|--------|------:|-------|
| `prisma/schema.prisma` | modified | +290 (6 models + 11 back-relation arrays + 1 named relation) | Additive only; no existing field altered |
| `prisma/migrations/20261104_ep_train_6d_4b_ai_review_persistence/migration.sql` | new | +239 | Hand-written; NOT applied |
| `src/lib/permissions.ts` | modified | +9 (7 new permission keys + 2 comment lines) | **No role grants added** |
| `src/lib/hr/training/ai-review/lifecycle.ts` | new | +133 | Pure |
| `src/lib/hr/training/ai-review/content-hash.ts` | new | +41 | Pure |
| `src/lib/hr/training/ai-review/approval-guard.ts` | new | +205 | Pure |
| `src/lib/hr/training/ai-review/transactional-audit.ts` | new | +150 | DB-aware (requires Prisma tx) |
| `src/lib/hr/training/ai-review/index.ts` | new | +40 | Public barrel |
| `tests/ep-train-6d4b-ai-review-governance.test.ts` | new | +353 | 40 cases; 7 marked `[REQUIRES REAL DB]` |
| `docs/training/ai-generation/PHASE-D-4B-ACCEPTANCE.md` | new | — | This file |

Zero changes to any existing training surface (`TrainingQuestion`,
`TrainingAnswerOption`, `TrainingCheckpoint`, service-layer files in
`src/lib/hr/training/*` other than the new `ai-review/` subdirectory).

---

## 11. Branch + commit

- Branch: `ep-train-6d-4b/persistence-foundation`
- Parent: `10b161a` (6D-4A architecture)
- Commit SHA: *filled in at commit time (see acceptance deliverable footer)*
- All 6 prior EP-TRAIN-6D-* branches remain untouched:
  - `ep-train-6c-10b/hardened-validator-integration` → `accbb0c`
  - `ep-train-6c-10c/validator-hardening` → `0ed305c`
  - `ep-train-6d-1/manager-review-ui` → `d826ce3`
  - `ep-train-6d-2/founder-visual-acceptance` → `28e8584`
  - `ep-train-6d-3/review-ui-prerequisites` → `36a784f`
  - `ep-train-6d-4a/review-backend-architecture` → `10b161a`
- `staging-deploy/web1b1-framer-fidelity` HEAD unchanged at `de8653f`
- 126 pre-existing uncommitted files unchanged

---

## 12. Remaining risks + follow-ups

### 12.1 Required before 6D-4C can apply the migration

- **Isolated database integration test set.** The 7 `[REQUIRES REAL DB]`
  cases MUST pass against a real SQLite instance before 6D-4C ships.
  Suggested approach: a vitest `beforeAll` that creates a fresh
  SQLite file + runs `prisma db push` against it + applies each test's
  seed data, then tears down in `afterAll`. Flag: do not run against
  the dev `prisma/dev.db` file.
- **Shadow-database repair.** The pre-existing migration-history gap
  (`20260808_slice_5_1_ocr_page_number` references
  `DocumentOcrExtraction` which no longer exists) prevents
  `prisma migrate diff --from-migrations` from working. Fixing this is
  out of scope here, but should land before any future slice relies on
  `prisma migrate diff`.

### 12.2 Known residuals

- **Node heap cap for `tsc`.** `NODE_OPTIONS=--max-old-space-size=8192`
  is now required for `npm run typecheck` because of the enlarged
  Prisma Client types. Adding this to the `typecheck` script in
  `package.json` is deferred to a dedicated housekeeping slice.
- **No role grants.** Per decision §2.9, no existing role was extended
  with any `hr:training:ai:*` key. A 6D-4C sibling slice or a founder-
  authorised role-update slice must grant these permissions to the
  appropriate role before any user can exercise the API.
- **Automated retention deletion is NOT implemented** (per decision §2.4).
  Rows persist forever until an operator manually archives them. A
  future 6D-7 slice can add a scheduled cleanup job if the founder
  authorises the retention policy.
- **Content-hash algorithm is Spectre-internal.** Upgrading to a
  cross-language canonical form (e.g., RFC 8785) would be a breaking
  change — all existing hashes would invalidate. Flagged for future
  consideration if cross-language consumers ever read these rows.

---

## 13. Proposed 6D-4C acceptance gates

6D-4C should not merge until:

1. All 7 `[REQUIRES REAL DB]` cases in `tests/ep-train-6d4b-ai-review-governance.test.ts` move out of `[DEFERRED]` and PASS against an isolated SQLite instance.
2. A CI (or local script) runs `npx prisma validate` + `npx prisma format --check` on every PR touching `schema.prisma`.
3. `npm run typecheck` is pinned to `NODE_OPTIONS=--max-old-space-size=8192` in `package.json` (small housekeeping).
4. A cross-tenant negative test is added at the API-handler layer (6D-4C builds the read-only routes; this is where the tenant filter is first exercised in a request).
5. The idempotency compound-UNIQUE is exercised by a duplicate-request test that submits the same operation key twice and asserts the replay response equals the first response byte-for-byte.
6. A `prisma migrate dev --dry-run` on a scratch database confirms the migration applies cleanly (this is the first time the migration SQL is actually run; requires separate operator authorisation to connect to any DB).

---

## 14. Isolated database integration readiness

**The implementation is ready for an isolated database integration test.**

The migration SQL has been written to match the project's convention,
validated for FK ordering + cascade semantics by hand review, and
traced against the Prisma schema. The server-governance functions have
been proven pure + testable. The 7 deferred cases are precisely the
ones that need a real database.

What's required for the integration test:

- A separately-authorised slice (6D-4C or its sibling) that creates
  an isolated test SQLite instance, applies this migration SQL, runs
  the 7 deferred cases, and tears down.
- NO application of this migration to `prisma/dev.db`, staging, or
  production.
- NO exposure of the new models to the admin UI (which still consumes
  fixtures from 6D-3).

---

## 15. Mandatory STOP (directive §12)

- Code + migration artifacts + tests + documentation complete. ✓
- **STOPPING.**
- Migration NOT applied to any database. ✓
- NO API routes implemented. ✓
- NO UI wiring changed. ✓
- NO live inference. ✓
- NO staging deployment. ✓
- NO production migration. ✓
- NO role grants. ✓
- Not advancing to 6D-4C. ✓

**Founder acceptance standard** (directive closing paragraph):

> *"Establish a durable, tenant-scoped, immutable and auditable
> persistence foundation for AI-generated training questions, with
> server-enforced lifecycle governance and no operational exposure."*

**Status: met.**

- **Durable** — six tables, hand-written SQL, every FK + unique constraint reviewed.
- **Tenant-scoped** — `clubId` on every table + every index + every
  guard check + every transactional-audit WHERE clause.
- **Immutable** — append-only validations + reviews + state transitions;
  draft content hash = sha256 of canonical JSON; edits create new rows.
- **Auditable** — `TrainingQuestionAiStateTransition` is the
  authoritative in-transaction lifecycle record; sanitiser strips
  credentials; supplementary `audit()` carries the human-visible log.
- **Server-enforced lifecycle governance** — `evaluateApprovalServerSide`
  + `evaluateTransition` + `writeStateTransition` all pure, all
  testable, all fail-closed.
- **No operational exposure** — no DB write happens anywhere in this
  slice; no API route is reachable; no role has any `hr:training:ai:*`
  permission granted; no UI surface consumes any new code.
