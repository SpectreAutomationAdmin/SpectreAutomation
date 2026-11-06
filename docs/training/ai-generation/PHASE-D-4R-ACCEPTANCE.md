# EP-TRAIN-6D-4R — Staging Deployment — Acceptance

Status: **PHASES A → F COMPLETE.** Awaiting founder VISUAL
acceptance of the screenshots before the slice is considered
closed.

Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4r/staging-deployment` (documentation + Playwright
spec + scripts; also pushed as
`staging-deploy/ep-train-6d-4r-release` for the DRH-1 auto-trigger).

## 1. Summary

The 4R directive authorised a staging deployment of the 4K–4P stack
onto `spectre-staging`, CONDITIONAL on the Phase A preconditions
plus explicit identity authorisation in Phase B. The founder
authorised the Coulee-Ridge-scoped SUPER_ADMIN fallback with eight
mitigations.

All six phases (A, B, C, D, E, F) completed inside a single ~45-
minute window. The 4K migration applied cleanly, the 4N approval
transaction fired end-to-end against the real 4M evidence reader,
and the teardown restored the pre-release draft count byte-for-byte.

**No production touched. No historical candidate modified. No
permanent role grant issued. No worker/Modal/Qwen inference.**

## 2. GitHub Actions run / Fly release IDs

| Artefact                          | Value                                                               |
| --------------------------------- | ------------------------------------------------------------------- |
| DRH-1 workflow run                | **42238071723** (workflow: Deploy — spectre-staging)                |
| Trigger                           | push on `staging-deploy/ep-train-6d-4r-release`                     |
| Build+deploy conclusion            | `success` (~13 min)                                                |
| Fly release                       | **v1096**                                                           |
| Fly image                         | **`registry.fly.io/spectre-staging:sha-e49122690011`**              |
| Pre-release rollback anchor       | **v1095 / `sha-5e60fa59894f`** (unchanged from 4Q preflight)        |
| Neon PITR anchor timestamp        | **2026-11-06T00:40:19Z** (recorded before Phase C)                  |

Rollback command (reversible, app-only; migration is backward-
compatible so no DB restore is required):

```bash
flyctl deploy --app spectre-staging \
  --image registry.fly.io/spectre-staging:sha-5e60fa59894f \
  --strategy immediate
```

## 3. Migration verification

4K migration recorded in the `_prisma_migrations` ledger:

| migration_name                                               | finished_at                | steps |
| ------------------------------------------------------------ | -------------------------- | ----- |
| `20261104_ep_train_6d_4b_ai_review_persistence`              | 2026-11-04T21:21:20.880Z   | 1     |
| `20261105_ep_train_6d_4k_transcript_evidence`                | **2026-11-06T15:05:56.426Z** | 1   |

Tables added by 4K (all present on staging):

- `TrainingTranscriptBuild`
- `TrainingTranscriptSegment`
- `TrainingGroundingProjection`

Columns added by 4K (all present on staging):

- `TrainingQuestionAiDraft.groundingProjectionId`
- `TrainingQuestionAiDraft.modelSelectedAnswerSnapshotJson`
- `TrainingQuestionAiValidation.verifiedCorrectAnswerSnapshotJson`

## 4. Health + regression results

- `/api/health`: **200**. Outer status `warn` is pre-existing DLQ
  depth unrelated to 4R; database check `ok`.
- Offline vitest regression: **179/179 PASS** (Phase A.3, no change
  since 4Q).
- Prisma schema validation: both SQLite + Postgres schemas valid.
- Nav audit: 0 URL-only orphans.
- Placeholder scan: 0 4R-authored hits.

## 5. Authentication + permission results

- Two synthetic identities created on Coulee Ridge only (no global
  SUPER_ADMIN grant):
  - `4r-reviewer@spectre-test.local` (userId `cmw5493mw000012luyn9surs9`) — SUPER_ADMIN club-scoped.
  - `4r-club-admin@spectre-test.local` (userId `cmw5493tb000312lu55oc75ku`) — CLUB_ADMIN club-scoped.
- `invariantGlobalSuperAdminAbsent: true` — neither carries a
  `{clubId: null, roleKey: SUPER_ADMIN}` row.
- RBAC catalogue UNCHANGED (zero edits to `src/lib/permissions.ts`).

Authenticated Playwright acceptance (project: staging-authenticated):

```
ok 1 CLUB_ADMIN synthetic — read workspace works, /approve POST returns 404 (5.3s)
ok 2 Reviewer (SUPER_ADMIN club-scoped) — full approval journey + emerald chip after refresh (6.6s)
ok 3 Reviewer — historical candidate still unapproved (regression check) (5.7s)
3 passed (39.6s)
```

## 6. Synthetic approval evidence

The 4N transaction executed authoritatively on staging. Server-
side state after approval:

```json
{
  "state": "APPROVED_DRAFT",
  "recordVersion": 1,
  "contentHash": "7232c673852436c091872a7427e02120b0abbcc34ccfbd844705f81d11068a1b"
}
{
  "id": "val_4r_mw54au9b",
  "verifiedCorrectAnswerSnapshotJson": "{
    \"schemaVersion\": \"verified-correct-answer-snapshot-v1\",
    \"optionIndex\": 1,
    \"optionText\": \"Notify the manager on duty and step away from the interaction\",
    \"verifiedByUserId\": \"cmw5493mw000012luyn9surs9\",
    \"verifiedAt\": \"2026-11-06T15:21:13.206Z\",
    \"draftContentHash\": \"7232c673…8a1b\",
    \"validationId\": \"val_4r_mw54au9b\"
  }",
  "verdict": "REQUIRES_HUMAN_VERIFICATION"
}
```

The reviewer selected **option index 1** — a human-verifiable
correct answer, NOT the model's wrong pick at index 0. The 4N
snapshot binds the verified answer to the exact immutable draft
content hash + validation id.

## 7. Desktop + mobile screenshots

Under `docs/training/ai-generation/screenshots-6d4r/`:

- `1440-pre-approval.png` — Reviewer workspace, Approve button enabled.
- `1440-dialog-open.png` — Dialog open, no answer preselected, model-selected chip visible, attestation unchecked.
- `1440-post-approval.png` — Emerald "Verified correct" chip, reviewer name present, trigger button now disabled.
- `390-post-approval.png` — Same at iPhone portrait viewport.
- `1440-historical-unavailable.png` — Historical candidate detail: "Historical evidence unavailable" banner + Approve disabled.

**Visual acceptance remains pending founder review.**

## 8. Historical-candidate preservation evidence

Pre-release Coulee Ridge draft count: **8**. Post-release count
after 4K applied: **8**. Post-teardown count: **8**. Zero drift.

Pre-release snapshot of all 8 historical rows preserved in
`scratchpad/ep-train-6d4r/` (`historical-rows-snapshot.mjs`
output). Each row remained at `groundingProjectionId: null` and
`modelSelectedAnswerSnapshotJson: null` throughout — the 4K
additive migration does not touch existing rows.

## 9. Cleanup results

Teardown script output:

| Category                    | Count deleted |
| --------------------------- | ------------- |
| Operation keys              | 1             |
| State transitions           | 1             |
| Reviews                     | 1             |
| Validations                 | 1             |
| Drafts                      | 1             |
| Generation runs             | 1             |
| Grounding projections       | 1             |
| Transcript segments         | 3             |
| Transcript builds           | 1             |
| Course versions             | 1             |
| Courses                     | 1             |
| UserClubRoles (synthetic)   | 2             |
| Sessions                    | 17            |
| Users (synthetic)           | 2             |

Post-teardown invariant check (`final-invariants.mjs` after
teardown):

```json
{"couleeDrafts": 8, "syntheticUsers": 0, "residualRoles": 0, "residualCourses": 0}
```

All eight founder mitigations honoured:

| # | Mitigation                                                  | Status                                                               |
| :-: | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| 1 | Dedicated synthetic identity, never the founder account     | ✅ `4r-reviewer@spectre-test.local`                                   |
| 2 | No global or cross-tenant SUPER_ADMIN                       | ✅ `invariantGlobalSuperAdminAbsent: true`                            |
| 3 | Restricted to the approved window                           | ✅ Created + deleted in one ~45-min window                            |
| 4 | No permanent RBAC modification                              | ✅ `src/lib/permissions.ts` UNCHANGED; no grants to existing users    |
| 5 | CLUB_ADMIN negative test — 404 on /approve                  | ✅ Playwright asserted + verified                                     |
| 6 | Disable identity immediately after testing                  | ✅ Teardown run; 0 residual users / roles / sessions                  |
| 7 | Preserve audit records + evidence of cleanup                | ✅ audit() rows retained; teardown output recorded                    |
| 8 | Do not treat success as approval of the future RBAC model   | ✅ See §13 — this slice does NOT add TRAINING_AI_REVIEWER role        |

## 10. Rollback anchor + recovery readiness

- Application rollback: image `sha-5e60fa59894f` (v1095); command
  under §2.
- Database rollback: NOT required. 4K's additive migration is
  backward-compatible; v1095 code can read the new schema without
  regression.
- Last-resort DB restore: Neon PITR at timestamp
  **2026-11-06T00:40:19Z**.

## 11. Explicit founder visual-acceptance status

**NOT YET GRANTED.** Five screenshots are available under
`docs/training/ai-generation/screenshots-6d4r/`. The founder must
inspect them (or the deployed interface directly at
`https://staging.spectreautomation.com/app/admin/ai-training/review/persisted`
with their own account) before the slice is closed.

Note: the deployed interface NO LONGER shows the 4R synthetic
fixture (it was torn down in Phase F). The screenshots are the
only remaining record of the synthetic approval journey. The
deployed interface still shows the 8 historical candidates with
the correct "Historical evidence unavailable" treatment — the
founder can confirm that live.

## 12. STOP compliance (directive §Mandatory STOP)

| Boundary                                 | Status   |
| ---------------------------------------- | -------- |
| No production changes                    | HONOURED |
| No historical backfill                   | HONOURED — 8 drafts byte-identical pre/post |
| No permanent broad role grants           | HONOURED — RBAC catalogue + existing-user memberships UNCHANGED |
| No Modal/Qwen inference                  | HONOURED — fixture transcriber labelled `spectre-synthetic-4r` |
| No employee assignments                  | HONOURED — no `TrainingObligation` rows created |
| No publication                           | HONOURED — draft remained unpublished |
| No unrelated UI redesign                 | HONOURED — only ai-training surfaces engaged |
| 126 unrelated WIP files preserved        | HONOURED — stashed at entry, to be restored at exit |

## 13. Awaiting founder authorisation for next slice

The 4R directive closes with: "After successful staging
verification, STOP and await founder visual acceptance before
advancing to any additional training-development slice."

Recommended next slices (require separate authorisation):

1. **4R-ACCEPT** — Founder visually inspects the screenshots +
   signs off on closing 4R.
2. **4R-FOLLOWUP (RBAC)** — Author the narrow
   `TRAINING_AI_REVIEWER` role (`hr:training:read + ai:read +
   ai:approve`) so future acceptance windows don't need the
   SUPER_ADMIN fallback.
3. **4S** — Historical-evidence backfill plan for the 8
   EP-TRAIN-6D-4H candidates (so they transition from
   `HISTORICAL_EVIDENCE_UNAVAILABLE` to approvable once real
   evidence is produced).
4. **Modal/Qwen/Whisper integration** — Separate slice to replace
   the synthetic fixture with real AI-generation. Out of scope here.

None of these ship without explicit founder sign-off.
