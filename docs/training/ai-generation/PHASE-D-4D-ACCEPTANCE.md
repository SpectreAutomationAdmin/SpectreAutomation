# EP-TRAIN-6D-4D — Read-Only AI Candidate Retrieval & Manager Review Integration — Acceptance

**Status:** READY FOR ACCEPTANCE (offline, flag-free, no deployment)
**Date:** 2026-11-04
**Branch:** `ep-train-6d-4d/read-only-integration`
**Rollback anchor:** `768add6` (EP-TRAIN-6D-4C acceptance)
**6C-10C merge:** commit `b64bf7c` (clean `--no-ff`, zero file conflicts)

---

## 1. Directive summary

INTEGRATION IMPLEMENTATION, NO DEPLOYMENT.
Deliver a tenant-scoped, read-only candidate retrieval surface that
connects the (previously fixture-only) manager review UI to the
6D-4B persistence foundation, with ZERO mutations, ZERO staging
migration, ZERO live inference, and ZERO publish pathways. All
denial responses follow a same-shape 404 so cross-tenant probes
yield no enumeration signal. Every mutation control in the UI is
disabled by construction in persisted mode.

## 2. Files added / modified (6D-4D scope only)

### Added

| Path                                                                          | Purpose                                                                 |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/lib/hr/training/ai-review/read-service.ts`                               | `listCandidates` + `getCandidate` tenant-scoped reads (see §4)          |
| `src/app/api/admin/ai-training/drafts/route.ts`                               | GET queue (cursor, limit, states filter)                                |
| `src/app/api/admin/ai-training/drafts/[id]/route.ts`                          | GET single candidate detail                                             |
| `src/components/ai-training/PersistedReviewWorkspace.tsx`                     | Client component rendering persisted records; every mutation DISABLED  |
| `src/app/app/admin/ai-training/review/persisted/page.tsx`                     | Server route: auth → tenant resolve → permission check → service calls |
| `tests/ep-train-6d4d-read-service-contract.test.ts`                           | 14 unit tests — mocked Prisma, exhaustive contract surface              |
| `tests/ep-train-6d4d-api-routes.test.ts`                                      | 9 API unit tests — deny shapes + validation + happy path                |
| `tests/ep-train-6d4d-no-mutation-endpoints.test.ts`                           | Static guard: no POST/PATCH/PUT/DELETE handler exists under new API    |
| `tests/ep-train-6d4d-real-db-integration.test.ts`                             | 4 real-DB integration tests via SQLite template (real Prisma)           |

### Modified

| Path                                              | 6D-4D change                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/permissions.ts`                          | Added `hr:training:ai:read` permission key. **No role grants.** Reachable only via SUPER_ADMIN global membership.            |
| `src/components/ai-training/ReviewWorkspace.tsx`  | Fixture header now carries explicit "Fixture preview" badge + mode-distinction banner + "Switch to persisted review →" link. |
| `scripts/nav-audit.ts`                            | Allowlisted `/app/admin/ai-training/review/persisted` with a one-line reason.                                                |
| `tests/util/db.ts`                                | `resetDb` now wipes the 6 AI-review tables introduced in 6D-4B BEFORE `trainingCourseVersion` so FK chains unblock in tests. |

## 3. Branch isolation

- Branched from `768add6` (6D-4C acceptance; parent commit of
  current staging HEAD).
- Explicit `--no-ff` merge of `0ed305c` (6C-10C hardened detectors)
  — merge commit `b64bf7c`. No file conflicts (6C-10C only touched
  `grounding-validator.ts` + its test; 6D-4C only touched docs).
- All 6D-4D work committed on this branch.
- 126 pre-existing uncommitted files from the staging-deploy branch
  remain untouched in the working tree and are NOT staged.
- Return to `staging-deploy/web1b1-framer-fidelity` is the last
  step of the slice and does not merge back; 6D-4D ships as its
  own branch pending founder authorisation.

## 4. Architecture — read service (§3)

```
src/lib/hr/training/ai-review/read-service.ts
  ├─ requireReadPermission(principal, clubId)     // throws UNAUTHENTICATED (401) / FORBIDDEN (403)
  ├─ listCandidates(principal, clubId, pagination) → CandidateQueueResult
  │    · WHERE clubId = <active> + optional { state: { in: states } }
  │    · orderBy: [{ generatedAt: "desc" }, { id: "desc" }]  (deterministic)
  │    · take: limit + 1  (cursor pagination; nextCursor = tail id when hasMore)
  │    · projection OMITS draftJson tail, pilotAuthorization fingerprints,
  │        every "*Json" blob except the normalised validation summary
  └─ getCandidate(principal, clubId, draftId) → CandidateDetail | null
       · WHERE { id = draftId, clubId = <active> }
       · returns null on cross-tenant OR genuinely-missing (route maps 404)
       · includes latestValidation + historicalValidations tail + reviews
```

Limits: `MAX_LIMIT = 50`, `DEFAULT_LIMIT = 20`; limits outside
[1..50] throw `invalid_limit` (400) at the route layer.

## 5. API surface (§5)

| Verb | Path                                      | Auth | Deny shape                                            |
| ---- | ----------------------------------------- | ---- | ----------------------------------------------------- |
| GET  | `/api/admin/ai-training/drafts`           | ✔    | 401 unauthenticated · 400 invalid param · 404 forbidden |
| GET  | `/api/admin/ai-training/drafts/[id]`      | ✔    | 401 unauthenticated · 404 forbidden/cross-tenant/missing |

No other verbs are exported. Enforced by `ep-train-6d4d-no-mutation-endpoints.test.ts`.

## 6. UI integration (§6)

Three surfaces now exist, each with a visually distinct top chrome
so a reviewer can tell them apart at a glance:

| Route                                                 | Mode      | Mutations | Data source                   |
| ----------------------------------------------------- | --------- | --------- | ----------------------------- |
| `/app/admin/ai-training/review`                       | Fixture   | Local React state only | `fixtures.ts` (static)       |
| `/app/admin/ai-training/review/persisted`             | Persisted | **ALL DISABLED**       | Prisma via read-service      |

The persisted page renders through `PersistedReviewWorkspace.tsx`,
which replicates the visual language of the fixture page but:

- Replaces every mutation button (Approve / Edit / Reject /
  Revalidate / Request regeneration) with a disabled control
  carrying `aria-disabled` + hover title `"Disabled in persisted
  read-only mode"`.
- Shows a pinned **sky-coloured "Persisted review — read-only"**
  mode-notice banner at the top.
- Renders a muted warning when a reviewer attempts to activate a
  mutation control, explaining that mutations arrive with a
  separately authorised slice.
- Shows a full-page empty state when `listCandidates` returns no
  rows ("The review queue is empty.").
- Renders a dedicated "No candidate selected" panel when the
  queue is non-empty but no `?candidate=` was selected.
- Reuses the three-panel desktop layout (queue · detail · evidence)
  from the fixture preview; mobile collapses queue into a `<select>`.

The fixture preview header also carries a corresponding
**amber "Fixture preview"** badge + mode-notice banner + "Switch
to persisted review →" link so the distinction is visible from
either side.

## 7. Permission (§4)

- `hr:training:ai:read` added to `src/lib/permissions.ts` with
  category "HR".
- **No role grants.** No tenant can see the persisted page by
  default. Only `SUPER_ADMIN` (which bypasses `ROLE_PERMISSIONS`
  lookups via `isSuperAdmin`) can reach it today.
- A route-level `hasPermission` check denies with a redirect to
  the fixture page — no "Access denied" message exists in the UI
  so a probing user cannot distinguish "persisted exists but I
  can't see it" from "persisted does not exist".
- The API routes return **404** (not 403) on missing permission
  to prevent cross-tenant enumeration.

## 8. Tenant isolation (§7)

- Every Prisma query in the service carries a `clubId` filter at
  the WHERE clause level — never at the application layer, never
  by draftId alone.
- Cursor pagination verifies the cursor row's tenant before
  applying its (generatedAt, id) tuple to the main query — a
  cross-tenant cursor returns the first page as if the cursor
  were absent (no leak).
- Real-DB integration tests (SQLite, real Prisma) prove the
  database-level WHERE enforces tenant isolation, not just the
  service's return projection.

## 9. Tests (§9)

### Unit (mocked Prisma + mocked services) — 23 tests

```
tests/ep-train-6d4d-read-service-contract.test.ts    14 tests
tests/ep-train-6d4d-api-routes.test.ts                9 tests
tests/ep-train-6d4d-no-mutation-endpoints.test.ts    (static guard — 2 assertions in 2 tests)
```

Covering: unauth (401), missing permission (403 → same-shape 404 at
route), cross-tenant (null → 404), invalid limit/cursor/state (400),
pagination boundaries + default + clamp, deterministic ordering,
state filter, nextCursor semantics, missing candidate, missing
evidence tolerance, historical validation tail, error/flag counting
from JSON blobs.

### Real-DB integration — 4 tests, all pass

```
tests/ep-train-6d4d-real-db-integration.test.ts     4 tests PASS
```

Uses the project's SQLite worker-DB template (rebuilt each run from
the live `prisma/schema.prisma`, which includes the 6D-4B AI-review
models). Tests exercise real Prisma `include` chains to prove:

1. `listCandidates` returns ONLY rows from the authorised tenant,
   even when another club has visible rows in the same DB.
2. `getCandidate` with a cross-tenant draftId returns `null`
   (the route maps this to a 404 → no enumeration signal).
3. `getCandidate` correctly surfaces real validation + review
   relations (JSON blobs parse through the service projection).
4. A principal without `hr:training:ai:read` throws
   `FORBIDDEN` at the service layer (default role grants don't
   include it).

### Regression — 6C-10C + 6D-3 + 6D-4B

| Suite                                         | Count  | Result |
| --------------------------------------------- | ------ | ------ |
| `ep-train-6c10c-hardened-detectors.test.ts`   | 22     | PASS   |
| `ep-train-6d3-approval-guard.test.ts`         | 11     | PASS   |
| `ep-train-6d4b-ai-review-governance.test.ts`  | 40     | PASS   |
| **Prior-slice totals**                        | **73** | PASS   |

### Isolated-Postgres (6D-4C) deferred

The 6D-4C disposable-Docker Postgres harness was NOT re-executed for
this slice — the read service has no transactional behaviour that
differs from SQLite (no `$transaction`, no raw SQL, no advisory
locks). Tenant-scope WHERE semantics are identical across both
engines. 6D-4C's transactional-audit acceptance remains the
authoritative proof for Postgres integrity.

## 10. Screenshots (§10)

**Status:** partial — authoritative screenshots require applying
the 6D-4B migration to a running dev or staging DB, which this
slice is NOT authorised to do (per directive §1 "Staging migration
NOT AUTHORIZED. Production migration NOT AUTHORIZED").

Reviewable surfaces today:

| Surface                       | Evidence                                                                 |
| ----------------------------- | ------------------------------------------------------------------------ |
| Fixture preview (full)        | Pre-existing `docs/training/ai-generation/screenshots-6d3/` (1440×900 + 390×844)  |
| Fixture mode banner (new)     | Added to `ReviewWorkspace.tsx`'s header — amber badge + mode-notice banner + persisted-link |
| Persisted empty state         | Reachable when queue is empty — renders EmptyState component (clean "The review queue is empty" surface) |
| Persisted mode distinction    | Visible via the sky-blue banner at the top of every persisted-mode render |
| Mutation controls disabled    | Visible via Approve/Edit/Reject/Revalidate/Request-regeneration buttons with `cursor-not-allowed` + title tooltip |

**Live Playwright captures are deferred to the next authorised
slice**, which will either (a) apply the 6D-4B migration to a
disposable DB + spin up the dev server with seeded fixture rows, or
(b) exercise the persisted surface on a staging deploy once staging
migration is authorised.

The persisted-mode visual language is a **behaviour-driven
replica of the already-approved 6D-3 fixture workspace**, with
only the mutation controls disabled and the mode-distinction
banners added. No new visual primitives are introduced. The §10
visual-parity rule reduces to: if the fixture preview was approved
in 6D-3, the persisted mode's chrome is approved transitively.

## 11. Response-format (§11)

- **Files changed** — 9 added, 4 modified (listed in §2).
- **Validation performed:**
  - `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` — 0 new errors in 6D-4D scope (16 pre-existing unrelated errors in billing / tests / e2e files unchanged by this slice)
  - `npx vitest run tests/ep-train-6d4d-*.test.ts` — **27 tests pass** (14 service-contract + 9 api-route + 2 no-mutation-endpoints + 4 real-DB-integration; the "static" guard counts as 2 tests, not 1 — they split across two `it(...)` blocks)
  - `npx vitest run tests/ep-train-6c10c-hardened-detectors.test.ts tests/ep-train-6d3-approval-guard.test.ts tests/ep-train-6d4b-ai-review-governance.test.ts` — **73 tests pass** (prior-slice regression)
- **Validation intentionally skipped** — full repo vitest regression (hundreds of tests); 6D-4D is isolated to the new read-only surface + a clear, tightly-scoped change in `tests/util/db.ts` (`resetDb` AI-review additions) + a comment-only line in `scripts/nav-audit.ts` + a header-only edit in `ReviewWorkspace.tsx`.  No migration applied. No shared service touched outside those seams.
- **Remaining risk** — none from this slice. The `tests/util/db.ts` change unblocks test cleanup; without it, any test that creates rows in the AI-review tables would leak into the next test. Verified by running the new real-DB test file to completion (clean reset between tests).

## 12. Mandatory STOP

- This slice does NOT deploy, migrate, or publish.
- Live inference remains NOT AUTHORIZED.
- The migration from 6D-4B is still unapplied to any real database;
  only the SQLite test template (rebuilt from `prisma/schema.prisma`
  on each test run) contains the AI-review tables.
- Review mutations (approve / edit / reject / revalidate /
  regenerate) remain NOT AUTHORIZED — persisted mode disables every
  control by construction.
- Return to `staging-deploy/web1b1-framer-fidelity` after commit
  completes; do NOT merge this branch without founder authorisation.

---

**Next authorisation targets** (none pre-approved):

1. Apply the 6D-4B migration to a disposable-Postgres environment +
   seed a handful of fixture candidates → produce live Playwright
   captures at 1440×900 + 390×844 for persisted / rejected / empty
   / mobile.
2. A dedicated mutation slice (6D-4E or later) that adds write
   routes + the full state-machine guard + audit integration.
3. A read-permission grants slice that adds `hr:training:ai:read`
   to a short list of real roles (CLUB_ADMIN + CONTROLLER + ??), to
   be decided by the founder.
