# EP-TRAIN-6D-4E — DRH-1 Staging Deployment Plan (PREPARATION ONLY)

**Status:** PREPARED — NOT EXECUTED
**Authored:** 2026-11-04 as part of 6D-4E preflight
**Authority to execute:** NOT GRANTED by this preflight. A separate
founder authorisation is required before this plan may be triggered.

---

## 1. Scope

Deploy the EP-TRAIN-6D-4D read-only AI candidate retrieval surface to
`spectre-staging`. The deploy adds:

- 6 new tables (TrainingQuestionAiGenerationRun, TrainingQuestionAiDraft,
  TrainingQuestionAiValidation, TrainingQuestionAiReview,
  TrainingQuestionAiStateTransition, TrainingQuestionAiOperationKey)
- 2 new read-only API routes (`GET /api/admin/ai-training/drafts` + `GET
  /api/admin/ai-training/drafts/[id]`)
- 1 new persisted-mode page (`/app/admin/ai-training/review/persisted`)
- 1 new permission key (`hr:training:ai:read`) — not granted to any
  role by default; only SUPER_ADMIN can reach the persisted surface.

The deploy adds NO mutations, NO publication paths, NO live inference,
and NO data migrations against existing records.

## 2. Source commit

- **Target commit on the preflight branch:** `ep-train-6d-4e/pg-preflight`
  tip (preserved after this slice's commit lands). Includes:
  - 6D-4D baseline (`566aee1`).
  - 6C-10C hardened detectors merge (`b64bf7c`).
  - 6D-4E preflight additions (Postgres migration SQL + Postgres schema
    additions + acceptance docs).
- **Rollback anchor:** the current `spectre-staging` release
  (**must be independently verified** at deploy-time via `flyctl status
  -a spectre-staging` and `flyctl releases -a spectre-staging`; this
  file does NOT record a stale anchor because the staging HEAD moves
  between any two slices).

## 3. Deployment workflow

### 3.1 CI path — `.github/workflows/deploy-staging.yml`

Two triggers, one code path:

| Trigger             | Mechanism                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `workflow_dispatch` | GitHub Actions UI → *Deploy — spectre-staging* → ref `ep-train-6d-4e/pg-preflight` → confirm `deploy`   |
| `push`              | Push a `staging-deploy/<name>` branch whose tip is the preflight commit; the workflow fires on push    |

Internally the workflow:

1. Checks out the exact requested SHA on `ubuntu-22.04`.
2. Builds a Docker image ONCE via `docker buildx`.
3. Pushes it to Fly's registry with tag
   `registry.fly.io/spectre-staging:sha-<short-sha>`.
4. Invokes `flyctl deploy --strategy=image` so no rebuild occurs on Fly.
5. Fly runs the release_command declared in `deploy/fly.web.toml`:
   ```
   DATABASE_URL="$DIRECT_DATABASE_URL" \
     node /app/node_modules/prisma/build/index.js migrate deploy \
     --schema prisma-postgres/schema.prisma \
   && DATABASE_URL="$DIRECT_DATABASE_URL" \
     node /app/node_modules/tsx/dist/cli.mjs /app/scripts/sync-rbac.ts
   ```
   A migration failure aborts promotion — the current release stays
   live.
6. On success Fly rolls the release to all instances; health is probed.

### 3.2 Target Fly application

- **App:** `spectre-staging` (web tier)
- **Region:** `iad` (us-east, primary)
- **Worker:** `spectre-staging-worker` is **NOT** deployed by this
  slice — no worker code changed, no background job depends on the new
  surface.

## 4. Database prerequisites

### 4.1 Required secret

The release_command fails fast when `DIRECT_DATABASE_URL` is missing
from the app secrets. Verify before triggering the deploy:

```
flyctl secrets list -a spectre-staging | grep DIRECT_DATABASE_URL
```

If absent, STOP. A missing secret aborts migration with exit code 2
and no release is created.

### 4.2 Backup / recovery prerequisites

Staging uses Neon Postgres. Neon's point-in-time recovery (PITR) retains
a configurable history window. Verify a known-good PITR anchor
BEFORE triggering the deploy:

- Open the Neon console → `spectre-staging` project → **Branches** →
  confirm PITR window covers the deploy window (+30 minutes for rollback
  safety).
- Note the branch LSN or timestamp the deploy will anchor against.

## 5. Migration execution sequence

The release_command applies all migrations under
`prisma-postgres/migrations/` that are not already recorded in
`_prisma_migrations`.

### 5.1 New migration this slice adds

```
prisma-postgres/migrations/20261104_ep_train_6d_4b_ai_review_persistence/migration.sql
```

**Content** (verified against a disposable Postgres 16 — see
PHASE-D-4E-ACCEPTANCE.md §4):

1. `CREATE TABLE IF NOT EXISTS "TrainingQuestionAiGenerationRun"` (+4
   FKs, 4 indexes, 1 PK)
2. `CREATE TABLE IF NOT EXISTS "TrainingQuestionAiDraft"` (+4 FKs,
   5 indexes incl. 1 unique, 1 PK)
3. `CREATE TABLE IF NOT EXISTS "TrainingQuestionAiValidation"` (+2
   FKs, 4 indexes, 1 PK)
4. `CREATE TABLE IF NOT EXISTS "TrainingQuestionAiReview"` (+4 FKs,
   3 indexes, 1 PK)
5. `CREATE TABLE IF NOT EXISTS "TrainingQuestionAiStateTransition"`
   (+3 FKs, 3 indexes, 1 PK)
6. `CREATE TABLE IF NOT EXISTS "TrainingQuestionAiOperationKey"` (+2
   FKs, 2 indexes + 1 unique, 1 PK)

Totals: **6 tables, 18 FKs, 28 indexes (22 named + 6 PK)**.

### 5.2 Additive-only

- No `ALTER TABLE` against any existing table.
- No `DROP TABLE` / `DROP COLUMN` / `DROP INDEX`.
- No `UPDATE` / `INSERT` against existing rows.
- Every `CREATE` guarded by `IF NOT EXISTS` — safe to re-run.
- Foreign keys reference `Club`, `TrainingCourse`, `TrainingCourseVersion`,
  `User`, and the five other new tables — all parents already exist on
  staging.

### 5.3 RBAC projection

`sync-rbac.ts` runs after the migration. It upserts
`hr:training:ai:read` into the `Permission` table (as an unmapped
key — no `RolePermission` rows). `hasPermission` reads
`ROLE_PERMISSIONS` from `src/lib/permissions.ts` at request time and
does not consult `RolePermission` rows — so this projection is purely
cosmetic / audit-view, and no role gains the new permission.

### 5.4 Retry behaviour

- `prisma migrate deploy` acquires a Postgres advisory lock via the
  `DIRECT_DATABASE_URL` (Neon's unpooled endpoint — the pooler
  deadlocks the advisory lock).
- A retry on the same SHA re-enters the release_command. The migration
  is idempotent (table-already-exists → `IF NOT EXISTS` skip, FK
  already recorded → no duplicate). Safe.
- `sync-rbac.ts` is also idempotent (upsert + prune) and touches only
  `Permission` / `Role` / `RolePermission`. Safe.

### 5.5 Rollback / recovery

- **Application rollback** — `flyctl releases rollback <prev-version>
  -a spectre-staging`. Returns the web tier to the prior image. The
  six AI-review tables remain in the database (empty, no code reads
  them); application code no longer references the new routes.
- **Database rollback** — application rollback alone does NOT drop
  the new tables. If a dedicated database rollback is required:
  1. Trigger Neon PITR to the pre-deploy LSN / timestamp noted in §4.2.
  2. Verify RBAC projection via a read-only query against
     `Permission` to confirm `hr:training:ai:read` is absent.
  3. Flag that any application releases between the pre-deploy anchor
     and the rollback target are also reverted — all post-deploy
     writes to any table are gone.
- **Destructive manual rollback** (DROP the 6 tables) is NOT required
  for this deploy. The tables are empty and disconnected from every
  existing read path; leaving them in place has zero functional
  impact and keeps post-rollback re-deploys trivial.

## 6. Pre-deploy checklist

- [ ] `DIRECT_DATABASE_URL` secret verified present on
      `spectre-staging` (`flyctl secrets list`).
- [ ] Neon PITR window covers deploy window + 30 min for rollback.
- [ ] Current staging release version + image SHA recorded (via
      `flyctl releases -a spectre-staging`). This is the rollback
      anchor.
- [ ] Preflight branch (`ep-train-6d-4e/pg-preflight`) is up-to-date
      with the intended commit SHA.
- [ ] `prisma-postgres/migrations/20261104_ep_train_6d_4b_ai_review_persistence/migration.sql`
      exists and is committed.
- [ ] `prisma-postgres/schema.prisma` has the 6 AI-review models AND
      the back-relation arrays on `Club`, `User`, `TrainingCourse`,
      `TrainingCourseVersion`.
- [ ] `npx prisma validate --schema prisma-postgres/schema.prisma`
      reports "valid".
- [ ] Staging HEAD is NOT currently in a frozen / release-critical
      window.

## 7. Deploy sequence (when authorised)

1. Push a `staging-deploy/ep-train-6d-4e-review-persistence` branch
   whose tip is the preflight commit, OR use
   `workflow_dispatch` on the GHA workflow with the preflight branch.
2. Observe the GHA workflow logs; promotion happens only after the
   release_command exits 0.
3. Health probe — `GET /api/health` on the first-rolled Fly instance
   must return **200**.
4. Record the new release version + image SHA.

## 8. Post-deploy smoke tests

Run against `https://staging.spectreautomation.com` from an
authenticated SUPER_ADMIN browser session:

| Test                                                                              | Expected                                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /app/admin/ai-training/review`                                               | 200 — fixture preview; amber "Fixture preview" banner             |
| `GET /app/admin/ai-training/review/persisted`                                     | 200 — persisted empty state ("The review queue is empty."); sky-coloured "Persisted review — read-only" banner |
| `GET /api/admin/ai-training/drafts`                                               | 200 — `{ "rows": [], "nextCursor": null, "limit": 20, "states": null }` |
| `GET /api/admin/ai-training/drafts/bogus-id`                                      | 404 — `{ "error": "not_found" }`                                  |
| `GET /api/admin/ai-training/drafts?limit=51`                                      | 400 — `{ "error": "invalid_limit" }`                              |
| `POST /api/admin/ai-training/drafts` (any body)                                   | 404 or 405 — no handler exists for POST                           |
| Nav audit regression — zero NEW URL-only orphans                                  | Allowlist entry for `/app/admin/ai-training/review/persisted` must survive post-deploy. |

## 9. Health verification detail

- `/api/health` returns 200 — confirms app boot + Prisma client
  connection.
- No log-scan errors for `TrainingQuestionAi*` tables for 10 minutes
  post-deploy (indicates no stray query is attempting to write or read
  outside the read service).
- `_prisma_migrations` contains one new row with
  `migration_name = '20261104_ep_train_6d_4b_ai_review_persistence'`
  and `logs IS NULL`.

## 10. Known-safe redeploy

A second run of the same deploy workflow with the same SHA is safe:

- The migration is idempotent (all CREATEs are `IF NOT EXISTS`).
- `sync-rbac.ts` is idempotent.
- Fly re-uses the already-built image.

## 11. Known blockers for execution of this plan

| Blocker                                                                                   | Status                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------- |
| Separate founder authorisation to trigger DRH-1                                           | **NOT GRANTED**                             |
| `DIRECT_DATABASE_URL` secret present on `spectre-staging`                                 | Must be verified pre-deploy                 |
| Neon PITR window ≥ deploy window + 30 min                                                 | Must be verified pre-deploy                 |
| Staging HEAD stability (no concurrent release in flight)                                  | Must be verified pre-deploy                 |

## 12. Explicit NON-execution boundary

This file is preparation only. The 6D-4E preflight does not:

- Push a `staging-deploy/*` branch
- Trigger the `workflow_dispatch` on the GitHub Actions workflow
- Run `flyctl deploy` against any Fly app
- Apply any migration to staging or production
- Activate Modal or Qwen
- Enable persisted-review mutations
- Publish or assign training

A separate directive from the founder is required to execute this plan.
