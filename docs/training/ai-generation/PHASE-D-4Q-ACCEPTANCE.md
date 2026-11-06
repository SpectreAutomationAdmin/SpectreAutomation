# EP-TRAIN-6D-4Q — Staging Integration Preflight — Acceptance

Status: PREFLIGHT COMPLETE. Awaiting founder authorisation of the
**candidate commit + release window** before executing the DRH-1
release plan.

Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4q/staging-preflight` (documentation + rehearsal
harness only — not pushed).

## 1. Scope recap

Preflight for a staging deployment of the EP-TRAIN-6D-4K through 4P
stack onto `spectre-staging`. 4Q does NOT execute the release — it
produces the inventory, the migration rehearsal evidence, the
authorization + fixture + video + idempotency findings, the
operational plan, and a GO / NO-GO recommendation.

**Candidate code**: `ep-train-6d-4p/interactive-reviewer-ux` at
commit `b2180d53`. All earlier accepted commits (4B / 4K / 4L / 4M /
4N) are ancestors of this commit.

**Rollback anchor**: Fly image
`registry.fly.io/spectre-staging:sha-5e60fa59894f` (v1095, released
2026-11-05).

## 2. Deliverables produced

| Document                                                    | Role                                      |
| ----------------------------------------------------------- | ----------------------------------------- |
| [PHASE-D-4Q-STAGING-PREFLIGHT.md](PHASE-D-4Q-STAGING-PREFLIGHT.md) | Source inventory, migration rehearsal, auth model, fixture spec, video + idempotency findings. |
| [PHASE-D-4Q-RELEASE-PLAN.md](PHASE-D-4Q-RELEASE-PLAN.md)    | 16-step DRH-1 procedure, rollback modes, reversibility matrix. |
| This file                                                   | Summary + GO/NO-GO.                       |

Harness artefacts (scratchpad — gitignored):

- `scratchpad/ep-train-6d4q/migration-rehearsal.mjs`
- `scratchpad/ep-train-6d4q/migration-rehearsal-output.txt`
- `scratchpad/ep-train-6d4q/migration-rehearsal-result.json`
- `scratchpad/ep-train-6d4q/check-staging-migrations.mjs`
- `scratchpad/ep-train-6d4q/count-candidates.mjs`

## 3. Findings summary

### 3.1 Exact staging baseline + rollback anchor

- Current Fly release: **v1095** / image `sha-5e60fa59894f`
  (2026-11-05).
- Prisma migration state: 4B applied (2026-11-04), 4K **not**
  applied.
- 8 historical AI drafts on Coulee Ridge
  (`cmrvdeny7000144372ktmmg9c`); 5 `REQUIRES_HUMAN_REVIEW`, 3
  `REJECTED`.

### 3.2 Migration rehearsal evidence

Harness run on disposable `postgres:16-alpine` on
`localhost:15436` (container `--rm` after the rehearsal):

```
PASS  T1 both migration files contain no DROP/TRUNCATE/ALTER…DROP
PASS  T2 apply 4B migration — all 6 tables created
PASS  T3 apply 4K migration — all 3 tables + 3 columns present
PASS  T4 raw-SQL replay fails on FK (preflight finding — do NOT replay 4K by hand)
PASS  T5 pre-existing Club / Course / Version rows preserved byte-identical
PASS  T6 4K rollback does not affect 4B tables (reversible layering)
PASS  T7 4K re-apply after rollback succeeds
SUMMARY  pass=7 fail=0 total=7
```

**Key finding (T4):** 4K's `ALTER TABLE … ADD CONSTRAINT … FOREIGN
KEY` has no `IF NOT EXISTS` form. A hand-replay via raw SQL fails.
`prisma migrate deploy` is unaffected because it consults the
`_prisma_migrations` ledger before re-running. → The release plan
forbids manual SQL migration on staging.

### 3.3 Authentication + permission matrix

| Role          | ai:read | ai:approve | training:read |
| ------------- | :-----: | :--------: | :-----------: |
| SUPER_ADMIN   | ✅       | ✅          | ✅             |
| CLUB_ADMIN    | ✅       | ❌          | ✅             |
| Others        | —       | —          | —             |

The 4N approval route + 4P eligibility service both enforce
`ai:approve`. CLUB_ADMIN cannot approve; the dialog does not open.

**Narrowest test identity**: a synthetic user with a single
`UserClubRole` row `{clubId: cmrvdeny7000144372ktmmg9c, roleKey:
"SUPER_ADMIN"}`. Scope is bounded to Coulee Ridge; no RBAC catalogue
change; audit attribution tied to the synthetic userId. Creation +
teardown procedures documented in the preflight doc §3.4.

### 3.4 Synthetic fixture specification

One deliberately-constructed candidate that exercises the real
4L+4M+4N+4P pipelines:

- 1 new `TrainingCourse` + `TrainingCourseVersion` with an uploaded
  10-second synthetic MP4.
- 1 `TrainingTranscriptBuild` with
  `transcriberName = "spectre-synthetic-4q"` (deliberately NOT a
  Whisper label, so no operator misreads this as AI-generation
  evidence).
- 3 hand-authored `TrainingTranscriptSegment` rows with real text +
  timestamps.
- 1 `TrainingGroundingProjection` with server-recomputed canonical
  SHA-256.
- 1 `TrainingQuestionAiDraft` (state `REQUIRES_HUMAN_REVIEW`,
  SINGLE_CHOICE, model-picked answer is deliberately WRONG so the
  reviewer discovers the correct one).
- 1 `TrainingQuestionAiValidation` (verdict `GROUNDED` or
  `REQUIRES_HUMAN_VERIFICATION`, zero hard errors).

Full teardown procedure documented. Post-teardown the Coulee Ridge
`TrainingQuestionAiDraft` row count returns to 8 (pre-release
baseline).

### 3.5 Video authorisation

The 4P synthetic reviewer (Option A — SUPER_ADMIN-on-Coulee-Ridge)
satisfies the video endpoint's admin path requirement
(`hr:training:read` on the version's club). No additional grants
needed; no public R2 URL exposed; HTTP Range + click-to-seek work
via the existing authenticated proxy.

### 3.6 Idempotency findings

- Fresh UUID on dialog open; preserved across retry of identical
  payload; regeneratable via visible "↻ regenerate" button.
- 4P tests pin: retry reuses key, regenerate mints new key,
  rapid double-click submits once. Server-side 4N
  `TrainingQuestionAiOperationKey` enforces the unique index.
- Reconciling an uncertain browser outcome = reload the review page
  → authoritative 4N reader states the truth.
- Minor UX gap (documented, not a blocker): no auto-regenerate when
  the reviewer changes the selected answer. First acceptance pass
  accepts this.

### 3.7 Historical candidate preservation plan

All 8 pre-4K candidates will have `groundingProjectionId = NULL`
after 4K applies (default). The 4M evidence reader classifies NULL
projection ID as `historical-unavailable`. The 4P eligibility
service classifies this as `HISTORICAL_EVIDENCE_UNAVAILABLE` and
disables the Approve button with explicit copy. **Zero backfill.**
Step 12 of the release plan validates this on every one of the 8
rows.

### 3.8 Proposed release commands

Summarised (full procedure in `PHASE-D-4Q-RELEASE-PLAN.md`):

```bash
# 1. Checkout candidate
git checkout ep-train-6d-4p/interactive-reviewer-ux  # b2180d53

# 2. Record rollback anchor
date -u +%Y-%m-%dT%H:%M:%SZ > scratchpad/ep-train-6d4q/release-timestamp.txt

# 3. Deploy (release_command auto-applies 4K migration)
flyctl deploy --app spectre-staging --config deploy/fly.web.toml --strategy immediate

# 4. Verify health + migration row + fixture round-trip (per Steps 5-12)
# 5. Capture screenshots (Steps 13-14)
# 6. Teardown fixture + identity (Step 15)
```

### 3.9 Operational risks

| Risk                                                       | Severity | Mitigation                                                                 |
| ---------------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| release_command fails mid-4K migration                     | Medium   | Prisma rolls back the single failed step; retry via re-deploy is safe (T4). |
| Fly image rollback mis-promised to reverse migration       | Low      | Documented clearly — the schema is backward-compatible; old image is safe on new schema. |
| Synthetic reviewer leaks approve capability to production clubs | Low | Option A scopes the membership to Coulee Ridge only. No global SUPER_ADMIN granted. |
| Fixture draft accidentally promoted to a real training obligation | Low | Approval → APPROVED_DRAFT, which does NOT create `TrainingObligation`. Publication is a separate slice. |
| Historical candidate becomes approve-eligible              | High     | Step 12 validates all 8 rows. Fail STOP triggers rollback.                 |
| Reviewer uploads a real-club video to the synthetic fixture course | Low | The fixture creates its own `TrainingCourse` + `Version`; existing videos are not touched. |
| CLUB_ADMIN gains approve capability                        | High     | Permission catalogue unchanged — a static scan + the Step 6 regression confirm. |

### 3.10 Residual-risk items (not blockers)

- The approval dialog has no "auto-regenerate idempotency key on
  answer change" behaviour (preflight §6.3). Acceptance tolerates
  this.
- The 4K migration cannot be hand-replayed via raw SQL. Documented
  in the release plan; not a defect in Prisma-driven deploys.
- Neon PITR is the ONLY first-class path to reverse the 4K
  migration. A manual reverse migration is noted as a fallback.

## 4. GO / NO-GO recommendation

### Recommendation: **CONDITIONAL GO**

Proceed with the DRH-1 release plan when the following preconditions
are met:

1. Founder authorisation for the specific commit `b2180d53` on
   `ep-train-6d-4p/interactive-reviewer-ux`.
2. Founder authorisation to create the Option A synthetic identity
   (per preflight §3.4) during the release window only.
3. Founder authorisation for the synthetic fixture (per preflight
   §4) — creation + teardown within the same window.
4. A **release window with at least 60 minutes of reserved
   attention** so Steps 1–15 can complete without a paused mid-
   release state.
5. Confirmation that no other merge is in flight for the
   `staging-deploy/web1b1-framer-fidelity` branch that would
   conflict with the 4K migration's state-machine assumptions.

Under those conditions the recommendation is GO because:

- The migration is proven additive + reversible-at-application-
  layer against a disposable PG16.
- The synthetic reviewer has the minimum grant needed; no RBAC
  catalogue change.
- The fixture exercises the real 4L→4M→4N→4P services, not direct
  DB writes.
- The video endpoint reuses the already-authenticated admin path;
  no new public surface.
- The idempotency contract has been exhaustively tested offline
  (40 vitest cases + 6 PG16 integration cases + 7 migration
  rehearsal cases).
- The rollback modes are clearly reversible (image revert) or
  clearly irreversible without PITR (migration reversal); the
  release plan does not conflate them.

### NO-GO triggers (do NOT proceed if any of these are true)

- The 4P commit has drifted (a new commit exists on
  `ep-train-6d-4p/interactive-reviewer-ux` since `b2180d53`).
- The staging migration state has drifted (someone applied 4K out
  of band since 2026-11-06).
- The Coulee Ridge draft count has changed from 8 (someone added
  or deleted a draft out of band).
- Any offline vitest suite under `tests/ep-train-6d4*` fails on a
  re-run.
- The Fly current image has drifted from v1095 /
  `sha-5e60fa59894f` (a release went out between preflight and
  execution).

If any NO-GO trigger fires, re-run this preflight before proceeding.

## 5. STOP compliance (directive §11)

| Boundary                                 | Status   |
| ---------------------------------------- | -------- |
| No staging deployment                    | HONOURED |
| No shared database migration             | HONOURED (disposable PG only) |
| No new role grants                       | HONOURED |
| No test-account creation                 | HONOURED (procedure documented, not executed) |
| No historical candidate backfill         | HONOURED |
| No Modal/Qwen inference                  | HONOURED |
| No transcription-worker activation       | HONOURED |
| No live approval or publication          | HONOURED |
| No global UI redesign                    | HONOURED |
| Preserve 126 unrelated WIP files         | HONOURED (stashed on entry, restored on exit) |

## 6. Awaiting founder authorisation

Next step is founder sign-off on the candidate commit + release
window. No code or configuration ships until that sign-off.
