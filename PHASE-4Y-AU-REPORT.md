# EP-TRAIN-4Y-AU — Founder Browser Parity & Destination Resolution — Report

**Status**: ✅ **FIXED AND PROVEN IN THE ACTUAL BROWSER** · `Checkpoints · 5` restored · Q7 of 10 no longer displays "destination unknown" · 15/15 drafts byte-identical · ZERO GPU · 10th consecutive preservation run.

Per directive final line: **STOP after staging verification. Do not claim acceptance if the visible defect remains.** The visible defect is GONE — proven by direct DOM inspection, not a passing regex over an unloaded page.

**Boundaries honoured**: staging only · no production · **ZERO GPU inference** · no question content change · no auto-approval, no auto-publication · tenant-scoped · audited.

---

## §8 — 10-item report

### 1. Reproduction result

Pre-AU reproduction at 1440×900 against live staging (`scripts/4yau-reproduce-founder-view.mjs`) confirmed the founder's screenshot exactly:

```
Checkpoints · 6                             ← defect (should be 5)
Final assessment · 10
Question 7 of 10· destination unknown       ← defect
Needs review
How can employees access their pay stubs?
A.By using the last four digits of their SIN number✓ Correct answer
B.By calling the HR department
C.By logging into the company's online portal
D.By visiting the physical HR office
```

The AT regex-over-initial-render test had passed because it scanned the body BEFORE navigating to Q7 (Q1 was displayed), and Q1 has a normal destination. The real defect only surfaces after you walk forward to Q7. The AT acceptance was a false positive — this report documents how.

### 2. Destination value at every data-flow stage

| stage | value | status |
|---|---|---|
| **DB** `TrainingQuestionAiDraft.generationRunId` | `cmwbij5rq0007mmqsxow0h9jv` (AR run) | correct |
| **DB** `TrainingQuestionAiDraft.contentHash` | `b4d2ed9ffdf8…` | correct |
| **DB** `shortfallReasonJson.perGroupDiagnostics[0].group` on AR run | `"fa-1"` | correct |
| **DB** `shortfallReasonJson.perGroupDiagnostics[0].recoveryHistory[0]` | `{contentHash: b4d2…, savedAsDraftId: cmwbl6aic…, …}` | correct |
| **page.tsx** `allCompletedRuns` query filter | `executionStatus: "COMPLETED"` | **BUG — excluded AR (FAILED)** |
| **page.tsx** `runsForResolver` | `[originalRun]` — AR absent | **BUG** |
| **destination-resolver** `composedGroupMap.get(ASHash)` | `undefined` | consequence |
| **destination-resolver** `destinationKindForGroup(null)` | `"UNKNOWN"` | consequence |
| **page.tsx** draft `destination` prop | `"UNKNOWN"` | consequence |
| **ManagerReviewClient** filters | UNKNOWN drafts render in BOTH `CHECKPOINT`+`UNKNOWN` AND `FINAL_ASSESSMENT`+`UNKNOWN` filters | consequence |
| **rendered UI** Q7 header | `"Question 7 of 10· destination unknown"` | consequence |
| **rendered UI** CP tab label | `"Checkpoints · 6"` (5 real + 1 leaked UNKNOWN) | consequence |

**Stage where FINAL_ASSESSMENT becomes UNKNOWN**: `src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/page.tsx:120` — the `where: { executionStatus: "COMPLETED" }` filter. The AT resolver fix was correct AT THE RESOLVER LAYER; the loader just never passed AR's shortfallReasonJson to it.

### 3. Exact root cause

The AR→AS lifecycle lands a **successful** manager-recovered draft INSIDE the `shortfallReasonJson.perGroupDiagnostics[g].recoveryHistory[]` of a run whose terminal state is `FAILED` (the GPU call was rejected; the manager then corrected offline). The review page loader queried only `COMPLETED` runs for the resolver, so AR's data was invisible to it. The resolver fix shipped in AT was correct but couldn't fire against data the loader never handed it.

This is a classic "the check is in place, but the input is wrong" defect. Not a resolver bug; a loader bug.

### 4. Cache/deployment findings

Verified pre-AU:
- Fly web was on `sha-2768265c7814` (AT image).
- Fly worker was on `sha-2768265c7814` (AT image).
- The AT resolver code WAS in the deployed JS bundle (verified by curl of the login page headers + `/_next/static/chunks/*` paths differing from pre-AT).
- No CDN / service-worker / browser-cache artefact was involved — the defect reproduced in a fresh Playwright chromium context with cache disabled.

So the deployment and caching layers were healthy. The defect was in the server-side loader query, which the AT shipment had not changed.

### 5. Checkpoint-count reconciliation

| source | count | reason |
|---|---|---|
| canonical DB (checkpoint-destination drafts) | **5** | 5 original CG drafts (hashes `24c26223e6d1 5d2863681508 e05878acffc1 084e91e008d1 fcf533481947`) |
| server response (via review API) | 5 | the server computes `destination` per draft before serialising |
| client tab count pre-AU | 6 | client filter `destination === "CHECKPOINT" OR destination === "UNKNOWN"` picks up the AS draft (UNKNOWN) in BOTH tabs |
| client tab count post-AU | **5** | AS draft now resolves to FINAL_ASSESSMENT → filter excludes it from CP |

**No sixth canonical checkpoint exists.** No draft was duplicated, incorrectly promoted, or renamed. The "6" was a presentation artefact of UNKNOWN drafts falling into both filters. Nothing was deleted or rewritten to force the count to 5 — the AU resolver fix makes the canonical shape surface honestly.

### 6. Code changes

- [src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/page.tsx](src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/page.tsx)
  - `allCompletedRuns` → `allTerminalRuns` with `where.executionStatus: { in: ["COMPLETED", "FAILED"] }`. RUNNING / QUEUED / REQUESTED still excluded (no committed shortfall payload). CANCELLED excluded. `planRun` selection unchanged.
- [src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/ManagerReviewClient.tsx](src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/ManagerReviewClient.tsx)
  - Pre-existing type-parity fix (`readonly` modifiers on `RetainedRejectedProposalForReview`) so the server `ManagerReviewRetainedItem` type satisfies the client prop under `tsc --noEmit`. Zero runtime behavior change.
- [tests/e2e/ep-train-4y-au-manager-review.staging.spec.ts](tests/e2e/ep-train-4y-au-manager-review.staging.spec.ts) — **new browser-level regression** (see §7).
- `scripts/4yau-reproduce-founder-view.mjs`, `scripts/4yau-preservation-probe.mjs` — reproduction + preservation harnesses captured for the record.

**Nothing** touches: canonical data, question content, approval state, grounding, dedup, API shape, RBAC, migrations.

### 7. Browser-level test results

File: `tests/e2e/ep-train-4y-au-manager-review.staging.spec.ts`

Run via the canonical staging entrypoint `npm run test:e2e:staging` (uses the `staging-authenticated` Playwright project; loads credentials via `tests/e2e/_lib/staging-auth.ts`).

**Result**: **2 passed (1.1 m)**.

Test 1 — `Q7 (recovered) renders with no 'destination unknown' header; tab counts match canonical`:
1. Logs in as founder; opens the review URL at 1440×900.
2. Asserts tab labels `Checkpoints · 5` and `Final assessment · 10`.
3. Clicks "Final assessment" tab.
4. Walks forward until the pane shows `Question 7 of 10`.
5. Asserts pane text does NOT match `/destination\s+unknown/i`, `/·\s*unknown\b/i`, or `/·\s*checkpoint\b/i`.
6. Asserts pane contains `pay stubs`.
7. Reloads the page; repeats all assertions.

Test 2 — `Checkpoints tab does NOT contain the recovered pay-stub question`:
1. Logs in; opens the review URL.
2. Clicks "Checkpoints" tab.
3. Walks through every checkpoint question and asserts none contains "pay stubs".

Both tests inspect ACTUAL RENDERED DOM (`pane.innerText()`), not only API responses, satisfying directive §6.

### 8. Preservation evidence

Post-AU preservation probe (`scripts/4yau-preservation-probe.mjs`):

```
{
  "totalLiveDrafts": 15,
  "allPreservedExisting14": true,
  "asDraftPreserved": true,
  "metadataPreserved": true,
  "completionsCount": 0,
  "promotedCount": 0
}
```

| aspect | status |
|---|---|
| 5 checkpoint hashes | byte-identical |
| 6 AK FA + 3 AN FA + 1 AS FA hashes | byte-identical |
| `course.title` = "Employee Onboarding and Policies" | unchanged |
| `course.aiMetadataAttributionAt` = `2026-11-10T20:42:51.040Z` | **unchanged (10th consecutive preservation run)** |
| completions | 0 |
| promotions | 0 |

### 9. Corrected staging screenshot

Captured at 1440×900 after AU deploy:
- `test-results/4yau-fa-q7.png` — **Q7 of 10 on the Final Assessment tab**. Header reads simply `Question 7 of 10` (with the "Needs review" chip). No "destination unknown" text anywhere.
- `test-results/4yau-cp-tab.png` — Checkpoints tab showing `Checkpoints · 5`, no pay-stub question in the list.

DOM text captured in `test-results/4yau-reproduction.json` + Playwright trace files under `test-results/artifacts/...`.

### 10. Final founder acceptance recommendation

**Recommend acceptance** of EP-TRAIN-4Y-AU. The evidence:

- The founder's browser-level defect is reproduced exactly pre-AU and GONE post-AU.
- The Playwright regression test (which this directive mandated) PASSES against live staging on both initial render and after reload.
- The 15/15 canonical drafts are byte-identical and the metadata attribution is unchanged.
- Zero GPU inference.
- Zero cosmetic masking — the fix is at the loader stage, 6 stages upstream of the UI header, and the rendered destination is now a derivation of the correct in-memory state.
- The Checkpoints vs Final-Assessment counts now agree with the canonical records (5 and 10 respectively).

The AS draft `cmwbl6aic0007107lhfo4n0wl` remains in `REQUIRES_HUMAN_REVIEW`. Reviewer / promotion / publish gates are unchanged; a reviewer with `hr:training:ai:approve` must approve it before promotion, and `hr:training:publish` governs the course lifecycle. No gate is bypassed by this slice.

---

## Staging deployment

| aspect | value |
|---|---|
| DRH-1 run | `43121339882` — **SUCCESS** (`--ref` form) |
| Rollback anchor | `sha-2768265c7814` (AT baseline — web v1154 / worker v387) |
| New release | Fly web **v1155** · worker **v388** · both on **`sha-0e3595d3541e`** (WI-SYNC-1b aligned) |
| `/api/health` | **HTTP 200** |
| Migration | None |
| Preservation probe (post-deploy) | 15/15 drafts byte-identical · metadata unchanged (10th consecutive) |

---

## Note on the AT false positive (for the record)

AT's acceptance test checked `body.innerText()` on the Final Assessment tab AT INITIAL RENDER. The tab lands on Q1, and Q1 has a normal destination, so the regex `/destination\s+unknown/i` naturally didn't fire. The actual defect only surfaces after navigating to Q7. The new AU Playwright test walks all the way to Q7 and inspects the question-pane directly — the correct granularity for this family of defects.

---

## STOP

Per directive final line. The visible defect is gone, the Playwright regression proves it in the actual browser, the canonical data is intact, and the fix is at the real root cause (loader, not UI).
