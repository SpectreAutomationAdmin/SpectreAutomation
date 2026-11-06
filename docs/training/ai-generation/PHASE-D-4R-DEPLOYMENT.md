# EP-TRAIN-6D-4R — Staging Deployment — Phase A Evidence + Phase B STOP

Status: **PAUSED AT PHASE B.** All Phase A preconditions passed.
Phase B identified an RBAC limitation that requires explicit founder
authorisation of a SUPER_ADMIN fallback before Phase C can execute.
Per directive §B (second clause): "If existing RBAC cannot support
this identity, document the exact limitation and STOP for founder
authorization of the proposed SUPER_ADMIN fallback."

Release candidate: `ep-train-6d-4r/staging-deployment` built from
`ep-train-6d-4p/interactive-reviewer-ux` @ `b2180d53`. No Fly image
built. No staging deploy executed. No migration applied. No test
identity created. The 126 unrelated WIP files remain safely stashed.

Author: Claude (Opus 4.7). Date: 2026-11-06 (preflight window
started 2026-11-06T00:40:19Z).

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

## Phase C–G — NOT EXECUTED

The release plan documented in
[PHASE-D-4Q-RELEASE-PLAN.md](PHASE-D-4Q-RELEASE-PLAN.md) describes
all 16 DRH-1 steps, rollback modes, and cleanup actions. None of
Phase C (DRH-1 deploy), Phase D (synthetic approval), Phase E
(screenshots), Phase F (cleanup), or Phase G (rollback) ran because
Phase B is paused.

**No Fly image built. No migration applied. No test identity
created. No fixture seeded. No screenshots captured.**

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
