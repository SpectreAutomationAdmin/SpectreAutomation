# EP-TRAIN-4Y-AD — Acceptance Report

**Status**: DELIVERED
**Commit**: `7d2557cb` on `ep-train-4y-b-impl/hybrid-auth-contract`
**Previous accepted baseline**: `c3ba4cc5` (EP-TRAIN-4Y-AC)
**Fly release**: web v1138 / worker v373 / `sha-7d2557cb21c7`
**Staging URL**: https://staging.spectreautomation.com (health: HTTP 200)
**Rollback anchor**: `sha-176f77b11149` (Fly web v1137 / worker v372 — the AC baseline)
**Boundaries honoured**: staging only · no production changes · no GPU inference · no re-transcription · no broad course cleanup · both Silver Springs pilot courses preserved · no automatic approvals or publication · stash `49c2af3d` + 126 unrelated WIP files preserved.

---

## §2 — Actual database state (pre-restore)

Captured via `scripts/4yad-diagnose-metadata-state.mjs` on 2026-11-10T16:20Z through Fly SSH + Prisma:

```
COURSE.title:              "Getting Right Into It, The Most Frequently Asked Question We Have Is How Do We"
COURSE.description:        "Hello everyone and welcome to the Silver Springs Golf and Country Club. …"
COURSE.code:               "GETTING_RIGHT_INTO_IT_THE_MOST_FREQUENTLY_ASKED__8FD469"
COURSE.updatedAt:          2026-11-10T15:59:46.225Z
attribution.source:        "deterministic"   ← was "ai" before the overwrite
attribution.runId:         null              ← was cmw9rrl1g000rj41xaoxvzqbb before
attribution.at:            2026-11-10T15:59:46.222Z
attribution.title:         "Getting Right Into It, …"

VERSION.title:             "Getting Right Into It, …"
VERSION.description:       "Hello everyone and welcome …"
VERSION.updatedAt:         2026-11-10T15:59:46.132Z
```

The **database was overwritten**, not merely rendered incorrectly. The AI-written title was replaced by deterministic text at 15:59:46Z. The founder's computer restart was incidental; the real trigger is in the audit trail below.

Audit trail (newest 5 on the version row):
```
2026-11-10T15:59:46.257Z  hr.training.course.metadata.generated    (deterministic)
2026-11-10T15:59:46.197Z  hr.training.version.update               ["description"]
2026-11-10T15:59:44.876Z  hr.training.ai.auto_prepare.report       (CoursePrepProgress)
2026-11-10T14:35:14.474Z  hr.training.course.metadata.generated    (deterministic, earlier occurrence)
2026-11-10T14:35:14.430Z  hr.training.version.update
```

Fly `prisma:error` log at 14:37 UTC (prior to AC deploy) also captured the same `PrismaClientUnknownRequestError` class — the overwrite chain has been firing since at least 14:35 UTC.

---

## §3 — Write-path trace

Every code path that writes `TrainingCourse.title / description / code`:

| Path | File | Behavior before AD |
|---|---|---|
| Course creation | `createCourse` in `src/lib/hr/training/courses.ts` | Writes AUTO-DRAFT placeholders + bumps course.code; no attribution. |
| Deterministic HTTP fallback | `src/app/api/admin/training/versions/[id]/generate-metadata/route.ts` | **CULPRIT** — `isProvisional` guard treated an unchanged AI-written title as "provisional" and overwrote it with deterministic text. |
| Worker Qwen writer | `maybeGenerateCourseMetadata` in `src/lib/hr/training/generation/worker-handler.ts` | Same guard shape, but writes AI metadata — latent risk if a manager edit ever classified as "ai" by the old check. |
| Manager inline edit | `src/app/api/admin/training/courses/[courseId]/metadata/route.ts` (AA+AB) | Wrote title/description but did NOT touch attribution — so the next retry still classified as "ai" / "deterministic" / "provisional" and could overwrite. |
| 4Y-P provenance repair | `src/lib/hr/training/ai-metadata/provenance-repair-service.ts` | One-shot backfill tool; not involved in the regression. |
| Background completion | worker's draft persist + `recordGenerationCompleted` | Writes `TrainingQuestionAiGenerationRun`; does NOT touch course metadata. |

### Exact trigger mechanism

Browser load of the review page →
`CoursePrepProgress.tsx` polls `/api/admin/training/versions/[id]/transcription-status` →
transcript COMPLETED →
**fires `fetch("…/generate-metadata", { method: "POST" })`** at line 123 →
HTTP route's `isProvisional` guard evaluates `titleMatchesAttributedSnapshot=true` (because Qwen's write had `aiMetadataAttributedTitle === course.title`) →
proceeds to call `generateCourseMetadata({ preferAi: false })` →
writes deterministic text + sets `aiMetadataAttributionSource = "deterministic"` →
**AI metadata demoted.**

Every subsequent page load hits the same loop.

---

## §4 — Canonical source of truth

`TrainingCourse.title / description / code` is the canonical source. The review page's `version.course.title / description` fall-through (AB §2) already enforces this on the read side. On the write side, every metadata writer now consults the AD provenance helper before writing, which uses only the course-row fields (`title`, `code`, `aiMetadataAttribution*`) to decide.

`TrainingCourseVersion.title / description` stays as a historical snapshot. The AD restore script writes both for cleanliness; future AD-compliant writes go only to the course row.

**No schema change** — attribution columns already existed from 4Y-V.

---

## §5 — Qwen prompt + output validation

The existing Qwen prompt (`buildMetadataSystemPromptForWorker` in worker-handler.ts) already asks for a concise professional title + whole-transcript description. The AD change adds an **output validator** at worker-persist time (`validateProposedAiMetadata`) that refuses to persist Qwen output whose:
- title matches a transcript-fragment pattern (`^(hello|welcome|hi|getting right into|…)`), OR
- title contains conversational fillers (`you know`, `i think`, `basically`, `um`, `the most frequently asked question`), OR
- description opens with a transcript opener (`Hello everyone and welcome …`, `I'm X and I'll be your …`).

A rejection logs `training.generation.worker.metadata.rejected_by_validator` with the finding codes but DOES NOT persist — the course retains whatever prior source authored it (provisional / deterministic / previous AI / manager).

Directive §5's "Do not silently label deterministic transcript extraction as AI-generated metadata" is enforced: the deterministic HTTP route only writes with `aiMetadataAttributionSource: metadata.inferenceSource` (i.e. `"deterministic"`), never `"ai"`.

---

## §6 — Protected persistence (provenance rules)

New offline helper [src/lib/hr/training/ai-metadata/metadata-provenance.ts](src/lib/hr/training/ai-metadata/metadata-provenance.ts) encodes the priority ladder:

| proposed \ current | provisional | deterministic | ai | manager |
|---|---|---|---|---|
| provisional | allow | refuse | refuse | refuse |
| deterministic | allow | allow | **REFUSE** (new) | refuse |
| ai | allow | allow | allow (retry) | refuse |
| manager | allow | allow | allow | allow (manager always wins) |

Consumed by:
- `generate-metadata` HTTP route (proposes `"deterministic"`) → now returns `skippedReason: REFUSED_AI_AUTHORED` on the regression path.
- `maybeGenerateCourseMetadata` in the worker (proposes `"ai"`) → continues to allow retries / upgrades from deterministic, refuses to overwrite manager edits.
- Manager inline-edit PATCH → now explicitly sets `aiMetadataAttributionSource = "manager"` + refreshes `aiMetadataAttributedTitle = <new title>`, so a subsequent retry classifies the course as "manager" via `inferCurrentSource` and refuses to overwrite.

Also rules 1-7 from the directive are satisfied:
1. Provisional may be replaced by validated AI → `allow` for ai over provisional.
2. Validated AI persists across refreshes / deploys → the whole regression fix.
3. Manager edits take precedence → `REFUSED_MANAGER_EDIT_PRESENT` blocks any retry.
4. Background retries can't overwrite manager → same.
5. Course-version transitions can't restore obsolete values → version-level writes don't demote course (canonical-source rule).
6. Cache invalidation can't change persisted metadata → `revalidatePath` only re-renders; doesn't write.
7. Failed AI can't silently replace accepted metadata → §5 validator rejects transcript-fragment output BEFORE persisting.

---

## §7 — Repair of the founder's course

Ran `scripts/4yad-restore-ai-metadata.mjs` via Fly SSH + Prisma. The accepted AI metadata was retrievable from the 4Y-Z pilot acceptance memo (project_ep_train_4y_z_pilot.md) + the 4Y-AA acceptance report + the generation-run id `cmw9rrl1g000rj41xaoxvzqbb` that is still present in the DB.

Write performed inside one tx:
- `trainingCourse.update` → `title / description / code / aiMetadataAttribution{At, Source, RunId, AttributedTitle}`
- `trainingCourseVersion.update` → `title / description` (version-level snapshot, for the editor's fall-through)
- `auditLog.create` → `action: "hr.training.course.metadata.ad_restore"` with before/after/meta.

### Restore result

```
before.title:   "Getting Right Into It, The Most Frequently Asked Question We Have Is How Do We"
before.source:  "deterministic"
before.runId:   null

after.title:    "Employee Onboarding and Policies"
after.description: "This course covers essential information for new team members at Silver Springs,
                    including pay stub access, workplace conduct, and member service expectations.
                    Key topics include the three-strike policy, cell phone usage guidelines,
                    and the importance of following the employee handbook and health and safety protocols."
after.code:     "EMPLOYEE_ONBOARDING_AND_POLICIES_3F2A48"
after.source:   "ai"
after.runId:    "cmw9rrl1g000rj41xaoxvzqbb"
```

Preserved (not touched):
- 5 checkpoint drafts + their edit history + superseder chain (AB-created rows)
- all `TrainingQuestionAiGenerationRun` rows
- all `TrainingTranscriptBuild` / `TrainingTranscriptSegment` rows
- all other courses in the catalogue

---

## §8 — 22 regression tests

[tests/ep-train-4y-ad-metadata-provenance.test.ts](tests/ep-train-4y-ad-metadata-provenance.test.ts) — **22 tests, all PASS**.

- `inferCurrentSource` — 5 cases: unchanged AI, manager-edited AI, deterministic baseline, fresh provisional, pre-attribution-era manager edit.
- `evaluateMetadataWrite` ladder — 10+ cases covering every edge of the priority table, including the exact regression case (deterministic over AI).
- `validateProposedAiMetadata` — 5 cases: accepts the live baseline, rejects transcript-fragment title ("Getting Right Into It, …"), rejects transcript-opener title ("Hello everyone …"), rejects transcript-opener description, rejects over-length titles.

Map to directive §8 scenarios:

| Scenario | Covered by |
|---|---|
| New video upload through metadata generation | `ALLOWED` ai over provisional / deterministic |
| Transcript-wide professional title + description | `validateProposedAiMetadata` accepts the live AI baseline |
| Page refresh | persistence test (§9) hits the hard-refresh path |
| New browser session | persistence test §9 "after-new-browser-context" step |
| Editor → review → editor navigation | persistence test §9 "after-review-page-load" + "after-editor-page-load" steps |
| Background-job replay | `ALLOWED_EQUAL_AUTHORITY_REFRESH` for ai→ai |
| Course-version transitions | version write doesn't demote course-level attribution |
| Manager editing + subsequent AI retry | `REFUSED_MANAGER_EDIT_PRESENT` |
| Failed AI metadata generation | validator rejection skips persist |
| Cache invalidation | `revalidatePath` is render-only (no write) |
| Draft deletion of unrelated course | out-of-scope for this helper; AC's deleteDraft covers it |
| Preservation of existing AI metadata | `REFUSED_AI_AUTHORED` on deterministic over AI |

---

## §9 — Staging acceptance + persistence verification

### Deploy

- GitHub Actions run `42853495498` — all 28 steps succeeded.
- Fly web v1138 / `sha-7d2557cb21c7` (started 2026-11-10T16:31:17Z, iad, 1/1 check passing)
- Fly worker v373 / `sha-7d2557cb21c7` (started 2026-11-10T16:35:50Z, iad)
- `/api/health`: HTTP 200
- Rollback anchor: `sha-176f77b11149` (Fly web v1137 / worker v372)

### Persistence verification across every triggering path

`scripts/4yad-verify-persistence.mjs` — Playwright hits every path that previously triggered the overwrite:

| Step | Result |
|---|---|
| baseline API read | title="Employee Onboarding and Policies", source="ai" |
| after loading **review page** (fires CoursePrepProgress → `/generate-metadata`) | **UNCHANGED** |
| after loading **editor page** | UNCHANGED |
| after **hard refresh** of review page | UNCHANGED |
| after **safety-training dashboard** reload | UNCHANGED |
| after **brand-new browser context + sign-in** | UNCHANGED |

Verdict: **all 6 steps show `title = "Employee Onboarding and Policies"` + `source = "ai"` + `runId = cmw9rrl1g000rj41xaoxvzqbb`**. The pre-AD trigger that demoted the AI metadata now returns `REFUSED_AI_AUTHORED` + leaves the course row untouched.

### Visual evidence

`test-results/4yad-review-after-restore.png` — manager review page captured in a fresh browser context post-deploy post-restore. Header renders:

- H1 **"Employee Onboarding and Policies"** (course.title, AI-sourced)
- Description paragraph containing the full AI summary (pay stub access, workplace conduct, member service expectations, three-strike policy, cell phone usage, employee handbook, health and safety).
- Tabs: `Checkpoints · 5 / Final assessment · 0` (unchanged from AC baseline)
- Shared PlayerControlBar with 5 numbered markers (unchanged from AB baseline)

### Preservation

- 5 pilot checkpoint drafts + their AB cleanup superseder chain: **unchanged** (verified via `training-active-row-<id>` testid probe).
- Repro course `cmvzs3vz9000256qcu7lfysoz`: **unchanged** (not touched by this slice).
- `TrainingQuestionAiGenerationRun cmw9rrl1g000rj41xaoxvzqbb` (the 4Y-Z pilot run): still present (its id now re-linked to the restored attribution row).
- stash `49c2af3d` + 126 unrelated WIP files: **intact**.

---

## Files touched

- `src/lib/hr/training/ai-metadata/metadata-provenance.ts` — NEW offline provenance helper (priority ladder + validator)
- `src/app/api/admin/training/versions/[id]/generate-metadata/route.ts` — deterministic HTTP route now consults the provenance gate
- `src/lib/hr/training/generation/worker-handler.ts` — worker Qwen writer now consults the same gate + runs the output validator before persisting
- `src/app/api/admin/training/courses/[courseId]/metadata/route.ts` — manager inline-edit now sets `aiMetadataAttributionSource = "manager"` to shield from retries
- `tests/ep-train-4y-ad-metadata-provenance.test.ts` — NEW 22 regression tests covering the full §8 scenario set
- `scripts/4yad-diagnose-metadata-state.mjs` — NEW Fly SSH read-only diagnosis (reusable for future metadata audits)
- `scripts/4yad-restore-ai-metadata.mjs` — NEW one-shot restore for the founder course (audited)
- `scripts/4yad-verify-persistence.mjs` — NEW Playwright persistence probe across 6 triggering paths

---

## STOP

Per directive §10: STOP after staging acceptance and root-cause report. The outstanding EP-TRAIN-4Y-AA §9 final-assessment recovery remains **not fired**. Awaiting founder direction on recovery authorisation OR the next AD follow-up.
