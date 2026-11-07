# EP-TRAIN-6D-4Z-E — Reviewer Staging Acceptance

**Status:** Staging evidence complete. **No production. No live Modal.
No publication. No employee assignments. 126 WIP files preserved.**

## 1. Baseline

See [PHASE-D-4Z-E-DEPLOYMENT.md](./PHASE-D-4Z-E-DEPLOYMENT.md).

- Staging web: Fly **v1098** image `sha-e7fbb0b158cd`
- Staging worker: Fly **v334** image `sha-e7fbb0b158cd`
- `/api/health` throughout: 200
- Role registered via `scripts/sync-rbac.ts` release_command
  (automatic, no manual SQL).

## 2. Synthetic test identity

- Email: `4ze-syn-reviewer-<ts>@example.test`
- Password: fixture-only 32-byte random hex (printed by the seed
  script; NEVER checked in).
- `UserClubRole` grant: **only** `TRAINING_AI_REVIEWER` at Coulee
  Ridge (`cmrvdeny7000144372ktmmg9c`).
- Legacy `User.role` scalar: `STAFF` (fallback that would NOT grant
  admin if the UserClubRole were missing).
- **Time-boxed.** Removed by the cleanup script immediately after
  this acceptance.

## 3. Synthetic fixture

- 1 DRAFT `TrainingCourseVersion` (prefix `4ZE-SYN-`).
- Transcript build + 6 segments + canonical grounding projection
  (envelope hash matches 4M reader recompute).
- COMPLETED generation run (fixture-only — NO Modal call).
- 1 checkpoint @ 115 s.
- **1 draft in `REQUIRES_HUMAN_REVIEW`** — **NOT APPROVED_DRAFT**
  (per §6 — the reviewer must drive the real approval transition).
- 1 `TrainingQuestionAiValidation` row with verdict `GROUNDED` and
  **no verified-answer snapshot** (the reviewer must attest to the
  correct answer at approval time); `validatorSource = "integrated-pipeline"`
  so the 4N approval-guard authorisation check passes.

## 4. §6 acceptance checklist — 16 scenarios

Playwright file: [tests/e2e/ep-train-6d4ze-reviewer-acceptance.staging.spec.ts](../../../tests/e2e/ep-train-6d4ze-reviewer-acceptance.staging.spec.ts)
— **5/5 specs PASSED (42.5 s)** on staging.

| # | Scenario                                                                    | Result |
|---|------------------------------------------------------------------------------|--------|
| 1 | Reviewer login (synthetic, NOT founder)                                      | ✅     |
| 2 | AI review queue access (reviewer carries `hr:training:ai:read`)              | ✅     |
| 3 | Evidence visibility (source material card + transcript segments rendered)    | ✅     |
| 4 | Approval-dialog availability (`approve-candidate-button` visible + enabled)  | ✅     |
| 5 | Independent verified-answer selection (reviewer picked option A — no preselection) | ✅ |
| 6 | Required reviewer attestation (checkbox checked before Submit)               | ✅     |
| 7 | Successful approval transaction                                              | ✅ `REQUIRES_HUMAN_REVIEW → APPROVED_DRAFT` (`recordVersion` 1 → 2) |
| 8 | Correct reviewer attribution (`reviewedByUserId = synthetic reviewer.id`)    | ✅ verified via parameterised DB read: `ATTRIBUTION_IS_REVIEWER=true`, `ATTRIBUTION_IS_NOT_FOUNDER=true` |
| 9 | Verified-answer snapshot integrity                                           | ✅ snapshot shape: `{optionIndex: 0, optionText, verifiedByUserId=reviewer.id, verifiedAt, draftContentHash, validationId}` — all bindings match |
| 10| CLUB_ADMIN-only approval refusal (founder sees queue; Approve disabled)      | ✅     |
| 11| STAFF approval refusal                                                       | ✅ covered by 4Z-D static unit test `STAFF cannot approve` |
| 12| Cross-tenant denial                                                          | ✅ covered by 4Z-D static unit test `cross-tenant isolation` |
| 13| Reviewer promotion refusal                                                   | ✅ Promote button disabled or absent; reviewer lacks `hr:training:write` |
| 14| Reviewer publication refusal                                                 | ✅ reviewer lacks `hr:training:publish` — publish panel inaccessible |
| 15| Reviewer employee-assignment refusal                                         | ✅ reviewer lacks `hr:training:assign` — assignment UI inaccessible |
| 16| Reviewer role-management refusal (settings/users)                            | ✅ reviewer redirected / forbidden at `/app/admin/settings/users` |

## 5. §7 Visual evidence

9 screenshots captured to
[test-results/ep-train-6d4z-e/screenshots/](../../../test-results/ep-train-6d4z-e/screenshots/):

| # | Surface                                                     | File                                                         |
|---|-------------------------------------------------------------|--------------------------------------------------------------|
| 01| Reviewer queue (desktop + mobile)                           | `01-queue--desktop-1440x900.png` + `01-queue--mobile-390x844.png` |
| 02| Source evidence + approve CTA                               | `02-evidence-and-approve--desktop-1440x900.png` + mobile     |
| 03| Approval dialog (independent-selection + attestation)       | `03-approval-dialog--desktop-1440x900.png`                   |
| 04| Post-approval state (workflow trail shows APPROVED_DRAFT)   | `04-post-approval--desktop-1440x900.png`                     |
| 05| Reviewer denied at `/app/admin/settings/users`              | `05-reviewer-denied-settings--desktop-1440x900.png`          |
| 06| Reviewer workspace — promote/publish controls not clickable | `06-reviewer-workspace--desktop-1440x900.png`                |
| 07| CLUB_ADMIN approve disabled                                 | `07-club-admin-approve-disabled--desktop-1440x900.png`       |

## 6. §8 Cleanup + audit

Cleanup script (`scripts/ep-train-6d4ze-reviewer-cleanup.mjs`) ran
post-acceptance:

```
courses=1, versions=1, drafts=1, runs=1, transcriptionJobs=1,
checkpoints=1, segments=6, builds=1, projections=1,
userClubRoles=1, syntheticReviewers=1
RESIDUE_CHECK: clean (0 synthetic courses, 0 reviewers, 0 UCR)
```

- Synthetic reviewer user removed.
- Synthetic UserClubRole grant removed.
- All synthetic training rows removed.
- **Historical candidates (8 pilot-era)**: UNCHANGED (0 touched by
  this slice).
- **Founder's account**: UNCHANGED. No role grant added, no
  permission modified.
- **TRAINING_AI_REVIEWER Role row + 3 RolePermission rows**: remain
  on the DB (the role is now permanently registered as part of
  the code catalogue; the next sync-rbac.ts run will keep them
  idempotent).

## 7. STOP boundaries (§10) — all confirmed

| STOP                                 | Confirmed |
|--------------------------------------|-----------|
| No production deploy                 | ✅        |
| No live Modal/Qwen/Whisper           | ✅        |
| No GPU activation                    | ✅        |
| No publication                       | ✅        |
| No employee assignments              | ✅        |
| No historical candidate modification | ✅        |
| No permanent synthetic role grants   | ✅ (synthetic reviewer removed; the Role row itself is permanent per §3 design — it is the catalogue registration, NOT a user grant) |
| No unrelated UI redesign             | ✅        |
| 126 unrelated WIP files preserved    | ✅ (stashed on entry, restored on exit) |

## 8. Next-step recommendation

The reviewer authorization surface is **production-ready** pending
only a production deploy decision (explicitly out of scope). The
natural next slices (each requires founder authorization):

### 4Z-F — Full-pipeline acceptance via two authenticated sessions

Scope: a reviewer approves a candidate; a CLUB_ADMIN then promotes
the resulting APPROVED_DRAFT via the 4Y workspace; the manager
publishes the version. Covers the complete end-to-end flow driven
by TWO distinct authenticated sessions (reviewer + admin).

### 4Z-G — Role-grant UI founder verification

Scope: founder logs into the Tenant Administrator UI
(`/app/admin/settings/users`), observes that "AI Training Reviewer"
appears in the role picker, grants it to a real club reviewer user
(not a fixture), and the grantee's next authenticated request
reflects the grant. Captures the full founder-driven grant journey
as evidence.

### 4Y-A — Live Modal activation on staging

Scope: wire `MODAL_TRANSCRIBE_URL` + `MODAL_GENERATE_URL` + HMAC
secrets; a reviewer approves a candidate generated from a real
short video (not a synthetic fixture). Previously documented in
PHASE-D-4Z-C-PROMOTION-ACCEPTANCE §8.

## 9. Awaiting

Founder visual review of the 9 screenshots + attribution evidence +
cleanup confirmation. Any next slice requires separate
authorization.
