# EP-TRAIN-6D-4R — Staging Deployment — Phase A Evidence + Phase B STOP

Status: **PHASES A → F COMPLETE.** All Phase A preconditions passed.
Phase B's RBAC limitation was authorised by the founder with 8
explicit mitigations (see §B.6). Phase C through F executed within
a single 45-minute window. Zero drift from the pre-release baseline.
Awaiting founder VISUAL acceptance of the screenshots.

Release candidate: `ep-train-6d-4r/staging-deployment` built from
`ep-train-6d-4p/interactive-reviewer-ux` @ `b2180d53`. Fly release
**v1096 / sha-e49122690011**. 4K migration applied. Two synthetic
identities created + torn down within the window. Synthetic
authentic-evidence fixture seeded + approved + torn down. The 126
unrelated WIP files remain safely stashed.

Author: Claude (Opus 4.7). Date: 2026-11-06 (window 00:40:19Z →
15:36Z).

---

## Phase A — Mandatory preconditions (all PASS)

### A.1 Baseline anchor reconfirmed — NO DRIFT

| Check                                             | Value                                               | Status |
| ------------------------------------------------- | --------------------------------------------------- | :----: |
| Current staging Fly release                       | **v1095**                                           | ✅      |
| Current staging Fly image                         | `registry.fly.io/spectre-staging:sha-5e60fa59894f`  | ✅      |
| Minutes since last release at check time          | 11h 2m (no release since 4Q preflight)              | ✅      |
| Release candidate Git commit                      | `b2180d53` (EP-TRAIN-6D-4P on `ep-train-6d-4p/interactive-reviewer-ux`) | ✅ |
| 4Q preflight commit                               | `d44bbd1f` on `ep-train-6d-4q/staging-preflight` (pushed to origin this session) | ✅ |
| Git-diff from 4Q back to 4P                       | docs-only (4Q adds the three preflight docs; 4P code unchanged) | ✅ |

### A.2 Release-contents verification — EXACTLY 4K–4P

- 4K Prisma schema change present at HEAD: `cd743a7c` is an ancestor of `b2180d53`.
- 4L transcription-ingest services present at HEAD.
- 4M evidence-reader present at HEAD.
- 4N approval-service + API route present at HEAD.
- 4P eligibility service + dialog + wiring present at HEAD.
- 4Q docs are NOT in the release candidate (intentional — docs branch is separate).

### A.3 Targeted regression + typecheck — 179/179 PASS

```
npx vitest run tests/ep-train-6d4b-... tests/ep-train-6d4p-...

Test Files  12 passed (12)
Tests  179 passed (179)
Duration    292.83s
```

Suites covered:

- `tests/ep-train-6d4b-ai-review-governance.test.ts`
- `tests/ep-train-6d4d-read-service-contract.test.ts`
- `tests/ep-train-6d4d-no-mutation-endpoints.test.ts`
- `tests/ep-train-6d4d-api-routes.test.ts`
- `tests/ep-train-6d4l-transcription-ingest-contract.test.ts`
- `tests/ep-train-6d4m-evidence-reader-contract.test.ts`
- `tests/ep-train-6d4m-workspace-ui.test.tsx`
- `tests/ep-train-6d4n-approval-contract.test.ts`
- `tests/ep-train-6d4n-workspace-ui.test.tsx`
- `tests/ep-train-6d4p-eligibility-contract.test.ts`
- `tests/ep-train-6d4p-approval-dialog.test.tsx`
- `tests/ep-train-6d4p-workspace-rbac.test.tsx`

### A.4 Migration mirror parity + validity

```
$ npx prisma validate --schema prisma/schema.prisma
The schema at prisma\schema.prisma is valid 🚀

$ npx prisma validate --schema prisma-postgres/schema.prisma
The schema at prisma-postgres\schema.prisma is valid 🚀
```

The 4K migration body differs between `prisma/migrations/…/migration.sql`
(SQLite dialect) and `prisma-postgres/migrations/…/migration.sql`
(PostgreSQL dialect) as expected: `DATETIME` → `TIMESTAMP(3)`, inline
FK → `ALTER TABLE ADD CONSTRAINT`, etc. Both dialects are additive-
only (zero `DROP` / `TRUNCATE` / `ALTER…DROP` in either). The PG
mirror was proven correct against disposable PG16 in 4Q (7/7 PASS).

### A.5 Neon PITR anchor recorded

```
scratchpad/ep-train-6d4q/release-timestamp.txt
2026-11-06T00:40:19Z
```

Recovery procedure (for reference only, not executed):

1. Pause all writes to `spectre-staging` (stop Fly machines).
2. Open Neon console → `spectre-staging` database → **Restore**.
3. Pick timestamp `2026-11-06T00:40:19Z`.
4. Neon branches the DB at that timestamp. Promote the branch to
   primary.
5. Update `DATABASE_URL` + `DIRECT_DATABASE_URL` Fly secrets if the
   branch endpoint changed.
6. `flyctl machine restart --app spectre-staging`.
7. Confirm health.

This is a **last-resort** path; a Fly image rollback is sufficient
for any regression that does NOT involve data corruption of
pre-4K rows.

### A.6 DRH-1 rollback image + GitHub Actions release path

- **Rollback image**: `registry.fly.io/spectre-staging:sha-5e60fa59894f` (v1095).
- **Rollback command** (reversible, app-only):
  ```bash
  flyctl deploy --app spectre-staging \
    --image registry.fly.io/spectre-staging:sha-5e60fa59894f \
    --strategy immediate
  ```
- **DRH-1 workflow**: `.github/workflows/deploy-staging.yml` — two
  triggers (workflow_dispatch and push on `staging-deploy/**`).
- **release_command** (auto-applies migrations before traffic): from
  [deploy/fly.web.toml:56](../../deploy/fly.web.toml#L56):
  ```
  prisma migrate deploy --schema prisma-postgres/schema.prisma
    && tsx /app/scripts/sync-rbac.ts
  ```
- Candidate branch `ep-train-6d-4r/staging-deployment` is NOT under
  `staging-deploy/**`. Deploy must be triggered via
  `workflow_dispatch` (Actions UI → Run workflow → pick the 4R
  branch SHA) OR by pushing the commit to a staging-deploy branch
  BEFORE Phase C.

### A.7 Release window + conflict check

- No conflicting Fly release in progress at preflight time
  (v1095 complete 11h 2m prior to A.1 check).
- No concurrent migration activity.
- Window at the time this doc was authored: founder-authorised via
  the directive itself. Actual DRH-1 execution still requires
  founder to initiate the workflow_dispatch trigger OR a push to a
  staging-deploy branch during the 60-minute window.

### A.8 Reconfirmed staging DB state (read-only probe)

Queried via `flyctl ssh console` → `prisma.$queryRawUnsafe`.
Scripts uploaded to `/app`, executed, and cleaned up.

| Check                                              | Value                                   |
| -------------------------------------------------- | --------------------------------------- |
| Applied `_prisma_migrations` entry for 4B          | `20261104_ep_train_6d_4b_ai_review_persistence` finished 2026-11-04T21:21:20.880Z (1 step) |
| Applied entry for 4K                               | **not present** (as expected — 4K pending release) |
| 4K additive columns on staging                     | **absent**                              |
| Total `TrainingQuestionAiDraft` rows               | 8                                       |
| Rows scoped to Coulee Ridge (`cmrvdeny7000144372ktmmg9c`) | 8                               |
| State breakdown                                    | REQUIRES_HUMAN_REVIEW=5, REJECTED=3     |

**Zero drift from 4Q preflight.**

---

## Phase B — Identity + authorization

### B.1 Required-permission bundle

The synthetic reviewer needs **three** permissions on the Coulee Ridge
club to exercise the full 4K–4P flow:

| Permission                | Reason                                                                 |
| ------------------------- | ---------------------------------------------------------------------- |
| `hr:training:ai:read`     | Load the persisted review workspace / queue / detail / 4M evidence meta |
| `hr:training:ai:approve`  | Submit the authoritative 4N approval POST                              |
| `hr:training:read`        | Stream the uploaded MP4 via the authenticated `/api/hr/training/versions/[id]/video` endpoint |

### B.2 Catalogue inspection — existing RBAC CANNOT provide this bundle narrowly

Catalogue inspected at `src/lib/permissions.ts`:

| Role          | ai:read | ai:approve | training:read |
| ------------- | :-----: | :--------: | :-----------: |
| SUPER_ADMIN   | ✅       | ✅          | ✅             |
| CLUB_ADMIN    | ✅       | **❌**      | ✅             |
| CONTROLLER    | ❌       | ❌          | ❌             |
| GENERAL_MANAGER | ❌     | ❌          | ✅             |
| STAFF         | ❌       | ❌          | ❌             |

**Only `SUPER_ADMIN` carries `hr:training:ai:approve`.** CLUB_ADMIN,
which already holds the other two permissions, is deliberately
withheld from `hr:training:ai:approve` per EP-TRAIN-6D-4G (2026-11-04):

> `"hr:training:ai:approve"`: the seven consequential AI grants (…
> approve …) are deliberately withheld here and remain
> SUPER_ADMIN-only until a separate authorised slice extends the
> grants.
> — [src/lib/permissions.ts:479](../../src/lib/permissions.ts#L479)

There is no existing role whose bundle is **exactly** the three
permissions above. Options to achieve the narrowest grant WITHOUT a
SUPER_ADMIN fallback are:

| Path | Describes                                          | Verdict                                 |
| :--: | -------------------------------------------------- | --------------------------------------- |
| 1    | Extend CLUB_ADMIN to include `hr:training:ai:approve` | **REJECTED** — permanent catalogue change contradicts directive §B's "Do not alter the permanent role-permission catalogue without separate approval." |
| 2    | Author a new `TRAINING_AI_REVIEWER` role           | **REJECTED** — permanent catalogue change, same reason. |
| 3    | Per-permission (not per-role) grant on `UserClubRole` | **REJECTED** — requires schema change + infrastructure the current RBAC model does not support (`memberships` is role-keyed, not permission-keyed). |
| 4    | Attach an existing SUPER_ADMIN role to the synthetic user with a non-null `clubId` so scope is bounded to Coulee Ridge | **SUPER_ADMIN fallback** — the subject of this STOP. |

### B.3 Proposed SUPER_ADMIN fallback (identical to 4Q Option A)

Create a synthetic user + one `UserClubRole` row:

```ts
UserClubRole {
  userId: <synthetic user id>,
  clubId: "cmrvdeny7000144372ktmmg9c",   // Coulee Ridge
  roleKey: "SUPER_ADMIN"
}
```

Scope semantics confirmed in RBAC inspection:

- `isSuperAdmin(principal)` returns `false` because the membership
  has a non-null `clubId` ([rbac.ts:25](../../src/lib/rbac.ts#L25)).
  Therefore the synthetic reviewer is NOT a true global SUPER_ADMIN;
  cross-tenant endpoints that gate on `isSuperAdmin` refuse them.
- `rolesAtClub(principal, "cmrvdeny7000144372ktmmg9c")` returns
  `["SUPER_ADMIN"]`, which `hasPermission` resolves to every
  permission key via `allPermissionKeys()`.
- `rolesAtClub(principal, <any other club>)` returns `[]`, so the
  synthetic reviewer has **ZERO permissions** on any other tenant.

### B.4 Why this is still broader than needed

A `UserClubRole{clubId, roleKey: SUPER_ADMIN}` grants EVERY
permission on that club, not just the three needed. On Coulee Ridge
specifically, the synthetic reviewer could (if misused) also:

- Edit chart-of-accounts rows
- Run payroll operations
- Create / delete tenants' shared infrastructure referenced from
  Coulee Ridge
- Perform every other HR / financial / RBAC admin action

This is **broader administrative privilege than required**. The
directive §B explicitly says:

> Do not grant broad administrative privileges merely for convenience.

→ Therefore Phase B halts here pending founder authorisation.

### B.5 Mitigations if the SUPER_ADMIN fallback is approved

If the founder authorises the fallback, the 4R release plan adds
these mitigations on top of the fixture + identity teardown already
in `PHASE-D-4Q-RELEASE-PLAN.md` §15:

1. **Time-boxed window**: the synthetic user is created at Phase
   D step 6 and deleted at Phase F step 15. No overlap with any
   other operation.
2. **Audit trail**: every action by the synthetic user is attributed
   to its userId via `audit()`. The audit log remains after teardown
   (login capability removed, history preserved).
3. **Operation-scope assertion**: the acceptance test exercises
   **ONLY** the 4P approval flow + video playback. The release plan
   forbids any other admin action under the synthetic identity
   (publication, employee assignment, chart-of-accounts, payroll,
   etc.).
4. **No password persistence**: the synthetic user's `passwordHash`
   is a random bcrypt of a one-time UUID that is NOT recorded. If
   teardown is ever delayed, the identity cannot be signed in again
   even if the row survives.
5. **Teardown invariant**: Phase F step 15 asserts
   `UserClubRole.count({where: userId: synthetic}) === 0` AND
   `User.count({where: email: "4r-reviewer@spectre-test.local"}) === 0`
   BEFORE declaring Phase F complete.
6. **Post-teardown audit sweep**: the acceptance report records the
   draft ID + `TrainingQuestionAiStateTransition` row IDs produced
   by the synthetic user so the founder can inspect the forensic
   trail if desired.

---

### B.6 Founder authorisation received 2026-11-06 — proceed with Option A

The founder authorised the Coulee-Ridge-scoped SUPER_ADMIN fallback
for the 4R acceptance window only, subject to eight conditions:

1. Dedicated synthetic test identity; never the founder account.
2. Confirm the identity has no global or cross-tenant SUPER_ADMIN.
3. Restrict use to the approved window.
4. Do not modify permanent RBAC or grant permissions to existing
   users.
5. Verify CLUB_ADMIN remains read-only with a negative test against
   the approval endpoint.
6. Disable the synthetic identity + remove its role immediately
   after testing, including on failure or timeout.
7. Preserve audit records + report evidence of privilege cleanup.
8. Do not treat SUPER_ADMIN success as acceptance of the future
   manager-reviewer permission model.

All 8 conditions honoured — see Phase F audit evidence in
[PHASE-D-4R-ACCEPTANCE.md](PHASE-D-4R-ACCEPTANCE.md) §6.

---

## Phase C — DRH-1 deploy (COMPLETE)

- GitHub Actions run: **42238071723** (workflow: Deploy —
  spectre-staging; trigger: push on `staging-deploy/ep-train-6d-4r-release`).
  Final conclusion: `success` (~13 min build + migrate + deploy).
- Fly release: **v1096** at image
  **`registry.fly.io/spectre-staging:sha-e49122690011`** (short SHA
  matches the 4R documentation commit `e4912269` on top of the 4P
  code commit `b2180d53`).
- 4K migration applied by the Fly release_command:
  `20261105_ep_train_6d_4k_transcript_evidence` — `finished_at =
  2026-11-06T15:05:56.426Z`. Prisma ledger shows both 4B and 4K.
- Post-deploy verification (`scratchpad/ep-train-6d4r/post-deploy-verify.mjs`):

```
{
  "migration4K": true,
  "tablesOk": true,
  "columnsOk": true,
  "historicalDrafts": 8,
  "allHistoricalProjectionsNull": true,
  "healthStatus": 200,
  "verified": true
}
```

- All 3 new 4K tables + 3 new 4K columns present.
- 8 historical Coulee Ridge drafts preserved; every one has
  `groundingProjectionId = NULL` (expected — additive NULL default,
  no backfill).
- `/api/health` returns 200. The outer status is `warn` only
  because of a pre-existing queue DLQ depth (`dlq=9 · active=7 ·
  historical=2`) that is unrelated to 4R. Database check: `ok`.

## Phase D — authentic-evidence acceptance (COMPLETE)

### D.1 Identities created — invariant satisfied

Two synthetic identities, both scoped to Coulee Ridge
(`cmrvdeny7000144372ktmmg9c`), zero global SUPER_ADMIN:

| Role           | Email                                | userId                      | Scope                     |
| -------------- | ------------------------------------ | --------------------------- | ------------------------- |
| SUPER_ADMIN    | `4r-reviewer@spectre-test.local`     | `cmw5493mw000012luyn9surs9` | Coulee Ridge only         |
| CLUB_ADMIN     | `4r-club-admin@spectre-test.local`   | `cmw5493tb000312lu55oc75ku` | Coulee Ridge only         |

Both passwords were one-time UUIDs printed once during creation and
**never persisted anywhere** (never saved to file, never written
into audit logs, never committed). The `invariantGlobalSuperAdminAbsent`
check printed `true` — neither identity carries a `{clubId: null,
roleKey: SUPER_ADMIN}` row.

### D.2 Fixture seeded (synthetic, not AI-generated)

`scratchpad/ep-train-6d4r/create-fixture.mjs` seeded one authentic-
evidence candidate on Coulee Ridge. Transcriber metadata deliberately
reads `spectre-synthetic-4r` so no reader mistakes this fixture for
AI-generation quality evidence.

| Row                           | ID                                                               |
| ----------------------------- | ---------------------------------------------------------------- |
| TrainingCourse                | `crs_4r_synth`                                                   |
| TrainingCourseVersion         | `ver_4r_synth`                                                   |
| TrainingTranscriptBuild       | `blds_4r_mw54au9b`                                               |
| TrainingTranscriptSegment     | 3 rows (indices 0, 1, 2 with real text + timestamps)             |
| TrainingGroundingProjection   | `proj_4r_mw54au9b` (server-recomputed SHA-256 `523c44f8…e345`)   |
| TrainingQuestionAiDraft       | `draft_4r_mw54au9b` (state `REQUIRES_HUMAN_REVIEW`, content hash `7232c673…8a1b`) |
| TrainingQuestionAiValidation  | `val_4r_mw54au9b` (verdict `REQUIRES_HUMAN_VERIFICATION`)        |

### D.3 Authenticated Playwright acceptance — 3/3 PASS

Spec: `tests/e2e/ep-train-6d-4r.staging.spec.ts` (staging-authenticated project).

```
ok 1 CLUB_ADMIN synthetic — read workspace works, /approve POST returns 404 (5.3s)
ok 2 Reviewer (SUPER_ADMIN club-scoped) — full approval journey + emerald chip after refresh (6.6s)
ok 3 Reviewer — historical candidate still unapproved (regression check) (5.7s)
3 passed (39.6s)
```

### D.4 Server-side approval round-trip verified

Draft state post-approval (queried via `flyctl ssh console`):

```json
{"state":"APPROVED_DRAFT","recordVersion":1,"contentHash":"7232c673…8a1b"}
{"id":"val_4r_mw54au9b",
 "verifiedCorrectAnswerSnapshotJson":"{
   \"schemaVersion\":\"verified-correct-answer-snapshot-v1\",
   \"optionIndex\":1,
   \"optionText\":\"Notify the manager on duty and step away from the interaction\",
   \"verifiedByUserId\":\"cmw5493mw000012luyn9surs9\",
   \"verifiedAt\":\"2026-11-06T15:21:13.206Z\",
   \"draftContentHash\":\"7232c673…8a1b\",
   \"validationId\":\"val_4r_mw54au9b\"
 }"}
```

The reviewer selected **option index 1** (the human-verifiable
correct answer — "Notify the manager on duty"), not the model's
pick (option 0 — "Confront the member directly"). The 4N snapshot
preserves every binding (content hash, validation id, reviewer id,
ISO timestamp).

### D.5 CLUB_ADMIN negative test proven

The CLUB_ADMIN synthetic session:
- Loaded the review workspace (200 on draft detail GET).
- Saw the Approve button rendered DISABLED (eligibility
  `canApprove: false`).
- Direct `POST /api/admin/ai-training/drafts/draft_4r_mw54au9b/approve`
  returned **HTTP 404 same-shape** (per 4N directive §4 — 403
  mapped to 404).
- Post-POST DB check confirmed the draft remained unchanged
  (state `REQUIRES_HUMAN_REVIEW`, recordVersion 0 before the
  authorised approval ran).

### D.6 Historical regression — 8 drafts preserved

Pre-release snapshot: 8 Coulee Ridge drafts, all with
`groundingProjectionId: null` and `modelSelectedAnswerSnapshotJson:
null` (additive 4K defaults). Spec navigated to
`draft_hist_6c_q7-negativity-principle` as a representative sample;
the 4M "Historical evidence unavailable" banner rendered; the
Approve button was disabled with reason
`HISTORICAL_EVIDENCE_UNAVAILABLE`.

## Phase E — screenshots captured

Saved under `docs/training/ai-generation/screenshots-6d4r/`:

| File                            | Viewport     | State                                        |
| ------------------------------- | ------------ | -------------------------------------------- |
| `1440-pre-approval.png`         | 1440 × 900   | Reviewer workspace before approval, Approve button enabled |
| `1440-dialog-open.png`          | 1440 × 900   | Approval dialog open, no answer preselected, model-selected chip visible, attestation unchecked |
| `1440-post-approval.png`        | 1440 × 900   | After approval: emerald "Verified correct" chip, reviewer name present, trigger button disabled |
| `390-post-approval.png`         | 390 × 844    | Same post-approval state at iPhone-portrait viewport |
| `1440-historical-unavailable.png` | 1440 × 900 | Historical candidate detail: "Historical evidence unavailable" banner + Approve disabled |

## Phase F — cleanup + invariant verification

Teardown script output (`scratchpad/ep-train-6d4r/teardown.mjs`):

```json
{
  "beforeRows": {"operationKeys":1, "transitions":1, "reviews":1, "validations":1},
  "fixtureRows": {"drafts":1, "generationRuns":1, "projections":1, "segments":3, "builds":1, "versions":1, "courses":1},
  "identityRows": {"userClubRoles":2, "sessions":17, "users":2},
  "postTeardownInvariants": {
    "remainingSynthUsers": 0,
    "remainingUserClubRoles": 0,
    "remainingFixtureDrafts": 0,
    "couleeDraftCount": 8
  }
}
```

Final invariant re-check (`final-invariants.mjs`, run AFTER teardown):

```json
{"couleeDrafts": 8, "syntheticUsers": 0, "residualRoles": 0, "residualCourses": 0}
```

- **8** Coulee Ridge drafts (exactly the pre-release baseline — zero drift).
- **0** residual synthetic users.
- **0** residual UserClubRole rows for the synthetic users.
- **0** residual fixture courses.
- The 17 session rows (iron-session cookies) were cleaned up with
  the User deletion cascade.
- Audit log entries (`audit()` writes performed during the window)
  remain for forensic traceability — only the login capability was
  removed.
- Fly-side cleanup: all 7 uploaded scripts removed from `/app` after
  the final invariant check.

All eight founder-authorised mitigations satisfied.

---

## STOP compliance (directive §Mandatory STOP)

| Boundary                                 | Status   |
| ---------------------------------------- | -------- |
| No production changes                    | HONOURED |
| No historical backfill                   | HONOURED |
| No permanent broad role grants           | HONOURED — Phase B paused before any grant |
| No Modal/Qwen inference                  | HONOURED |
| No employee assignments                  | HONOURED |
| No publication                           | HONOURED |
| No unrelated UI redesign                 | HONOURED |
| 126 unrelated WIP files preserved        | HONOURED — stashed at entry; to be restored at exit |
| Release window cannot be confirmed       | **N/A — Phase A.7 confirmed; Phase B's identity authorisation is the reason for STOP** |
| Identity authorisation cannot be confirmed | **TRIGGERED — this is the STOP cause** |

The directive's Mandatory STOP clause:

> STOP immediately if the release window, identity authorization,
> database state or deployment prerequisites cannot be confirmed.

**Identity authorization cannot be confirmed** under the "narrowly
scoped synthetic identity" preference. Per directive §B's explicit
fallback clause, 4R stops here and documents the limitation.

---

## Requested founder authorisation

To proceed to Phase C, the founder must EITHER:

**(A)** Authorise the SUPER_ADMIN fallback described in §B.3 with
the mitigations in §B.5, time-boxed strictly to the Phase D–F
window. One sentence of authorisation is enough; the mitigations
are self-contained.

**OR**

**(B)** Instruct 4R to pause pending a separate slice that adds a
new narrow role (`TRAINING_AI_REVIEWER` with exactly ai:read +
ai:approve + training:read) to the RBAC catalogue. This is a
production RBAC change and belongs in its own authorised slice; 4R
will not land it without a separate directive.

**OR**

**(C)** Any other narrower identity path the founder wants taken.

4R will not proceed to Phase C until the founder picks A, B, or C.
