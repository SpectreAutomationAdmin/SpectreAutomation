# EP-TRAIN-6D-4Q — Staging Release Plan (DRH-1 Procedure)

Status: PROPOSED. Not authorised for execution. Do not run any
step on shared staging without a separate founder GO on the EXACT
commit being deployed.

Target: `spectre-staging` Fly app only. Worker deploy NOT required
(no worker code changed between v1095 and the 4P commit).

Reference anchors:
- **Pre-release image**: `registry.fly.io/spectre-staging:sha-5e60fa59894f` (v1095, 2026-11-05).
- **Candidate image**: TBD — built from `ep-train-6d-4p/interactive-reviewer-ux` @ `b2180d53`.

---

## Step 1 — Predeployment checks (local workstation)

```bash
# 1a. Clean working tree on the candidate branch.
git fetch origin
git checkout ep-train-6d-4p/interactive-reviewer-ux
git status                      # expect: clean
git log -1 --oneline            # expect: b2180d53

# 1b. Prisma schema invariants (SQLite parity + PG mirror).
npx prisma generate --schema prisma/schema.prisma
npx prisma validate --schema prisma/schema.prisma
npx prisma validate --schema prisma-postgres/schema.prisma

# 1c. Full offline regression — must be green.
npx vitest run tests/ep-train-6d4*.test.*
# Expected: 179/179 PASS.

# 1d. Scoped typecheck.
NODE_OPTIONS="--max-old-space-size=12288" npx tsc --noEmit 2>&1 | grep -iE "ep.train.6d|ai.training|ai.review"
# Expected: zero errors.
```

**Gate: proceed only if every check is green.**

## Step 2 — Database backup / recovery anchor (Neon)

Neon provides point-in-time recovery automatically. Record the
timestamp immediately before the deploy as the forensic anchor:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ > scratchpad/ep-train-6d4q/release-timestamp.txt
```

For a rollback that must reverse the migration, a Neon PITR restore
to this timestamp is the ONLY safe path. The release plan below does
NOT recommend that rollback mode (§15 explains why).

**Do not take a manual `pg_dump` snapshot** — it would require
exposing the DIRECT_DATABASE_URL on the workstation; Neon's PITR
is the first-class recovery surface.

## Step 3 — Migration application + verification

The Fly `release_command` in `deploy/fly.web.toml` runs
`prisma migrate deploy --schema prisma-postgres/schema.prisma`
against `DIRECT_DATABASE_URL` BEFORE the new image serves traffic.
The 4K migration will apply automatically; no manual migration is
required.

Verification (post-release, before traffic enablement):

```bash
# Run from workstation:
flyctl ssh console --app spectre-staging --command \
  "sh -c 'cd /app && node -e \"
    import(\\\"@prisma/client\\\").then(async ({ PrismaClient }) => {
      const pg = new PrismaClient();
      const m = await pg.\$queryRawUnsafe(\\\"SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name LIKE '%ep_train_6d_4k%'\\\");
      console.log(JSON.stringify(m, null, 2));
      await pg.\$disconnect();
    });\"'"
# Expected: one row with finished_at set.
```

If the migration row is missing OR `finished_at` is null, STOP —
do not enable traffic. Investigate the release_command logs.

## Step 4 — Web + worker deploy requirements

Web only. Worker NOT deployed (no `bin/worker.ts` code changed
between v1095 and `b2180d53`; verify with
`git diff v1095..b2180d53 -- bin/ src/lib/worker*.ts`).

Command (DO NOT RUN YET):

```bash
flyctl deploy --app spectre-staging \
  --config deploy/fly.web.toml \
  --strategy immediate \
  --image-label sha-<short-of-b2180d53>
```

Note: per the project's DRH-1 retry policy:
- MAX 1 retry on transient infra errors.
- Second stall = STOP + report BLOCKED.
- Never rebuild unchanged code.
- Never bypass DRH-1 with `--local-only` without a documented
  reason.

## Step 5 — `/api/health` verification

```bash
curl -sS https://staging.spectreautomation.com/api/health
# Expected: HTTP 200, JSON body { ok: true, ... }
```

If non-200, STOP. Enable immediate rollback via Step 15.

## Step 6 — Authentication + RBAC tests

With the synthetic identity NOT YET created, verify the EXISTING
Fly admin account still signs in correctly:

```
1. Open https://staging.spectreautomation.com/login in an incognito tab.
2. Sign in as spectreautomation.admin@gmail.com.
3. Verify you can reach /app/admin — zero regression.
4. Verify /app/admin/ai-training/review/persisted loads (as SUPER_ADMIN).
```

Then create the Option A synthetic identity (per PHASE-D-4Q-STAGING-PREFLIGHT.md §3.4):

```bash
flyctl ssh sftp put scratchpad/ep-train-6d4q/create-test-identity.mjs --app spectre-staging
flyctl ssh console --app spectre-staging --command "sh -c 'cd /app && node /app/create-test-identity.mjs'"
# Record the returned userId + email.
flyctl ssh console --app spectre-staging --command "sh -c 'rm -f /app/create-test-identity.mjs'"
```

Sign in as the synthetic reviewer; verify `/app/admin/ai-training/review/persisted`
loads and shows the 8 pre-existing historical candidates as
"Historical evidence unavailable" + Approve-disabled. **No approval
attempted yet.**

## Step 7 — Synthetic evidence fixture ingestion

Upload + run the fixture-creation script (per preflight §4):

```bash
flyctl ssh sftp put scratchpad/ep-train-6d4q/create-fixture.mjs --app spectre-staging
flyctl ssh console --app spectre-staging --command "sh -c 'cd /app && node /app/create-fixture.mjs'"
flyctl ssh console --app spectre-staging --command "sh -c 'rm -f /app/create-fixture.mjs'"
```

The script uses the 4L ingest services (`persistTranscriptBuild`,
`persistTranscriptSegments`, `persistGroundingProjection`) via
imports from `src/lib/hr/training/transcription/index.ts` — it
NEVER writes the three new tables via raw `pg.create`. This proves
the 4L surface is wired on staging.

Expected console output: `{ created: true, projectionSha256: "<64 hex>", draftId: "..." }`.

## Step 8 — Authenticated video playback

As the synthetic reviewer (still signed in from Step 6):

```
1. Navigate to /app/admin/ai-training/review/persisted?candidate=<draftId-from-Step-7>
2. The detail pane renders Spectre's premium shell.
3. The evidence panel renders the <video> element with src pointing at
   /api/hr/training/versions/<versionId>/video.
4. Click Play. Video streams; Accept-Ranges honoured; mid-clip seek works.
5. Click a cited segment's ▶ Play button; the video jumps to that
   timestamp.
```

**If video returns 404**: inspect the video endpoint's auth path
(`callerCanReadVersion`) — confirm the SUPER_ADMIN-on-Coulee-Ridge
synthetic has `hr:training:read` on the version's club.

## Step 9 — Evidence viewer + timestamp seeking

Still in the detail pane: confirm the authentic cited segments
render:
- Non-empty `text` on each segment (not "transcript body not persisted").
- Formatted `startSec–endSec` in each segment header.
- Transcription source line reads
  "spectre-synthetic-4q <version> · model …" (per §4.3 of preflight —
  so no operator misreads this as a Whisper pipeline run).

## Step 10 — Human approval transaction

As the synthetic reviewer:
```
1. Click "Approve candidate".
2. The approval dialog opens.
3. VERIFY: no answer is preselected.
4. Select an answer OTHER than the model's prediction.
5. Check "I have reviewed the source evidence".
6. Click "Approve candidate".
7. Wait for the response.
```

Expected: 200, dialog closes, page refreshes.

Then verify server-side:
```bash
flyctl ssh console --app spectre-staging --command "sh -c 'cd /app && node -e \"
  import(\\\"@prisma/client\\\").then(async ({ PrismaClient }) => {
    const pg = new PrismaClient();
    const t = await pg.trainingQuestionAiStateTransition.findFirst({
      where: { draftId: \\\"<fixture-draft-id>\\\" },
      orderBy: { transitionedAt: \\\"desc\\\" },
    });
    console.log(JSON.stringify(t));
    await pg.\$disconnect();
  });\"'"
# Expected: one transition row with toState = 'APPROVED_DRAFT'.
```

## Step 11 — Verified-answer rendering

After the refresh in Step 10:
- The selected option row renders in emerald with the
  "Verified correct" chip.
- The reviewer identity appears alongside.
- The original model-picked option is labelled
  "Model-selected · unverified".
- The "Approve candidate" button is now disabled with reason
  `ALREADY_VERIFIED`.

**If the emerald chip does NOT render** but Step 10's transition
row exists, the verified-answer-reader (4N) detected an integrity
warning. Inspect `verifiedCorrectAnswerSnapshotJson` on the
validation row + the draft's content hash — they MUST be bound to
each other.

## Step 12 — Historical candidate regression

Navigate to each of the 8 historical Coulee Ridge candidates:
`/app/admin/ai-training/review/persisted?candidate=<each-id>`.

Expected for every one:
- "Historical evidence unavailable" banner on the evidence panel.
- Approve button disabled.
- Disabled reason copy: "Approval is unavailable: the pilot-era
  transcript evidence was not durably persisted for this candidate."

**Any historical candidate that becomes approve-eligible is a 4Q
release defect — STOP and investigate `groundingProjectionId`
population.**

## Step 13 — Desktop screenshot capture (1440 × 900)

Three authenticated Playwright screenshots:

- `screenshots-6d4q/1440-pre-approval.png` — detail page BEFORE
  approval, Approve enabled, dialog closed.
- `screenshots-6d4q/1440-dialog-open.png` — dialog open, no answer
  preselected, attestation unchecked.
- `screenshots-6d4q/1440-post-approval.png` — detail page AFTER
  approval, emerald "Verified correct" chip visible.

File into `docs/training/ai-generation/screenshots-6d4q/` on the 4Q
documentation branch (or a dedicated 4Q-acceptance branch).

## Step 14 — Mobile screenshot capture (390 × 844)

Same three screenshots at iPhone-portrait viewport. Confirm:
- The review workspace collapses to a single scrollable column.
- The approval dialog remains readable (buttons in the viewport,
  no horizontal scroll).

## Step 15 — Fixture + permission cleanup

In reverse order of creation (child first):

```bash
# 15a. Teardown the synthetic fixture draft + associated 4K rows.
flyctl ssh sftp put scratchpad/ep-train-6d4q/teardown-fixture.mjs --app spectre-staging
flyctl ssh console --app spectre-staging --command "sh -c 'cd /app && node /app/teardown-fixture.mjs'"
flyctl ssh console --app spectre-staging --command "sh -c 'rm -f /app/teardown-fixture.mjs'"

# 15b. Teardown the synthetic reviewer identity.
flyctl ssh sftp put scratchpad/ep-train-6d4q/teardown-test-identity.mjs --app spectre-staging
flyctl ssh console --app spectre-staging --command "sh -c 'cd /app && node /app/teardown-test-identity.mjs'"
flyctl ssh console --app spectre-staging --command "sh -c 'rm -f /app/teardown-test-identity.mjs'"

# 15c. Verify the 8 historical Coulee Ridge drafts are unchanged.
flyctl ssh console --app spectre-staging --command "sh -c 'cd /app && node -e \"
  import(\\\"@prisma/client\\\").then(async ({ PrismaClient }) => {
    const pg = new PrismaClient();
    const n = await pg.trainingQuestionAiDraft.count({ where: { clubId: \\\"cmrvdeny7000144372ktmmg9c\\\" } });
    console.log(\\\"draft count:\\\", n);
    await pg.\$disconnect();
  });\"'"
# Expected: 8 (no change from §1.4 preflight).
```

## Step 16 — Rollback + incident response

### 16.1 Application-only rollback (REVERSIBLE)

If the new web image misbehaves but the 4K schema is well:

```bash
flyctl deploy --app spectre-staging \
  --image registry.fly.io/spectre-staging:sha-5e60fa59894f \
  --strategy immediate
```

The old image runs fine on the new schema (additive migration is
backward-compatible). This is the DEFAULT rollback mode.

### 16.2 Migration-reversing rollback (IRREVERSIBLE WITHOUT PITR)

Only required if a 4K schema change is proven to corrupt data.
Three paths:

- **Preferred**: Neon point-in-time restore to `release-timestamp.txt`.
  Requires founder authorisation + a dedicated recovery window.
  `flyctl` alone CANNOT achieve this.
- **Manual reverse migration**: hand-authored SQL dropping the 3
  tables + 3 columns. Risk: cascading FK references from the
  synthetic fixture would already be removed in Step 15; ensure
  the fixture is cleaned up BEFORE dropping tables.
- **Leave the schema in place; redeploy the old image**: identical
  to §16.1. The 3 new tables + columns remain unused. Safe but
  leaves orphaned structure.

### 16.3 Incident criteria that trigger rollback

- `/api/health` returns non-200 for >60s after the Fly deploy
  reports `complete`.
- A historical candidate becomes accidentally approve-eligible
  (Step 12 fails).
- The synthetic approval transaction leaves the draft in any state
  other than `APPROVED_DRAFT`.
- Any CLUB_ADMIN session gains approve capability (Step 6 regression).
- Error-rate spike in Fly logs during the release window.

### 16.4 Reversible vs non-reversible step summary

| Step kind                                 | Reversible by Fly image revert alone | Reversible by anything but Neon PITR |
| ----------------------------------------- | :----------------------------------: | :----------------------------------: |
| Fly image deploy (Step 4)                 | ✅                                    | ✅                                    |
| Prisma 4K migration (Step 3, auto)        | ❌                                    | ❌ (requires PITR or manual reverse)  |
| Synthetic identity creation (Step 6)      | ✅ (Step 15b)                         | ✅                                    |
| Synthetic fixture creation (Step 7)       | ✅ (Step 15a)                         | ✅                                    |
| Approval transaction (Step 10)            | partially — the row history remains  | ✅ (Step 15 removes the fixture draft) |

**Do NOT promise the founder that a Fly image rollback reverses the
4K migration.** It does not. The schema is new; the application that
was running before 4K simply ignores the new structure.

---

## Appendix A — Release-day checklist (print-friendly)

- [ ] Local checks green (Step 1)
- [ ] Release timestamp recorded (Step 2)
- [ ] Fly deploy complete (Step 4)
- [ ] 4K migration row present (Step 3 verify)
- [ ] /api/health 200 (Step 5)
- [ ] Admin account unaffected (Step 6)
- [ ] Synthetic identity created (Step 6)
- [ ] Fixture seeded (Step 7)
- [ ] Video plays + seek works (Step 8)
- [ ] Segments render with real text (Step 9)
- [ ] Approval commits (Step 10)
- [ ] Emerald chip renders (Step 11)
- [ ] 8 historicals untouched (Step 12)
- [ ] 1440 screenshots captured (Step 13)
- [ ] 390 screenshots captured (Step 14)
- [ ] Fixture + identity torn down (Step 15)
- [ ] Draft count back to 8 (Step 15c)
- [ ] Rollback anchor documented in acceptance report (Step 16)
