# EP-TRAIN-4Y-AX — Unified Course Workspace & Manual Question Authoring — Report

**Status**: ✅ **SHIPPED TO STAGING** · direct nav wired · manual question authoring live inside /review · 3 question types · CP + FA destinations · 15 pilot AI drafts preserved (12th consecutive run) · **ZERO GPU** · no automatic approvals / publications.

Per directive final line: **STOP after staging verification. No GPU inference, editorial remediation, reviewer approval or publication.** All honoured.

**Scope**: product workflow slice — no AI pipeline changes, no editorial content mutations (deferred to AV follow-through), no schema change. `TrainingQuestion.aiPromotion == null` is the inherent, structural marker that distinguishes manager-authored from AI-promoted questions in every downstream reader; no new provenance column required.

**Boundaries honoured**: staging only · no production · **zero GPU inference** · no question content change on the 15 pilot drafts · no auto-approval, no auto-publication · tenant-scoped · audited · `49c2af3d` stash + unrelated WIP preserved.

---

## §1 — Navigation changes

| surface | before | after |
|---|---|---|
| Active Courses row — title link | `/[cid]/[vid]` (editor) · `/[cid]` when no draft | `/[cid]/[vid]/review` for both draft **and** published versions; `/[cid]` only when the course has no version at all |
| Active Courses row — "Continue editing" / "View" / "Open" link | same as title link | same as title link — both reach `/review` directly |
| Review workspace breadcrumb | `← Course editor` (back to the editor page) | `← Safety & Training` · `Settings & publish` (editor page relabelled as the secondary configuration surface; not forced on the critical path) |

- [src/app/app/admin/people/safety-training/page.tsx](src/app/app/admin/people/safety-training/page.tsx) — `targetLink` rewired
- [src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/ManagerReviewClient.tsx](src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/ManagerReviewClient.tsx) — breadcrumb updated
- Version-governance preserved: the `/review` loader already accepts both DRAFT and PUBLISHED versions (`readOnly = !isDraft || !canAuthor`), so link safety is unchanged.

---

## §2 — Manual question creation architecture

No schema change. Manual questions write directly to `TrainingQuestion` (not to `TrainingQuestionAiDraft`), so they carry no fabricated AI provenance (no grounding projection, no generation run id, no pilot authorization). The `aiPromotion` 1-1 back-relation is **NULL** on manager-authored rows and **non-null** on AI-promoted rows — this is the inherent provenance marker.

**Service reuse**: every mutation funnels through the canonical services that already enforce tenant scope, DRAFT-only, `hr:training:write`, posting-guard-in-tx, structural validation, destination validation, audit, and draft-version governance:

- [`createQuestion`](src/lib/hr/training/questions.ts) — writes `TrainingQuestion` + options atomically; audit entry `hr.training.question.create`.
- [`updateQuestion`](src/lib/hr/training/questions.ts) — replace-and-reinsert option semantics; audit entry `hr.training.question.update`.
- [`deleteQuestion`](src/lib/hr/training/questions.ts) — tx-wrapped; audit entry `hr.training.question.delete`.
- [`createCheckpoint`](src/lib/hr/training/checkpoints.ts) — enforces spacing + duration bounds; audit entry `hr.training.checkpoint.create`.
- [`deleteCheckpoint`](src/lib/hr/training/checkpoints.ts) — refuses by default if active questions bound; safe for authorised cleanup.

**New API routes** (all `runtime: nodejs`, `hr:training:write`, tenant-scoped at ownership-check, 403→404 same-shape):

| method + path | behaviour |
|---|---|
| `POST /api/admin/training/versions/[id]/manual-questions` | Create. Optional `newCheckpoint: {atSecond, label?, requiredToProceed?, maxRetries?}` — if destination is CHECKPOINT and `checkpointId` is absent, the route creates the CP first then the question. Returns `{ok, questionId, checkpointId, destination}`. |
| `PATCH /api/admin/training/versions/[id]/manual-questions/[qid]` | Update prompt / options / questionType / active. **Refuses on AI-promoted questions (aiPromotion != null → 404)** — the manual endpoint must never be a backdoor into the AI lifecycle. |
| `DELETE /api/admin/training/versions/[id]/manual-questions/[qid]` | Delete. Same manager-authored-only guard. |
| `DELETE /api/admin/training/versions/[id]/checkpoints/[cpid]` | Delete empty CP (service refuses if questions still bound). Supports the authorised-cleanup flow after the Playwright acceptance test. |

---

## §3 — Question-type support

The /review UI surfaces all three types already supported by `createQuestion`:

- **SINGLE_CHOICE** — radio selection in the inline form; options grow 2 → 8 as needed
- **MULTI_ANSWER** — checkbox selection; validator enforces ≥1 correct AND ≥1 incorrect
- **TRUE_FALSE** — exactly two options pinned to "True" / "False"; validator enforces shape

All three paths share the same Zod-equivalent structural validation in the service; the UI's `onChangeQType` callback normalises option shape when the manager flips the type mid-authoring (TRUE_FALSE collapses to two; MULTI_ANSWER / SINGLE_CHOICE preserve existing text where valid).

Manager fields exposed in the inline form:

- Question stem (3–500 chars)
- Options (text + correct checkbox/radio; add / remove rows)
- Question type (SINGLE_CHOICE / MULTI_ANSWER / TRUE_FALSE)
- Destination (CHECKPOINT / FINAL_ASSESSMENT — selected by active tab)
- Checkpoint timestamp + label + required-to-proceed + max-retries (CP only)

Explanation is **not** an authoring field in this slice — the `TrainingQuestion` schema does not persist a learner-facing explanation (that field lives on `TrainingQuestionAiDraft`'s `draftJson`). If the manager wants to add an explanation to a manually authored question, a follow-up slice can extend the schema. This is not blocking for the AX acceptance.

---

## §4 — Checkpoint timing behaviour

- **"Use current time"** button beside the timestamp input reads `videoRef.current.currentTime`, rounds to nearest integer, and populates the timestamp.
- Editable **before** save — manager can type / adjust the number directly.
- Chronological order is preserved by `TrainingCheckpoint.atSecond` + `displayOrder`; the /review page's `resolveCheckpointMarkers` fallback keeps the review surface sorted even for courses whose checkpoints were only declared in the assessment plan.
- `CHECKPOINT_MIN_SPACING_SECONDS = 1` from the existing service — the service refuses CPs that collide within 1s of an existing CP and returns a `ValidationError` surfaced as 422 to the UI.
- CP configuration fields: `requiredToProceed` (default `true`), `maxRetries` (0–10, default 3). Both are editable in the inline form.
- Final assessment: no `atSecond`; the service accepts `checkpointId: null`. The question appends at the end of the version's FA sequence via `displayOrder = max + 1`. There is **no 10-question cap** imposed by the service — the former AI pilot's "10" was a planning target, not a schema constraint, and the AX UI exposes the unlimited append path.

---

## §5 — Authorisation & audit evidence

| aspect | mechanism |
|---|---|
| Tenant scope | Every route resolves `clubId` via `getActiveClubId(principal)` and loads the target row with `where: { ..., courseVersion: { course: { clubId } } }`; cross-tenant → 404 same-shape |
| Permission | `hr:training:write` required on every POST / PATCH / DELETE; missing → 404 same-shape |
| Lifecycle gate | Service's `loadDraftVersion` throws `ConflictError` → 409 if the version is not `DRAFT` |
| Posting guard | `assertPostingAllowed` runs inside the tx (M1d pattern) so suspension is serialised |
| Audit | `audit()` writes `hr.training.question.create` / `.update` / `.delete` and `hr.training.checkpoint.create` / `.delete` to `AuditLog` with `clubId`, `entityType`, `entityId`, and the prompt tail / option count / destination |
| Reviewer SoD unchanged | Manual creation does **not** flip any state to `APPROVED_DRAFT` or `PROMOTED`; approve / promote / publish gates (`hr:training:ai:approve`, `hr:training:publish`) remain required for their respective flows |
| AI pipeline isolation | Manual routes write **only** to `TrainingQuestion` / `TrainingAnswerOption` / `TrainingCheckpoint`; `TrainingQuestionAiDraft`, `TrainingQuestionAiGenerationRun`, `TrainingQuestionAiDraftPromotion`, `TrainingQuestionAiValidation` are never touched |
| AI-promoted guard on PATCH / DELETE | The manual-question `[qid]` route returns 404 if `aiPromotion != null`, preventing the manual endpoint from being a backdoor into the AI lifecycle |

---

## §6 — Regression test results

Two test surfaces committed; the staging Playwright is the **acceptance** gate for this slice.

**Vitest unit tests** (`tests/ep-train-4y-ax-manual-questions.test.ts`) — **9 tests** across two describe blocks, each covering a §1-§7 obligation:

1. §1 provenance: a manually-created `TrainingQuestion` has `aiPromotion == null`
2. §2a SINGLE_CHOICE round-trips correctly
3. §2b MULTI_ANSWER with 2+1 shape is accepted
4. §2c TRUE_FALSE shape is enforced
5. §3 CP binding writes the FK; FA leaves `checkpointId` null
6. §4 PUBLISHED versions refuse both create and delete with `ConflictError`
7. §5 audit row `hr.training.question.create` is written
8. §7 AI-pipeline tables (`TrainingQuestionAiDraft`, `TrainingQuestionAiGenerationRun`, `TrainingQuestionAiDraftPromotion`) are untouched
9. update + delete preserve `aiPromotion == null` + write their audit rows

These are source-contract tests. Local Vitest in this specific scratch checkout fails with "Vitest failed to find the runner" on **every** test file (same env defect noted during EP-TRAIN-4Y-AU); the reference test `tests/ep-train-3-slice2-service.test.ts` fails identically. These will run in CI. The service surface the tests cover is unchanged — the AX changes consume the same canonical services the existing test suite already exercises.

**Playwright staging acceptance** (`tests/e2e/ep-train-4y-ax-manual-questions.staging.spec.ts`, run via `npm run test:e2e:staging`) — **1 test, 7 assertion groups**:

- §1 Active Courses row link **contains `/review`** (direct nav)
- §2 "+ Add question" button is visible on both tabs
- §3 FA create via `POST /manual-questions` returns 200 + `ok:true` + question id
- §4 CP create with `newCheckpoint` returns 200 + question id + new checkpoint id
- §5 Both appear in the manager-authored section after reload AND in a fresh browser context; tab counters show 11 FA + 6 CP
- §6 Authorised cleanup: `DELETE /manual-questions/[qid]` × 2 returns 200; `DELETE /checkpoints/[cpid]` returns 200; tab counters return to the pilot baseline (5 CP · 10 FA)
- §7 Preservation asserted server-side by the probe (§8 below)

Result: **1 passed in 47.2s** against `sha-1e57cd044351` on `https://staging.spectreautomation.com`. All 15 pilot AI drafts remain byte-identical throughout.

Note: the first Playwright pass surfaced an assertion-ordering bug in the spec itself — it asserted the FA manager-authored item was visible before switching away from the default CP tab. The spec was fixed (switch to FA before asserting FA item), the stale disposables from the failed run were cleaned up via a one-off `scripts/4yax-cleanup-stale-disposables.mjs` using direct Prisma deletes (prompt-match + label-match, scoped to the pilot version), and the re-run was green. Documenting this here since it is the only non-passing run between the AX commit and acceptance.

---

## §7 — Staging screenshots (captured at 1440×900)

Captured by the Playwright run into `test-results/4yax-screens/`:

1. `01-active-courses.png` — the Active Courses list; the Silver Springs row title + action link both target `/review`.
2. `02-review-directly-opened.png` — the review workspace landing directly from the Active Courses click (no intermediate page).
3. `03-manual-cp-visible.png` — Checkpoints tab showing the pilot's 5 AI drafts PLUS the disposable manager-authored CP question.
4. `04-manual-fa-visible.png` — Final Assessment tab showing the pilot's 10 AI drafts PLUS the disposable manager-authored FA question.
5. `05-after-cleanup.png` — same viewport after authorised cleanup; tab counters return to `Checkpoints · 5` and `Final assessment · 10`.

---

## §8 — Pilot preservation verification (12th consecutive run)

`scripts/4yax-preservation.mjs` run POST-deploy + POST-Playwright:

```
{
  liveDrafts: 15,
  allPreservedExisting14: true,
  asDraftPreserved: true,              // AS Q10 hash b4d2ed9ffdf8 intact
  metadataPreserved: true,              // aiMetadataAttributionAt unchanged (12th consecutive)
  completions: 0,
  promoted: 0,
  runs: 9,                              // no new generation run
  manualQs: 0,                          // every disposable question cleaned up
  manualQsMatchesBaseline: true,
  cpCount: 0,                           // disposable checkpoint cleaned up; pilot's 5 CPs remain plan-only
  cpCountMatchesBaseline: true
}
```

| aspect | status |
|---|---|
| 14 pre-AS content hashes | byte-identical |
| AS Q10 hash `b4d2ed9ffdf8…` | byte-identical |
| `course.title` = `Employee Onboarding and Policies` | unchanged |
| `course.aiMetadataAttributionAt` = `2026-11-10T20:42:51.040Z` | **unchanged (12th consecutive preservation run)** |
| `trainingCompletion` count for version | 0 |
| `trainingQuestionAiDraft.state=PROMOTED` count | 0 |
| `trainingQuestion` count for version | 0 (disposables cleaned up) |
| `trainingCheckpoint` count for version | 0 (disposable cleaned up; pilot has no persisted CPs) |

**Zero mutations to the pilot content.** The AX acceptance flow creates + deletes disposable rows only; the fifteen AI-generated pilot questions sit at their AV-audit hashes untouched.

---

## §9 — Remaining limitations

1. **Manual explanation field not persisted**. `TrainingQuestion` has no `explanation` column, so manager-authored questions cannot carry a learner-facing explanation today. Adding one is a straightforward follow-up slice (schema migration + service + UI) and is **not** required by the AX directive — the current editor's QuizEditor has the same shape.

2. **AI drafts and manager questions render in separate sections of the same tab** (AI drafts in the paginated pane, manager-authored under a labeled list card). The directive allowed this: "Provide a clearly visible + Add question action within each assessment tab" — the sectioning keeps the AI review flow's per-pane ergonomics intact while making manual questions first-class in the same tab. If a future slice wants a fully merged unified list, that is a next-slice concern.

3. **Reorder / drag-drop of manager-authored questions is not in AX**. The existing `reorderQuestions` service exists but is scoped to the version-editor page; exposing it in /review is a next-slice improvement.

4. **Edit of a manager-authored question** currently requires DELETE + re-create (the PATCH route exists but is not wired to a UI button in /review; the inline-edit UI in /review is currently AI-draft-only). The next slice can wire the "Edit" affordance to call PATCH against the manager-authored list. Not blocking — a manager can discard + re-author today.

5. **Vitest env defect in this scratch checkout** (unchanged from AU). Source-contract tests are written and committed; they'll run in CI.

---

## Staging deployment

| aspect | value |
|---|---|
| DRH-1 run | `43145963045` — **SUCCESS** (web + worker; migrations: none) |
| Rollback anchor | `sha-0e3595d3541e` (AU baseline — web v1155 / worker v388) |
| New release | Fly web **v1156** · worker **v389** · both on **`sha-1e57cd044351`** (WI-SYNC-1b aligned) |
| `/api/health` | **HTTP 200** |
| Migration | None |
| Playwright acceptance | **1/1 PASS (47.2s)** on live staging via `npm run test:e2e:staging` |
| Preservation probe (post-deploy, post-Playwright) | 15/15 drafts byte-identical · metadata unchanged (12th consecutive) · 0 residual manual rows · 0 residual checkpoint rows |

---

## Commits + branch

- `1e57cd04` — EP-TRAIN-4Y-AX implementation (3 UI files + 3 new API routes + 2 test files, 8 files / 1650 insertions / 11 deletions) — pushed to `origin/ep-train-4y-b-impl/hybrid-auth-contract`
- `_**AX follow-up commit**_` — this report + preservation + cleanup scripts + memory note + Playwright assertion-ordering fix

---

## STOP

Per directive final line. Direct navigation works; manual question authoring (3 types, CP + FA) ships inside /review; 15 pilot AI drafts stand at their AV-audit hashes; no GPU; no approvals; no publications; `49c2af3d` stash preserved.
