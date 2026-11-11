# EP-TRAIN-4Y-AT — Recovered Question Destination Metadata Repair — Report

**Status**: ✅ **Q7 HEADER FIXED** · root cause repaired at the resolver layer (not cosmetic) · AS service hardened with ambiguous-destination guard · 15/15 drafts byte-identical · ZERO GPU · 9th consecutive preservation run.

**Boundaries honoured**: staging only · no production · **NO GPU inference** · no question content change · tenant-scoped · audited · 126 WIP + stash `49c2af3d` intact.

---

## §7 — Final 7-item report

### 1. Exact root cause

**File**: [src/lib/hr/training/generation/destination-resolver.ts](src/lib/hr/training/generation/destination-resolver.ts) · function `parseShortfallGroupMap`.

**What it did before AT**:
```ts
// Only walked dedupDecisions[] with kept: true.
for (const row of parsed.dedupDecisions) {
  if (row.kept === true) map.set(row.candidateContentHash, row.group);
}
```

**Why Q7 rendered "destination unknown"**:

1. The AR-failed run (`cmwbij5rq0007mmqsxow0h9jv`) **persisted zero drafts** — all proposals were sanitiser-rejected. Its `dedupDecisions[]` was empty.
2. The AS manager-editorial recovery wrote the new draft `cmwbl6aic0007107lhfo4n0wl` (hash `b4d2ed9ffdf8…`) into `perGroupDiagnostics[0].recoveryHistory[0]` — a field the resolver **did not inspect**.
3. The review page called `annotateDraftsWithComposedDestination` → `composedGroupMap.get("b4d2ed9ffdf8…")` → `undefined` → `destinationKindForGroup(null)` → `"UNKNOWN"` → header renders "destination unknown".

**NOT the root cause**:
- ❌ Missing canonical destination metadata in the DB — the AS record IS complete; it has `groupId: "fa-1"` inside the retained record AND the containing `perGroupDiagnostics[g].group === "fa-1"`.
- ❌ Incorrect destination normalisation — `destinationKindForGroup("fa-1")` correctly returns `FINAL_ASSESSMENT`.
- ❌ UI header text — the component's rendering logic is correct; it was simply handed `destination: "UNKNOWN"` by the resolver.

**Root cause**: the destination resolver has two draft-creation paths to reconcile:
- GPU-generation path — records in `dedupDecisions[]` with `kept: true`.
- AS manager-recovery path — records in `perGroupDiagnostics[g].recoveryHistory[]`.

The resolver only walked the first.

### 2. Before / after destination metadata (NO content change)

**On disk** — the canonical record was ALREADY correct both before and after AT:

| field | pre-AT | post-AT |
|---|---|---|
| AS draft id | `cmwbl6aic0007107lhfo4n0wl` | **unchanged** |
| AS draft contentHash | `b4d2ed9ffdf8…` | **unchanged (byte-identical)** |
| AS draft state | `REQUIRES_HUMAN_REVIEW` | **unchanged** |
| AS draft generationRunId | `cmwbij5rq0007mmqsxow0h9jv` (AR run) | **unchanged** |
| `shortfallReasonJson.perGroupDiagnostics[0].group` | `"fa-1"` | **unchanged** |
| `shortfallReasonJson.perGroupDiagnostics[0].recoveryHistory[0].savedAsDraftId` | `cmwbl6aic0007107lhfo4n0wl` | **unchanged** |
| `shortfallReasonJson.perGroupDiagnostics[0].recoveryHistory[0].contentHash` | `b4d2ed9ffdf8…` | **unchanged** |

**As resolved in-memory for the review page**:

| aspect | pre-AT | post-AT |
|---|---|---|
| `composedGroupMap.get("b4d2ed9ffdf8…")` | `undefined` | **`"fa-1"`** |
| `destinationKindForGroup(resolved)` | `"UNKNOWN"` | **`"FINAL_ASSESSMENT"`** |
| `planGroupKey` prop handed to UI | `null` | **`"fa-1"`** |
| Header string | "destination unknown" | **(no such string anywhere)** |

**No question content change** — stem, options, correct-answer, explanation, sourceSegmentIds are all byte-identical to the AS commit.

### 3. Code changes

**Resolver (fixes the historic bug + future recoveries)**:
```ts
// src/lib/hr/training/generation/destination-resolver.ts
// Extended parseShortfallGroupMap to also walk
// perGroupDiagnostics[g].recoveryHistory[] entries and emit
// (contentHash → g.group) mappings. First mapping wins so a prior
// dedup-kept row is NOT overwritten by a later recovery. Malformed
// entries (missing contentHash / savedAsDraftId) skipped.
```

**Service guard (prevents recurrence per §3)**:
```ts
// src/lib/hr/training/generation/rejected-proposal-recovery.ts
// Added groupId pattern check + destinationKind definiteness check
// BEFORE persist. Rejects AMBIGUOUS_DESTINATION with HTTP 422 if
// the groupId doesn't match one of: "final" | /^fa-\d+$/ |
// /^cg-\d+$/ | /^ck-[a-z0-9]+$/.
// Defence-in-depth: even a corrupt or spoofed groupId can't land a
// draft that would render as "destination unknown" again.
```

**Regression suite** (`tests/ep-train-4y-at-destination-resolver.test.ts`): 17 tests covering resolver harvest from recoveryHistory, GPU-path preservation, composed maps across runs, first-mapping-wins on collisions, malformed-entry safety, service-guard source assertions.

**Files changed** — 2 + 1 new:
- `src/lib/hr/training/generation/destination-resolver.ts` (modified)
- `src/lib/hr/training/generation/rejected-proposal-recovery.ts` (modified — guard only)
- `tests/ep-train-4y-at-destination-resolver.test.ts` (new)

**Zero** UI / schema / canonical-data changes.

### 4. Regression test results

| suite | result |
|---|---|
| **AT** (destination resolver — recoveryHistory harvest + service guard) | **17 / 17 PASS** |
| **AA** (existing destination resolver — GPU path) | PASS |
| **AR** (rejected-proposal retention) | PASS |
| **AS** (manager-recovery service + endpoint) | PASS |
| **Combined** AA + AR + AS + AT | **51 / 51 PASS** |
| `npx tsc --noEmit` on AT-touched files | **CLEAN** |

### 5. Audit and provenance preservation

- AS commit `88d0eb90` auditLog entry `cmwbl6amf0009107l0hzr0tqe` for `hr.training.ai-rejected-proposal.recovered` — **unchanged**.
- `recoveryHistory[0]` on the AR run row — **unchanged** (savedAt, savedByUserId, editedQuestionText, editedOptions, editedExplanation, savedAsDraftId, contentHash).
- AS draft's `generationRunId` binding → AR run → immutable retained-proposal record — **unchanged**.
- `course.aiMetadataAttributionAt` = `2026-11-10T20:42:51.040Z` — **unchanged (9th consecutive preservation run)**.
- `completionsCount` = 0, promotions = 0 — **unchanged**.

No AT writes against the DB. The resolver is pure/offline. The service guard is compile-time; it runs inside future recovery requests only.

### 6. Deployment SHA and health evidence

| aspect | value |
|---|---|
| DRH-1 run | `42957162523` — **SUCCESS** (correct `--ref` dispatch form from AR memory note) |
| headBranch resolved | `ep-train-4y-b-impl/hybrid-auth-contract` (right) |
| Fly web | **v1154 · `sha-2768265c7814`** |
| Fly worker | **v387 · `sha-2768265c7814`** (same SHA — WI-SYNC-1b invariant holds) |
| Rollback anchor | `sha-12cfe415bd08` (web v1153 / worker v386 — AS baseline) |
| `/api/health` | **HTTP 200** |
| Migration | None |

Web + worker on the same SHA was explicitly verified by inspecting both apps' `flyctl status --json` output before declaring §6 done.

### 7. Screenshot of corrected Question 7

Captured at 1440×900 (`test-results/4yat-review-*.png`):

| file | contents |
|---|---|
| `4yat-review-default.png` | Course landing — post-AT review page |
| `4yat-review-fa-tab.png` | **Final Assessment · 10** — the recovered question renders with its FA destination intact |
| `4yat-review-q7.png` | Q7 focused view — no "destination unknown" string anywhere |
| `4yat-review-after-refresh.png` | After browser reload — resolution is stable across refreshes |

**UI-text scan** (page-level innerText regex `/destination\s+unknown/i`):
- Initial render: **false** (no match)
- After reload: **false** (no match)

### 8. Confirmation that all 15 questions remain intact

```json
{
  "totalLiveDrafts": 15,
  "allPreservedExisting14": true,
  "asDraftPreserved": true,
  "metadataPreserved": true,
  "completionsCount": 0
}
```

| aspect | status |
|---|---|
| 5 checkpoint hashes `24c26223e6d1 5d2863681508 e05878acffc1 084e91e008d1 fcf533481947` | byte-identical |
| 6 AK FA hashes `e479567ee290 01ff61464357 155890567d00 c855a6435458 f8ae54baa666 00054b4f30fa` | byte-identical |
| 3 AN FA hashes `7c428a0d126a 642496d444c2 008af536cb3d` | byte-identical |
| 1 AS FA hash `b4d2ed9ffdf8` (the recovered 10th question) | byte-identical |
| `course.title` = "Employee Onboarding and Policies" | unchanged |
| `course.aiMetadataAttributionAt` | unchanged |
| completions | 0 |
| promotions | 0 |

---

## STOP

Per directive final line. The slice is complete:

- **Root cause identified at the resolver, not the UI.**
- **No cosmetic patch** — the data path now correctly surfaces the destination for recovered drafts.
- **No canonical data mutation** — the historic AS draft needed no migration.
- **Prevention guard** added so future recoveries with unmappable group ids reject at write time.
- **All 15 questions byte-identical. `/api/health` 200.** Web + worker on the same SHA.
- **Reviewer / promotion / publication gates unchanged** — the AS draft remains `REQUIRES_HUMAN_REVIEW`.

Awaiting the normal lifecycle: a reviewer with `hr:training:ai:approve` approves, a `hr:training:publish`-authorised actor publishes.
