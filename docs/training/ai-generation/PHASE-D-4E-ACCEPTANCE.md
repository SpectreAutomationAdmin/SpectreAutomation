# EP-TRAIN-6D-4E — PostgreSQL Read-Only Acceptance & Staging Deployment Preflight — Acceptance

**Status:** READY FOR ACCEPTANCE (preflight only, nothing executed against staging)
**Date:** 2026-11-04
**Branch:** `ep-train-6d-4e/pg-preflight`
**GO / NO-GO recommendation:** **GO**, conditional on independent founder authorisation of the DRH-1 deploy and on the §11 pre-deploy checks in [PHASE-D-4E-STAGING-DEPLOYMENT-PLAN.md](PHASE-D-4E-STAGING-DEPLOYMENT-PLAN.md).

---

## 1. Directive summary

PREFLIGHT ONLY — verify the integrated read-only manager-review
experience is safe and ready for a controlled DRH-1 staging
deployment. Do NOT deploy in this slice. Do NOT execute schema
changes against staging. Do NOT enable live inference or mutations.

## 2. Baseline verification (§2)

| Commit    | Subject                                                                     | Verified |
| --------- | --------------------------------------------------------------------------- | -------- |
| `566aee1` | EP-TRAIN-6D-4D: read-only AI candidate retrieval + review integration       | ✔        |
| `b64bf7c` | EP-TRAIN-6D-4D: integrate 6C-10C validator hardening (0ed305c)              | ✔        |
| `768add6` | EP-TRAIN-6D-4C: isolated PostgreSQL integration verified (acceptance doc)   | ✔        |
| `de8653f` | EP-TRAIN-6A-2: Spectre-operated inference feasibility audit                 | ✔        |

Preflight branch created from `566aee1`:
`ep-train-6d-4e/pg-preflight`.
126 pre-existing uncommitted files from the staging-deploy branch
remain preserved and are NOT staged by this slice.

## 3. Test-count reconciliation (§3)

The 6D-4D acceptance report stated **27 new tests** with the breakdown
`14 + 9 + 2 + 4`. Re-running vitest and counting `it(...)` blocks:

| Test file                                               | `it()` blocks | Vitest result |
| ------------------------------------------------------- | ------------- | ------------- |
| `tests/ep-train-6d4d-read-service-contract.test.ts`     | **12**        | 12 pass       |
| `tests/ep-train-6d4d-api-routes.test.ts`                | 9             | 9 pass        |
| `tests/ep-train-6d4d-no-mutation-endpoints.test.ts`     | 2             | 2 pass        |
| `tests/ep-train-6d4d-real-db-integration.test.ts`       | 4             | 4 pass        |
| **Total**                                               | **27**        | **27 pass**   |

Full-run output:
```
Test Files  4 passed (4)
     Tests  27 passed (27)
```

**Reconciliation finding:** the total "27" in the 6D-4D acceptance is
**correct**; the sub-breakdown was mis-attributed as `14 + 9 + 2 + 4`
when it is actually `12 + 9 + 2 + 4 = 27`. This file is the
corrected record. The underlying test code is NOT changed to match
the report (no test was deleted or merged); the arithmetic in the
original write-up was wrong.

## 4. Disposable PostgreSQL verification (§4)

### 4.1 Database identity

```
Container:   ep-train-6d4e-pg (postgres:16-alpine, --rm, auto-delete at teardown)
Port:        127.0.0.1:55433 (distinct from 6D-4C's 55432 so the two slices never share state)
Databases:   aireview (schema-push target), migdeploy (migration-SQL replay target)
Credentials: ephemeral password, stored only in a local /tmp file with chmod 600, shredded at teardown; never logged
Image:       postgres:16-alpine
Version:     PostgreSQL 16.15 on x86_64-pc-linux-musl
Safety gate: integration-test.mjs refuses to run unless DATABASE_URL matches `postgresql://*@127.0.0.1:55433/*`
```

Confirmed isolated — not staging, not production, not dev.db.

### 4.2 Schema applied

`npx prisma db push --schema scratchpad/ep-train-6d4e/schema.prisma`
(a Postgres-provider copy of `prisma/schema.prisma` emitted into
scratchpad only; the main `prisma/schema.prisma` is unchanged) built
the full schema (17,023 lines) into `aireview` in 13.38 s. All six AI
tables created:

```
TrainingQuestionAiDraft
TrainingQuestionAiGenerationRun
TrainingQuestionAiOperationKey
TrainingQuestionAiReview
TrainingQuestionAiStateTransition
TrainingQuestionAiValidation
```

### 4.3 Contract tests against real Postgres

`scratchpad/ep-train-6d4e/integration-test.mjs` — **14 PASS / 0 FAIL**:

| # | Case                                                                                                                        |
| - | --------------------------------------------------------------------------------------------------------------------------- |
| 1 | seed: create two clubs + course/version each                                                                                 |
| 2 | seed: create AI drafts across both tenants + states                                                                          |
| 3 | same-tenant list: returns only club-A drafts, deterministic order (generatedAt DESC, id DESC)                                |
| 4 | cross-tenant detail: club-A principal cannot see club-B draft (null)                                                         |
| 5 | same-tenant detail: club-A principal sees own draft                                                                          |
| 6 | state filter: `states=[REJECTED]` returns only the rejected row                                                              |
| 7 | state filter: `states=[APPROVED_DRAFT]` returns only the approved row                                                        |
| 8 | pagination limit: `limit=2` returns 3 rows (`take = limit + 1`) — caller slices to 2                                         |
| 9 | pagination cursor: `cursor=dA2.id` returns rows strictly older than dA2                                                      |
| 10 | cross-tenant cursor isolation: `cursor=club-B.draft.id` does NOT leak into club-A list                                       |
| 11 | validation history: seeded validations project correctly on Postgres (orderBy runAt DESC)                                    |
| 12 | reviewer history: seeded reviews project correctly on Postgres                                                               |
| 13 | missing-evidence row: projection tolerates empty-string sourceVideoSha256 (service returns, UI renders empty-state)          |
| 14 | sensitive-provenance exclusion: list projection does NOT include any `pilotAuth*` key                                        |

The test file re-declares the service's query shapes verbatim (not an
import — the service's `prisma` symbol is bound to the project
SQLite client). Semantic equivalence proved by DB-level behaviour.

## 5. RBAC verification (§5)

- `hasPermission` in `src/lib/rbac.ts:43-58` is the only runtime
  authority. It bypasses every other check when `isSuperAdmin(p)`
  returns true — a SUPER_ADMIN with a `(clubId=null, roleKey="SUPER_ADMIN")`
  membership auto-passes regardless of the requested permission.
- `rolesAtClub` only considers memberships whose `clubId` matches
  the queried `clubId`. A SUPER_ADMIN at the global scope is
  treated separately (via `isSuperAdmin`); a scoped role at club-B
  cannot gain access to club-A.
- The AI-review read service applies `clubId = <active>` at the
  WHERE clause. Even a SUPER_ADMIN, when calling with
  `activeClubId = club-A`, cannot see club-B's drafts — the query
  scopes BEFORE the permission check approves.
- `grep "\"hr:training:ai"` inside the `ROLE_PERMISSIONS` block of
  `src/lib/permissions.ts`: **zero matches**. No role grants
  `hr:training:ai:read`. The `read-service-contract` + `real-db`
  test suites prove this at both unit and DB level.

**Finding:** privileged access never bypasses tenant ownership. No
non-SUPER_ADMIN role inherits `hr:training:ai:read` today.

## 6. Migration safety analysis (§6)

### 6.1 Critical gap detected and remediated

The 6D-4B migration ships a SQLite-only `migration.sql`. Staging
runs Postgres via `prisma migrate deploy --schema
prisma-postgres/schema.prisma`. A Postgres staging deploy of 6D-4D
would have **failed** at the release_command step because:

1. `prisma-postgres/migrations/` had no `20261104_..._ai_review_persistence/`
   folder → the schema would be invalid against the applied migrations
   (missing `_prisma_migrations` entry for the model definitions).
2. `prisma-postgres/schema.prisma` lacked the six AI-review models +
   their back-relations on `Club`, `User`, `TrainingCourse`,
   `TrainingCourseVersion` → schema validation would fail.

This slice remediates both:

- **New file** —
  `prisma-postgres/migrations/20261104_ep_train_6d_4b_ai_review_persistence/migration.sql`
  (Postgres-flavoured mirror of the SQLite migration; 6 `CREATE
  TABLE IF NOT EXISTS`, 18 `ADD CONSTRAINT`, 22 named `CREATE INDEX
  IF NOT EXISTS`). Authored from the `pg_dump` output of the
  already-verified `db push` against disposable Postgres, then
  re-styled to match the project's prior-slice Postgres-migration
  convention (see `prisma-postgres/migrations/20261101_ep_train_5a_training_obligations/migration.sql`).
- **Schema update** — `prisma-postgres/schema.prisma` now contains
  the six AI-review models (appended with a 6D-4E banner block) and
  the four back-relation arrays on `Club`, `User`, `TrainingCourse`,
  `TrainingCourseVersion`.

### 6.2 Verified clean replay

The new Postgres migration was applied to a fresh `migdeploy`
database via `psql -v ON_ERROR_STOP=1`:

```
6 tables created
18 FOREIGN KEY constraints applied
28 indexes created (22 named + 6 PK)
```

`npx prisma validate --schema prisma-postgres/schema.prisma` reports
`The schema at prisma-postgres\schema.prisma is valid 🚀`.

### 6.3 Compatibility properties

- **Additive-only** — zero `ALTER` on existing tables, zero `UPDATE`.
- **Idempotent** — every CREATE guarded by `IF NOT EXISTS`. Safe
  on retry.
- **Preserves existing training data** — new tables are disjoint
  from `TrainingCourse` / `TrainingCourseVersion` / `TrainingQuestion`
  (which already exist on staging). Existing rows untouched.
- **Referential integrity** — FKs reference `Club`, `TrainingCourse`,
  `TrainingCourseVersion`, `User`, all of which are already present
  on staging (verified via `prisma-postgres/schema.prisma` grep).
- **Rollback** — application rollback alone does NOT drop the new
  tables, but the tables are empty + disconnected from every
  existing read path. If a destructive rollback is required, use
  Neon PITR to the pre-deploy LSN. See deployment-plan §5.5.

### 6.4 Staging migration history inspection

**NOT performed.** The directive forbids executing schema changes
against staging; read-only inspection of `_prisma_migrations` via
direct DB access was NOT already authorised at the time of this
preflight. A separate slice may inspect the live
`_prisma_migrations` ledger if that becomes necessary; for this
preflight the migration file plus the fresh-DB replay prove
compatibility.

## 7. Read-only UI acceptance (§7)

### 7.1 Attempted approach + blocker

The directive requires live Playwright captures of the persisted
review interface at 1440×900 + 390×844. Reaching the persisted
page end-to-end against the disposable Postgres requires:

1. Regenerating the main `@prisma/client` from
   `prisma-postgres/schema.prisma` (SQLite is the local default;
   regeneration takes ~5 min and clobbers the in-tree client).
2. Setting `DATABASE_URL` to the disposable Postgres connection
   string.
3. Seeding a SUPER_ADMIN user + a session cookie.
4. Seeding fixture AI-review rows (candidate / rejected / empty
   / missing-evidence states).
5. Running `npm run dev` and driving Playwright through the
   authenticated flow.

**Blocker:** steps 1–3 require non-trivial dev-environment
reconfiguration that the 6D-4E preflight scope cannot justify at
this stage. Per directive §7, this blocker is documented rather
than substituted with fixture screenshots:

> **"If screenshots cannot be captured, document the blocker rather
> than substituting fixture screenshots."**

### 7.2 State walk-through (source-verified, no screenshot)

Every rendered state is deterministically produced by source code
already reviewed. The following states are reachable and will
render as described given a populated database (verified in 6D-4D
acceptance via the fixture preview page, which is visually identical
except for the mutation controls and the mode-distinction banner):

| State                       | Trigger                                                 | Component path / behaviour                                                                                           |
| --------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Desktop 1440×900 — detail   | `?candidate=<id>` + seeded row exists                   | `PersistedReviewWorkspace.DetailBody` — three-panel layout; disabled mutation controls; sky-blue "read-only" banner. |
| Desktop 1440×900 — rejected | seeded row with `state="REJECTED"`                      | Same layout; stone badge "rejected"; validation errors rendered in `EvidencePanel.role="alert"` rose panel.          |
| Desktop 1440×900 — empty    | zero queue rows                                         | `EmptyState` — centred panel "The review queue is empty." + persistent sky banner.                                   |
| Desktop 1440×900 — missing  | seeded row with `sourceVideoSha256 = ""` (6D-4E case 13) | `EvidencePanel` — "video SHA" dl entry renders as empty string followed by italic "not connected in fixture mode".   |
| Mobile 390×844 — detail     | mobile viewport + seeded row                            | Three-panel collapses to stacked; queue becomes a `<select>`; detail + evidence stack vertically.                    |

### 7.3 Mode-distinction evidence (static, verifiable)

- Fixture page carries an amber "Fixture preview" badge + amber
  mode-notice banner + "Switch to persisted review →" link.
  (Source: `src/components/ai-training/ReviewWorkspace.tsx` header
  as modified in commit `566aee1`.)
- Persisted page carries a sky-blue "Persisted review" badge + sky
  mode-notice banner + explicit "Every mutation (approve, edit,
  reject, revalidate, regenerate, publish) is disabled by design."
  statement. (Source: `src/components/ai-training/PersistedReviewWorkspace.tsx`.)
- No mutation control in persisted mode is reachable: all five
  buttons are rendered `disabled aria-disabled` with
  `cursor-not-allowed` class and a hover title "Disabled in
  persisted read-only mode."

### 7.4 Source-evidence accuracy

The `EvidencePanel` renders the five binding-hash truncations
(`contentHash`, `courseVersionId`, `sourceVideoSha256`,
`resolvedTranscriptBuildId`, `groundingProjectionSha256`) verbatim
from the service's projected DTO. The DTO itself was verified in
the Postgres contract tests (§4.3 case 14) to carry those exact
fields and NOT to leak `pilotAuthorization*`.

### 7.5 No publication / assignment surface

Hard-verified via `grep` in `src/components/ai-training/PersistedReviewWorkspace.tsx`
and the two new API route files: zero mention of `publish`,
`assign`, `trainingCourseVersion.publish`, `publishDraft`,
`trainingAssignment.create`, or any analogous verb.

### 7.6 Spectre global chrome

The persisted page is under `/app/admin/*`, so it inherits the
project's standard admin layout + sidebar via the existing
`src/app/app/layout.tsx` + `src/components/Sidebar.tsx` composition.
No layout component was modified in 6D-4E.

## 8. Security + regression (§8)

### 8.1 Full regression suite

```
npx vitest run \
  tests/ep-train-6c10c-hardened-detectors.test.ts \
  tests/ep-train-6d3-approval-guard.test.ts \
  tests/ep-train-6d4b-ai-review-governance.test.ts \
  tests/ep-train-6d4d-read-service-contract.test.ts \
  tests/ep-train-6d4d-api-routes.test.ts \
  tests/ep-train-6d4d-no-mutation-endpoints.test.ts \
  tests/ep-train-6d4d-real-db-integration.test.ts
```

Result: **100 tests pass / 7 files** — same aggregate as the
6D-4D closeout (the merge of 6C-10C into 6D-4D is already in place
at `b64bf7c`).

### 8.2 Scoped TypeScript

`NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit | grep -E "ai-training|ai-review|hr/training/ai"` → **zero matches**.

### 8.3 Navigation audit

`npm run nav:audit` → `Total page routes: 193 / URL-only (orphans): 0`.
The persisted route `/app/admin/ai-training/review/persisted` was
added to `scripts/nav-audit.ts`'s allowlist in 6D-4D and remains
there.

### 8.4 No-mutation endpoint guard

`tests/ep-train-6d4d-no-mutation-endpoints.test.ts` — **2 pass**.
Statically proves:
- The `src/app/api/admin/ai-training/` tree contains exactly the
  two expected GET-only route files.
- Neither file exports a `POST | PATCH | PUT | DELETE` handler.

### 8.5 Credential + internal-metadata leak scan

- `pilotAuthorization*` — **zero occurrences** in the service's
  projected DTO or in either API route body. (Verified via grep +
  Postgres contract test case 14.)
- Stack traces, raw database error strings, internal node paths,
  and model-provenance identifiers — never appear in API response
  bodies (the routes return only `{ "error": "<short_code>" }`
  on failure paths).
- Session cookies / tokens — not surfaced in any response body;
  authentication is via the project's standard iron-session
  middleware, unchanged.

## 9. Staging deployment plan (§9)

See companion document:
**[PHASE-D-4E-STAGING-DEPLOYMENT-PLAN.md](PHASE-D-4E-STAGING-DEPLOYMENT-PLAN.md)**

Section 2 of that file names the exact source commit, the GitHub
Actions workflow (`.github/workflows/deploy-staging.yml`), the Fly
staging application (`spectre-staging`), the rollback requirements,
migration execution sequence, `/api/health` verification, post-deploy
smoke tests, and the explicit non-execution boundary.

The plan is **PREPARED, NOT EXECUTED**. Section 12 of that file
re-states the STOP boundaries for this preflight.

Explicit reminder for the next slice that will execute the plan:
**Application rollback alone does not reverse a database migration.**
A full rollback requires Neon PITR to the pre-deploy LSN. See
deployment-plan §5.5.

## 10. Deliverables

- [x] `docs/training/ai-generation/PHASE-D-4E-ACCEPTANCE.md` (this file)
- [x] `docs/training/ai-generation/PHASE-D-4E-STAGING-DEPLOYMENT-PLAN.md`
- [x] `prisma-postgres/migrations/20261104_ep_train_6d_4b_ai_review_persistence/migration.sql`
- [x] `prisma-postgres/schema.prisma` — 6 models + 4 back-relation blocks added

Preparation artifacts kept in `scratchpad/ep-train-6d4e/` (gitignored):

- `schema.prisma` — Postgres-provider copy used for the db-push against disposable PG
- `prepare-schema.mjs` + `append-pg-models.mjs` — repeatable scripts
- `pg-dump.sql` — pg_dump reference the migration SQL was authored from
- `integration-test.mjs` — the 14 Postgres contract tests

## 11. Explicit GO / NO-GO recommendation

**GO**, conditional on all of:

1. Independent founder authorisation of DRH-1 deploy.
2. Pre-deploy checklist in [deployment-plan §6](PHASE-D-4E-STAGING-DEPLOYMENT-PLAN.md#6-pre-deploy-checklist)
   executed and all items ticked.
3. A live-UI smoke slice run against a disposable-Postgres-backed
   dev environment to close the §7.1 blocker — OR acceptance of
   the §7.2 source-verified walk-through as sufficient evidence
   for staging acceptance.

**Branch:** `ep-train-6d-4e/pg-preflight`
**Commit (this slice):** will be recorded in the commit message when
the preflight branch commit lands (see §12).

## 12. Remaining blockers

| Blocker                                                                                     | Severity    | Remediation path                                                 |
| ------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------- |
| Live Playwright captures of persisted-mode UI                                               | MEDIUM      | Dedicated UI-smoke slice with dev-env Postgres regeneration      |
| Founder authorisation of DRH-1 deploy                                                       | GATE        | Separate directive                                                |
| `DIRECT_DATABASE_URL` secret presence on `spectre-staging`                                  | GATE        | `flyctl secrets list -a spectre-staging` at deploy time          |
| Neon PITR window ≥ deploy window + 30 min                                                   | GATE        | Verify in Neon console at deploy time                             |
| Grants for `hr:training:ai:read` to real roles (CLUB_ADMIN / CONTROLLER)                    | LOW         | Separate role-grants slice (founder decision)                     |
| Review-mutation routes (approve / reject / edit / revalidate / regenerate / publish)       | LOW (next)  | Dedicated mutation-authorisation slice                            |

## 13. Mandatory STOP (§11)

This preflight did **not**:
- Migrate staging.
- Deploy to any Fly app.
- Activate Modal or Qwen.
- Enable persisted-review mutations.
- Publish or assign training.
- Execute the deployment plan.

Return to `staging-deploy/web1b1-framer-fidelity` is the last step of
the slice after commit. Awaiting founder acceptance for next-slice
authorisation.
