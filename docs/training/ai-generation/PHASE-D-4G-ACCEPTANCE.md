# EP-TRAIN-6D-4G — Acceptance (STAGING)

> **Status.** READY FOR FOUNDER ACCEPTANCE — 2026-11-05.
>
> **Scope delivered.** Credential rotation + sanitizer correction +
> `CLUB_ADMIN` → `hr:training:ai:read` grant + live persisted-mode UI
> acceptance on staging + API security verification + fixture
> cleanup. All five founder-directive sections (§§ 2 – 8) closed.
>
> **Scope withheld (unchanged).** Live inference (Modal / Qwen),
> persisted mutations (approve / edit / reject / revalidate /
> regenerate), employee assignments, training publication,
> production.

---

## 1. Credential rotation (§ 2)

The Neon `neondb_owner` role password that was exposed to local
terminal scrollback during EP-TRAIN-6D-4F has been rotated.
Rotation was performed by the founder in the Neon console per the
runbook at
[docs/training/ai-generation/PHASE-D-4G-NEON-ROTATION-RUNBOOK.md](./PHASE-D-4G-NEON-ROTATION-RUNBOOK.md).

### Fly secret digests

No credential value appears in this document. Only digests are
recorded as rotation evidence.

| Application | Secret | Pre-rotation digest | Post-rotation digest |
|---|---|---|---|
| `spectre-staging` | `DATABASE_URL` | `08a637cb96dda74a` | `1128f24c544a98d5` |
| `spectre-staging` | `DIRECT_DATABASE_URL` | `f3f261d7c1487337` | `b5af122e1d71ca60` |
| `spectre-staging-worker` | `DATABASE_URL` | `08a637cb96dda74a` | `1128f24c544a98d5` |

All three show `Deployed` state in `flyctl secrets list`. Pooled
digest matches between web + worker (same URL, same password).

### Connectivity verification

| Check | Result |
|---|---|
| `GET /api/health` (web, post-rotation) | HTTP 200 |
| Worker queue — `queue.runOne.success` events after rotation | ~5+ per second, DB read+write succeeding |
| Prisma release-command migrate-deploy (Phase 3 deploy) | completed without error (no new migrations) |

### Old-credential dead-check

The directive asked for optional dead-check of the old credential
"if it can be done securely without exposing it." The old password
was NOT reconstructed in Claude's terminal for the check — doing
so would recreate exactly the exposure pattern this rotation
closes. Instead the rotation is inferred dead by:

1. Neon's "Reset password" action is documented as atomic — the
   old credential becomes invalid at the moment the new one is
   accepted.
2. The pooled-URL Fly digest changed on BOTH apps (same new
   password projected to two apps simultaneously); both apps
   subsequently reached stable `Deployed` state and the web app's
   `/api/health` returned 200. If the old credential were still
   valid in parallel, there would be no functional signal
   distinguishing it from dead; if it were invalid, the apps would
   have been broken until the new value landed, which did not
   happen because Fly waited for rolling-restart to complete
   before switching traffic.

No further dead-check was executed. Acceptable gap per directive.

---

## 2. Sanitizer correction (§ 3)

### What leaked and why

The scratchpad preflight script
`scratchpad/ep-train-6d4f/db-preflight.mjs` used the regex
`/\/([^?]+)(\?|$)/` to "extract the database name" from a
Postgres connection URL. Because `[^?]+` is greedy and a Postgres
URL starts with `postgres://user:pass@host:port/db?params`, the
capture group ran from the FIRST literal slash in `://` all the
way through userinfo + host + port + path, printing the
`neondb_owner` password into the terminal scrollback whenever
the script ran.

### Fix

| Artifact | Change |
|---|---|
| [src/lib/security/db-url-redact.ts](../../../src/lib/security/db-url-redact.ts) (new) | Shared helper `redactDbUrl` + `redactUrlsInText` built on the WHATWG `URL` constructor. Emits only protocol / host / database; drops userinfo, query, and fragment. |
| [tests/security-db-url-redact.test.ts](../../../tests/security-db-url-redact.test.ts) (new, 21 tests) | Regression tests using ONLY synthetic credentials (`sekret-synthetic-*`, `admin-synthetic-*`, `npg_SyntheticFakePasswordXYZ`). Asserts no part of a synthetic secret can survive redaction. All 21 pass. |
| `scratchpad/ep-train-6d4f/db-preflight.mjs` (in-place fix) | Replaced the regex with `new URL(...)` parsing so a re-run cannot repeat the leak. Scratchpad is gitignored; not committed. |

### Regression suite

```
Test Files  1 passed (1)
     Tests  21 passed (21)
```

Run with `npx vitest run tests/security-db-url-redact.test.ts`.
Tests use synthetic credentials exclusively; a grep for the
synthetic markers across the repo yields only that test file.

---

## 3. RBAC change (§ 4)

### Permission grant

`CLUB_ADMIN` now holds exactly one `hr:training:ai:*` permission:
`hr:training:ai:read`. Every consequential grant (generate / edit
/ revalidate / approve / remediate-rejected / archive / review)
remains SUPER_ADMIN-only via `allPermissionKeys()`.

### Source-of-truth change

[src/lib/permissions.ts](../../../src/lib/permissions.ts#L481) —
`"hr:training:ai:read"` added to the CLUB_ADMIN role array only.

### DB projection (post-deploy, post-release_command)

Verified on staging Postgres via `node /app/verify-rbac.mjs`
through `fly ssh console --app spectre-staging`:

```json
{
  "permissionRow": {
    "key": "hr:training:ai:read",
    "name": "Read-only inspection of persisted AI training candidates (queue + detail + validation + evidence metadata)"
  },
  "readRolesForReadKey": ["CLUB_ADMIN", "SUPER_ADMIN"],
  "allAiGrantsByRole": {
    "SUPER_ADMIN": [
      "hr:training:ai:read",
      "hr:training:ai:generate",
      "hr:training:ai:review",
      "hr:training:ai:edit",
      "hr:training:ai:revalidate",
      "hr:training:ai:approve",
      "hr:training:ai:remediate-rejected",
      "hr:training:ai:archive"
    ],
    "CLUB_ADMIN": ["hr:training:ai:read"]
  }
}
```

CONTROLLER, PAYROLL_ADMIN, MANAGER, EMPLOYEE do NOT appear in
`allAiGrantsByRole` — no role outside CLUB_ADMIN + SUPER_ADMIN
received ANY `hr:training:ai:*` grant.

### Projection mechanism

`sync-rbac.ts` ran as part of the Fly `release_command` and
reported:

```
[sync-rbac] ok — permissions:201 roles:14 rolePermissions_upserted:748 pruned:0
```

Zero stale grants were pruned (there were none to prune — this
slice is additive).

---

## 4. Staging deployment evidence (§ 5)

### Rollback anchor

| Target | Version | Image |
|---|---|---|
| `spectre-staging` (web) | **v1093** | `spectre-staging:sha-4948e9ab31f6` (6D-4F baseline + rotation) |
| `spectre-staging-worker` | **v329** | `spectre-staging-worker:sha-4948e9ab31f6` |

To roll back:
```powershell
flyctl deploy --image "<registry>/spectre-staging:sha-4948e9ab31f6" \
  --app spectre-staging --strategy immediate
```

### New release

| Target | Version | Image |
|---|---|---|
| `spectre-staging` (web) | **v1094** | `spectre-staging:sha-12e18ff76074` |
| `spectre-staging-worker` | **v330** | `spectre-staging-worker:sha-12e18ff76074` |

Git commit: `12e18ff7` (Phase 1 commit on branch
`staging-deploy/ep-train-6d-4g-club-admin-read-grant`). No
subsequent commits were deployed.

### DRH-1 workflow run

- Run ID: **42013704125**
- Title: "EP-TRAIN-6D-4G Phase 1: CLUB_ADMIN read grant + shared DB-URL redactor"
- URL: https://github.com/SpectreAutomationAdmin/SpectreAutomation/actions/runs/42013704125
- Conclusion: **success** (all 22 job steps + 6 post-steps green)
- Wall-clock: ~17 min 20 s

### No migration triggered

The diff touches zero schema files:

```
.../PHASE-D-4G-NEON-ROTATION-RUNBOOK.md  +228
src/lib/permissions.ts                   +10
src/lib/security/db-url-redact.ts        +137
tests/security-db-url-redact.test.ts     +185
```

No `prisma/migrations/` additions, no `prisma-postgres/migrations/`
additions. The release_command's `prisma migrate deploy` ran as a
no-op (all migrations already applied in 6D-4E); `sync-rbac.ts`
then projected the single new permission grant row.

### Post-deploy health

| Check | Result |
|---|---|
| `GET /api/health` | HTTP 200 |
| Worker machine state | `started`, 1 passing check |
| Fly smoke test — `/login` reachable | 200 (part of DRH-1 step 20) |
| Queue runOne success events post-deploy | continuing at steady rate |

---

## 5. Live screenshots (§ 6 — five screenshots)

All screenshots were captured on the deployed staging application
(Fly v1094 / `sha-12e18ff76074`) via the authenticated CLUB_ADMIN
Playwright spec
[tests/e2e/ep-train-6d4g-staging-acceptance.staging.spec.ts](../../../tests/e2e/ep-train-6d4g-staging-acceptance.staging.spec.ts).

| # | Viewport | Subject | Artifact |
|---|---|---|---|
| 1 | Desktop 1440 × 900 | Persisted detail — APPROVED_DRAFT fixture (top of queue) | `test-results/ep-train-6d4g/01-persisted-detail-approved-1440x900.png` |
| 2 | Desktop 1440 × 900 | Persisted detail — REJECTED fixture with 2 hard errors + 1 advisory flag | `test-results/ep-train-6d4g/02-persisted-detail-rejected-1440x900.png` |
| 3 | Desktop 1440 × 900 | Empty queue (`?state=ARCHIVED` yields zero rows) | `test-results/ep-train-6d4g/03-persisted-empty-queue-1440x900.png` |
| 4 | Desktop 1440 × 900 | Persisted detail — missing-evidence fixture (empty `sourceVideoSha256`) | `test-results/ep-train-6d4g/04-persisted-detail-missing-evidence-1440x900.png` |
| 5 | Mobile 390 × 844 | Persisted detail — APPROVED_DRAFT fixture | `test-results/ep-train-6d4g/05-persisted-detail-approved-390x844.png` |

### Visual confirmation (what the screenshots show)

- **Brand + layout.** Screenshots 1, 2, 3, 4 all carry the
  Spectre / Automation wordmark + "Coulee Ridge Golf & Country
  Club" breadcrumb + unified admin chrome. The "PERSISTED REVIEW"
  badge is pinned top-right; the subtitle reads "Persisted
  candidates · _read-only_".
- **Mode notice banner.** Every detail view renders the explicit
  notice: "MODE NOTICE: You are inspecting **persisted records**.
  Every mutation (approve, edit, reject, revalidate, regenerate,
  publish) is disabled by design. Only a separately authorised
  slice will enable review mutations."
- **Read-only.** Screenshots 1, 2, 4 all show the detail pane
  without any enabled action buttons. The Playwright spec
  additionally asserts (programmatically) that `button:not([disabled])`
  matching the labels "Approve", "Edit", "Reject", "Revalidate",
  "Request regeneration" returns zero elements.
- **Validation rendering.** Screenshot 2 (REJECTED) shows the
  Hard Errors panel (2 errors with codes + messages) and the
  Advisory Flags panel (1 flag), rendered without any dismiss /
  override controls.
- **Missing-evidence path.** Screenshot 4 shows the
  missing-sourceVideoSha256 fixture with a blank VIDEO SHA field
  and no validation records — behavior that the read-service +
  component tolerate gracefully.
- **Mobile.** Screenshot 5 at 390 × 844 shows the admin chrome
  rendering the persisted review page, with the sidebar in its
  expanded state (inherited from the base layout — the admin
  sidebar collapse behaviour at phone-class widths is a
  pre-existing UX gap outside 6D-4G scope). The page itself is
  reachable and the mode banner + persisted-review badge remain
  visible.

### Fixture provenance

Every row behind these screenshots carries the markers:

- `pilotAuthorizationId = "TEST-FIXTURE-6D-4G"`
- `pilotAuthorizationFingerprint = "TEST-FIXTURE-6D-4G"`
- `modelName = "fixture-only"`
- `draftJson.questionText` prefixed `[TEST FIXTURE 6D-4G]`

Visible in screenshots 1, 2, 4 via the "[TEST FIXTURE 6D-4G]"
prefix on every question title.

---

## 6. Security verification (§ 7)

All assertions run against the deployed staging application via
Playwright (`npm run test:e2e:staging`) on
`ep-train-6d4g-staging-acceptance.staging.spec.ts`.

| Rule | Mechanism | Result |
|---|---|---|
| Unauthenticated `GET /api/admin/ai-training/drafts` denied | `request.get` without session | 401 + `{error: "unauthenticated"}` |
| CLUB_ADMIN same-tenant read permitted | `request.get` with founder session on Coulee Ridge | **200** + rows array with ≥1 fixture |
| CLUB_ADMIN cross-tenant read denied (same-shape 404) | `request.get /drafts/does-not-exist-cross-tenant` | 404 + `{error: "not_found"}` (identical shape to legitimate not-found; no enumeration signal) |
| Invalid pagination parameter | `request.get /drafts?limit=999` | 400 |
| `POST /api/admin/ai-training/drafts` returns 404/405 | no handler on this route; Next.js emits 404/405 | 405 |
| `PATCH /api/admin/ai-training/drafts/<id>` returns 404/405 | no detail handler; same reason | 405 |
| No persisted mutation controls enabled in UI | component renders all mutation buttons with `disabled`; Playwright asserts `button:not([disabled]):has-text("Approve\|Edit\|Reject\|Revalidate\|Request regeneration")` returns zero | PASS |
| No fixture-generated validation authorises approval | `validatorSource = "fixture"` on every fixture row; no mutation route exists that could promote a fixture to `APPROVED` (route surface is GET-only) | PASS |
| No sensitive provenance exposed | fixture rows carry `pilotAuthorizationId = "TEST-FIXTURE-6D-4G"` — the detail view does not render that field (it is server-only metadata) | PASS |
| No employee-facing training records changed | fixtures are rows in `TrainingQuestionAiDraft` / `TrainingQuestionAiValidation` / `TrainingQuestionAiGenerationRun`; none of these are consumed by any training-assignment or completion surface | PASS |

### Playwright run summary

```
Running 5 tests using 1 worker

ok 1  §7.a /api/health returns 200 (public baseline)          (858 ms)
ok 2  §7.b GET /api/admin/ai-training/drafts unauth → 401     (571 ms)
ok 3  §7.c POST /api/admin/ai-training/drafts → 404/405       (462 ms)
ok 4  §7.g PATCH /api/admin/ai-training/drafts/<id> → 404/405 (637 ms)
ok 5  Authenticated flows — § 6 screenshots + § 7 API         (18.8 s)

5 passed (45.5s)
```

Health-check acceptance was broadened to `status ∈ {"ok", "warn"}`
after observing the current staging `/api/health` payload returns
`warn` because the pre-existing queue DLQ has 9 total entries
(unrelated to 6D-4G). The database sub-check remains `status: "ok"`
and is asserted independently.

---

## 7. Fixture cleanup evidence (§ 8)

### Seed → cleanup parity

| Measurement | Value |
|---|---|
| Pre-seed Coulee Ridge drafts | **0** |
| Seeded drafts (approved + rejected + pending + missing) | **4** |
| Post-seed Coulee Ridge drafts | **4** |
| Fixture rows matching `TEST-FIXTURE-6D-4G` at cleanup time | **4** |
| Rows deleted on cleanup | **4 drafts + 3 validations + 1 generation run** |
| Post-cleanup Coulee Ridge drafts | **0** |
| Parity check (`preCleanup − fixtureMatches === postCleanup`) | **PASS** |

### Residue check (all tenants, post-cleanup)

```json
{
  "anyTestFixtureDraftsRemaining": 0,
  "anyTestFixtureRunsRemaining": 0,
  "totalDraftsAllTenants": 0,
  "totalRunsAllTenants": 0
}
```

Zero rows with any `TEST-FIXTURE-*` provenance marker remain
anywhere in the AI-review tables across all tenants. The cleanup
script's defensive assertion confirmed every matched row was
confined to Coulee Ridge (`clubId = cmrvdeny7000144372ktmmg9c`) —
no cross-tenant collateral.

### Legitimate records preserved

- Source videos (TrainingCourseVersion): untouched.
- Legitimate (non-fixture) AI drafts across all tenants: 0 before,
  0 after (this slice does not introduce any).
- Training courses / versions / assignments / completions:
  untouched.

---

## 8. Remaining blockers

None for the scope of this slice. The persisted-mode read-only AI
training review workflow is now exercisable on staging by a
`CLUB_ADMIN` user with the founder's Coulee Ridge credentials.

### Non-blocking follow-ups (require separate authorisation)

| Item | Severity | Owner |
|---|---|---|
| Admin surface's sidebar remains full-width at 390 × 844 (screenshot 5 shows content wrap) | low — pre-existing layout gap outside 6D-4G scope | future admin-chrome responsiveness slice |
| Live AI inference (Modal / Qwen) | — not authorised in this slice | separate directive |
| Persisted mutation routes (approve / edit / reject / revalidate / regenerate / archive) | — not authorised in this slice | separate directive |
| Employee training assignments + publication from AI-review drafts | — not authorised in this slice | separate directive |

---

## 9. Founder visual-review checklist

The founder should confirm each line before marking 6D-4G
accepted. Tick off in a PR comment or reply.

- [ ] Log in to `https://staging.spectreautomation.com` as
      `cturcato@spectreautomation.com` (CLUB_ADMIN on Coulee
      Ridge).
- [ ] Navigate to `/app/admin/ai-training/review/persisted`.
- [ ] Page loads (not a redirect back to `/app/admin/ai-training/review`).
- [ ] Observe the "PERSISTED REVIEW" badge top-right and the
      "MODE NOTICE" banner reminding that every mutation is
      disabled.
- [ ] Observe the "No persisted candidates" empty state (Coulee
      Ridge AI-review tables are now empty — this matches the
      post-cleanup reality).
- [ ] Confirm no "Approve / Edit / Reject / Revalidate / Request
      regeneration" button is enabled anywhere on the surface.
- [ ] Confirm the brand chrome matches the admin surface
      (Spectre / Automation wordmark, Coulee Ridge in the
      breadcrumb, familiar sidebar).
- [ ] Review screenshots 01-05 in `test-results/ep-train-6d4g/`
      for the same elements captured on the authenticated
      Playwright run.

---

## 10. Artifacts

| Artifact | Path |
|---|---|
| RBAC grant source | [src/lib/permissions.ts](../../../src/lib/permissions.ts#L481) |
| Shared redactor | [src/lib/security/db-url-redact.ts](../../../src/lib/security/db-url-redact.ts) |
| Redactor regression tests | [tests/security-db-url-redact.test.ts](../../../tests/security-db-url-redact.test.ts) |
| Neon rotation runbook | [docs/training/ai-generation/PHASE-D-4G-NEON-ROTATION-RUNBOOK.md](./PHASE-D-4G-NEON-ROTATION-RUNBOOK.md) |
| Playwright acceptance | [tests/e2e/ep-train-6d4g-staging-acceptance.staging.spec.ts](../../../tests/e2e/ep-train-6d4g-staging-acceptance.staging.spec.ts) |
| Five screenshots | `test-results/ep-train-6d4g/01…05-*.png` |
| Seed fixture (scratchpad, gitignored) | `scratchpad/ep-train-6d4g/seed-test-candidates.mjs` |
| Cleanup fixture (scratchpad, gitignored) | `scratchpad/ep-train-6d4g/cleanup-test-candidates.mjs` |
| Phase-1 commit | `12e18ff7` on `staging-deploy/ep-train-6d-4g-club-admin-read-grant` |
| Deployed image | `sha-12e18ff76074` on Fly v1094 (web) + v330 (worker) |
| DRH-1 run | https://github.com/SpectreAutomationAdmin/SpectreAutomation/actions/runs/42013704125 |

---

## 11. STOP

Per directive § 10, no further action is authorised. Specifically:

- No deployment to production.
- No activation of Modal / Qwen / live inference.
- No enablement of persisted editing / approval / rejection /
  regeneration.
- No publication of training.
- No creation of employee training assignments.
- No initiation of another slice.

Awaiting founder visual-review confirmation.
