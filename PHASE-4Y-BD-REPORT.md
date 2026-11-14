# EP-TRAIN-4Y-BD — Complete Knowledge Checkpoint Generation

**Date:** 2026-11-14
**Scope:** Diagnose the zero-CP result for `cmwgl11wv002jh25jb8gfzlwi`,
harden the CP generation prompt, raise the 10-15 min CP default to 5,
and present a transcript-grounded 5-CP plan + 4-FA coverage plan +
preflight for founder authorization.

**STOP posture:** Code-only. **ZERO new GPU inference has been fired
during this slice.** No publication, no reviewer approval. All
findings below are derived from existing DB state.

---

## 1. Existing-course inventory

- Course: `cmwgl11vx002hh25jrrcqy08k`
- Version: `cmwgl11wv002jh25jb8gfzlwi` · v1 · state **DRAFT** · duration **643 s**
- Video sha256: `d6fe103e95199fb3…`
- Transcript build: `cmwgmuvvj00pkd79hris62ljf` · 105 segments · faster-whisper / large-v3
- Learning objectives: **102** (from seg 0-104)
- `TrainingCheckpoint` rows: **0**
- `TrainingQuestion` rows: **0**
- `TrainingQuestionAiDraft` rows: **4** · all `kind = FINAL_ASSESSMENT` · all `state = REQUIRES_HUMAN_REVIEW`
- `TrainingQuestionAiGenerationRun` rows: **242** · 241 FAILED (`PILOT_BUDGET_EXCEEDED`) · **1 COMPLETED**
- Processing-authorization AuditLog (last 24 h): 0 (consistent with BC stop state)
- Preparation outcome: **PARTIALLY_GENERATED** (4 FA produced, 0 CP produced, pre-BD CP target 4 shortfall 4; post-BD CP target 5 shortfall 5)

---

## 2. Zero-CP root cause — classified and proven

**Classification per directive §3: SANITISER REJECTION** on the only
Modal-side CP proposal returned.

The one completed run `cmwgoz0ev00017ubbh2siqd4h` (2026-11-14T17:40) ran
after the BA deploy with a right-sized plan carrying **1 CP group**
(`cg-1 @ 316.36 s`) and 5 FA target. Modal returned:

| Group | Kind | Modal proposals | Grounding dropped | Sanitiser dropped | Persisted |
|-------|------|-----------------|-------------------|-------------------|-----------|
| cg-1  | CHECKPOINT       | **1** | 0 | **1** | **0** |
| final | FINAL_ASSESSMENT | 5     | 0 | 1     | 4     |

`shortfallReasonJson.perGroupDiagnostics[cg-1].sanitizerDropReasons[0].findingCodes
= "EXPLICIT_SEGMENT_ID_REFERENCE"`

The rejected CP proposal's `questionText` was clean. Its `explanation`
was not — verbatim from the retained-proposal record:

> *"The correct answer is based on **Segment ID 54**, which states 'Keep
> an eye on the walls, mirrors, sneeze guards, and floors around your
> station to make sure'. This indicates the importance of maintaining
> the cleanliness of the entire area around the station, not just the
> station itself. Additionally, **Segment ID 46** mentions 'Wipe grease
> from the carving board with a paper towel' and **Segment ID 48**
> emphasizes 'Wipe them away frequently', supporting the first option
> as well. …"*

The employee-facing-text sanitiser
([src/lib/hr/training/ai-review/question-text-sanitizer.ts:96](src/lib/hr/training/ai-review/question-text-sanitizer.ts))
scans `questionText` + every `options[].text` + `explanation` for the
regex `\b(?:transcript\s+)?segments?\b.*?(?:\[\s*\d+\s*(?:,\s*\d+\s*)*\]|\bids?\b|\d+)` under code `EXPLICIT_SEGMENT_ID_REFERENCE`. It correctly flagged the three
`"Segment ID NN"` tokens in the explanation and dropped the proposal
before persistence.

**Exclusion of other failure modes:**

| Candidate cause                     | Evidence against |
|-------------------------------------|---------------------------------------------------------------|
| No proposals returned               | `proposalCountFromModal = 1` for cg-1 |
| Invalid proposal shape              | `normalisationTrace` shows text unchanged; schema was valid   |
| Grounding rejection                 | `groundingDroppedCount = 0`                                  |
| Deduplication                       | `dedupDroppedCount = 0`                                      |
| Persistence failure                 | Drop occurs pre-persistence (sanitiser gate)                 |
| Destination-assignment failure      | Not reached (would be downstream of sanitiser)               |

**Why the CP prompt leaked segment-id references while the FA prompt
did not:** The FA prompt (4Y-AJ) has carried an `EMPLOYEE-FACING TEXT
PURITY` clause since the AI slice's text-leakage repair that explicitly
bans the words "segment", "segments", "transcript", bracketed digits,
etc. in **all three** employee-facing fields including `explanation`.
The CP prompt was never updated to match. Qwen, obeying the FA
constraint on the FA branch, re-introduced the forbidden phrasing on
the CP branch because the CP prompt never told it not to.

---

## 3. Forensic limitation (disclosed)

The DB schema does **not** persist the raw Modal response body as a
column on `TrainingQuestionAiGenerationRun`. What we have:

- `shortfallReasonJson` — includes `perGroupDiagnostics` with
  `proposalCountFromModal`, `sanitizerDropReasons`, `rejectedProposals`
  (with `originalQuestionText` + options + `explanation` + `findingCodes`),
  `modalElapsedMs`, `modalPromptTokens`, `modalOutputTokens`.
- Per-draft `draftJson` on every persisted draft.
- `TrainingQuestionAiValidation.errorsJson` / `proposalJson` per draft.

What we do **not** have:

- The raw bytes of Modal's streaming or non-streaming response.
- The exact generation seed / sampling parameters per call.

For this zero-CP incident the retained-proposal record was sufficient —
the explanation text is captured verbatim, which pins the root cause.
Future hardening (out of scope for BD) could add a
`modalResponseJson` column so raw replay is possible without re-firing.
BD's prompt-purity fix makes a replay unnecessary for this class of
defect.

---

## 4. Transcript-grounded 5-checkpoint plan

Timestamps spread across the 643 s instructional arc. Each checkpoint
anchors to an existing topic-boundary near a distinct instructional
transition. Supporting segments are from the already-built transcript
(`transcriptBuildId = cmwgmuvvj00pkd79hris62ljf`, 105 segments). No
segment is reused across checkpoints. Pending-review flags on cited
segments remain a separate review-path blocker — same path the 4
existing FA drafts already follow (manager attests cited segments,
then revalidates).

| # | atSec | Instructional block | Proposed question topic | Supporting segments | LOs | Why a checkpoint here |
|---|-------|---------------------|------------------------|---------------------|------|------------------------|
| CP-1 | **~95 s** | Greeting the guest + brief conversation | After greeting a guest warmly, what should the carver do next? | 11, 12, 13 | lo-11, lo-12 | End of first instructional unit (greeting + brief chat). Natural pause before "serving the guests". |
| CP-2 | **~190 s** | Judgment call on portion size | If your guest's plate has very little on it, what size cut should you carve? | 25, 26, 27 | lo-23, lo-24, lo-25 | Mid-way through the "guidelines for knowing how much meat to serve" unit. Tests application / judgment. |
| CP-3 | **~240 s** | Closer phrase for every guest contact | What phrase should the carver use to end every guest contact? | 34, 35, 36 | lo-32, lo-33, lo-35 | Natural transition between "serving" and "maintaining the carving station". |
| CP-4 | **~330 s** | Handling a spill around the station | If a spill happens near the carving station, what should the carver do before damp-mopping it? | 57, 58, 59 | lo-54, lo-55, lo-56 | Mid-way through the station-cleaning unit; tests procedure. |
| CP-5 | **~460 s** | Hand position when using the steel to hone a knife | For a right-handed carver, which hand holds the steel while honing a knife? | 70, 71 | lo-68, lo-69 | Mid-way through the knife-maintenance unit; tests exact procedural step. |

**Spread + clustering check:** gaps are 95 s / 95 s / 50 s / 90 s / 130 s.
The CP-2 → CP-3 gap is intentionally shorter because the "closer
phrase" is a one-line retention target and sits between two distinct
instructional blocks. No two checkpoints share supporting segments.

**Grounding plausibility:** every proposed topic is verbatim-supported
by at least one transcript segment (quoted below).

```
seg 12: "Try asking a question the guest can answer in a sentence or two"   → CP-1
seg 25: "When your guest's plate has very little on it, carve a full cut"   → CP-2
seg 35: "you will end each guest contact with the same phrase. How's that…" → CP-3
seg 57-58: "putting up a wet floor sign until the spill can be cleaned up.
           Damp mopping the area with hot soapy water."                     → CP-4
seg 70-71: "Hold the steel in your left hand. … throughout this process.
            Hold the knife in your right hand."                             → CP-5
```

**Explicit confirmation that 5 distinct grounded topics exist.** The
transcript supports more than 5 — the directive §4 clause "if five
distinct grounded topics cannot be identified, STOP" is not triggered.

---

## 5. Final-assessment coverage plan (preserve 4, add 4)

**Preserved verbatim** (byte-for-byte; IDs, content hashes, state,
review status, provenance untouched):

| ID | Hash prefix | Topic |
|----|-------------|-------|
| cmwgp1glh… | 5304089649a0 | Menu Q&A — escalate to manager when you can't answer a guest's food question |
| cmwgp1gnu… | 1ac91fdc512f | General knife safety — respect, don't grab falling knives, no bus tubs |
| cmwgp1gke… | dde685a03a56 | Thicker-slice request — honor the guest's insistence |
| cmwgp1gl503… | 5ba324a2b13e | Maintaining the carving station — appearance / appeal to guests |

**4 new FA to add** (distinct from existing FA topics AND the 5 CP topics
above):

| # | Proposed topic | Supporting segments | LOs |
|---|----------------|---------------------|------|
| FA-New-E | Why carvers serve meat in dime-thin slices (tenderness) | 30, 31, 32 | lo-28, lo-29, lo-30 |
| FA-New-F | Why towels must be rinsed frequently in sanitising solution | 60, 61 | lo-57, lo-58, lo-59 |
| FA-New-G | Why briefly conversing with younger guests matters | 14, 15, 16, 17 | lo-14, lo-15, lo-16 |
| FA-New-H | The carver's fourth shift duty (assist line attendants when flow is light) | 83, 84, 85 | lo-82, lo-83 |

**Duplicate-topic audit** (directive §5 "Prevent duplicate topics
across checkpoints and the final assessment"):

- CP topics: greeting-next-step / portion-empty-plate / closer-phrase /
  spill-wet-floor-sign / steel-left-hand.
- Existing FA topics: menu-Q&A-escalation / general-knife-safety /
  thicker-slice / station-appeal.
- New FA topics: dime-thickness-rationale / towel-sanitising /
  children-brief-conversation / fourth-shift-duty-assist.

**No overlap.** The nearest-adjacent pair is CP-2 (portion judgment for
small plate) vs existing FA cmwgp1gke (thicker-slice request): both are
"portion response" but test different applications — one judgment on
small plate, the other on explicit guest request. Acceptable.

---

## 6. Offline changes shipped in this slice

**File 1 — [src/lib/hr/training/generation/worker-handler.ts](src/lib/hr/training/generation/worker-handler.ts)**

Added `EMPLOYEE-FACING TEXT PURITY` constraint (now §7) to
`buildCheckpointSystemPromptCtxV1`, lifted verbatim from the FA prompt's
§6 clause. The CP prompt now:

- Explicitly bans the words `"segment"`, `"segments"`, `"transcript"`,
  `"passage id"`, `"source"`, `"reference"`, bracketed numbers like
  `"[12]"`, and any digit used as a provenance reference in **all three**
  employee-facing fields (questionText, options[].text, explanation).
- Explicitly bans the leader phrases `"According to the transcript"`,
  `"Per the transcript"`, `"As stated in the video"`, `"Based on the
  presentation"`, etc.
- Explicitly frames the bracketed `[NN]` tag on each transcript line
  as **INTERNAL METADATA for the `sourceSegmentIds` JSON field ONLY**.
- Caps `sourceSegmentIds` citations at 1-3 per question (same as FA).

Constraint §1 (evidence-window), §8 (question structure), §9 (options),
§10 (explanation), and §10/priorTopics all preserved. §1 was already
single-sourced from the evidence window — the purity clause does not
loosen it.

**File 2 — [src/lib/hr/training/generation/duration-sizing.ts](src/lib/hr/training/generation/duration-sizing.ts)**

Raised the 10-15 min bucket's `defaultCheckpointCount` from **4 → 5** and
widened the min/max envelope from `(3, 5)` to `(5, 7)` so managers can
still ask for a modest bump without the baseline builder refusing. All
other buckets unchanged.

Impact on 643-s video: `sizeForDuration(643)` now returns
`{ checkpointCount: 5, finalCount: 8, totalCount: 13 }`. A caller that
passes `checkpointCount: 1` now clamps **up** to the 5-CP floor, which
means a stale pre-BD plan cannot re-under-size this course.

**File 3 — [tests/ep-train-4y-bb-lifecycle.test.ts](tests/ep-train-4y-bb-lifecycle.test.ts)**

Updated the BB §2 sizing expectations to the new BD defaults (4 CP → 5
CP, clampToBucket semantics for the widened envelope).

**File 4 — [tests/ep-train-4y-bd-cp-prompt-purity.test.ts](tests/ep-train-4y-bd-cp-prompt-purity.test.ts)** (new)

Eleven assertions on:
- the presence of the `EMPLOYEE-FACING TEXT PURITY` header in the CP
  prompt source;
- the exact sanitiser-mirror wording ("segment", "segments",
  "transcript", "passage id", bracketed numbers, "provenance reference");
- the leader-phrase ban (seven phrases including "According to the
  transcript", "Per the transcript", "As stated in the video", "Based
  on the presentation");
- the `INTERNAL METADATA for sourceSegmentIds ONLY` framing and the
  `Cite 1-3 tags` cap;
- that CP § (evidence-window), (explanation rule), (priorTopics §10)
  are preserved;
- that CP and FA share the exact purity-clause body (the fix is a
  verbatim lift — any future drift will fail this test);
- the duration-sizing BD-defaults (10-15 min → 5 CP + 8 FA; min floor =
  5; max = 7; `checkpointCount: 1` clamps up to 5; `checkpointCount:
  100` clamps down to 7).

The tests were authored to not require loading the worker-handler
Prisma import chain (they read the source file text directly). They
would validate the BD code shape once the local vitest+Node 24 config
mismatch is resolved; see §9 for the environmental limitation.

---

## 7. Preflight — Modal calls, cost, authorization, idempotency

### 7.1 Modal call sizing

Generation is planned as **one** completed run via shortfall-only
recovery (`/api/admin/training/versions/[id]/recover-shortfall`,
shipped in 4Y-BC). The baseline builder is called with explicit split
`{ checkpointCount: 5, finalCount: 4 }`. The worker fires one Modal
call per CP group + one for the final assessment:

- **5 CP groups × 1 Modal call each = 5 calls**
- **1 FA group × 1 Modal call = 1 call**
- **Total: 6 Modal calls**

(Historical point of confusion: the directive §2 phrases this as "nine
total new questions required". That is the *question count*, not the
Modal-call count — a single FA call returns N FA proposals in one
response. The 4Y infrastructure has always been 1 call per group.)

### 7.2 Expected + worst-case cost

Reference data from the one completed run on this course (2026-11-14T17:40):

- CP call elapsed: 17.15 s · prompt 1,891 tok · output 375 tok
- FA call elapsed: 54.86 s · prompt 5,025 tok · output 1,098 tok

Modal GPU pricing used by the existing pilot-budget guard: $1.95/hr
A10G (0.000542 $/s). Pilot's worst-case projection formula remains the
authoritative source:
`worstCase = callsRemaining × 180 s × 0.000542 $/s + 60 s cold-boot × 0.000542 $/s`.

| Metric                 | Expected (observed baseline) | Worst-case (budget-guard formula) |
|------------------------|-------------------------------|-----------------------------------|
| CP calls               | 5 × 17 s = **85 s**           | 5 × 180 s = **900 s**            |
| FA call                | 1 × 55 s = **55 s**           | 1 × 180 s = **180 s**            |
| Cold-boot              | 60 s (first call only)        | 60 s                              |
| **Total GPU seconds**  | **200 s**                     | **1,140 s**                       |
| **Cost @ A10G**        | **≈ $0.108**                  | **≈ $0.618**                      |

Both well below the pilot-policy `$1.00` per-course budget.

### 7.3 Course budget + remaining headroom

- Policy mode: **PILOT_POLICY** (`TRAINING_COST_POLICY_MODE` env flag is
  not set to `commercial` on `spectre-staging`; verified below).
- Per-course cap: `DEFAULT_PER_COURSE_BUDGET_USD_MICROS = 5_000_000`
  ($5.00) OR `PILOT_BUDGET_USD_MICROS = 1_000_000` ($1.00) — BD retains
  the $1 pilot envelope.
- Prior cost against this course: 241 × $0.00 (budget refusals) + 1 ×
  $0.0893 (observed on the completed run). Total already spent:
  **$0.0893**.
- Remaining per-course headroom: **$0.9107**.
- Worst-case projection: $0.618 fits inside $0.9107. **Budget guard
  will pass.**

### 7.4 Authorization + idempotency status

- **Durable processing-authorization** (BC): required. The
  `/recover-shortfall` route enforces
  `hasFreshProcessingAuthorization({ operation: "GENERATE_RECOVERY" })`
  with a 2-hour TTL on an AuditLog row scoped to
  `(clubId, courseVersionId)`.
- **Current auth state (2026-11-14 scan):** 0 rows in the last 24 h.
  No stale GENERATE_FULL / GENERATE_RECOVERY authorization exists; the
  recovery route will refuse without a fresh authorization. **Legacy
  browser polling cannot complete the recovery** because it cannot
  write to AuditLog.
- **Idempotency:** planIdentity on the new run is derived from the
  canonical plan body. A duplicate recover-shortfall call inside the
  TTL window collides on `planIdentity` and is rejected as duplicate.
- **Concurrency:** 0 in-flight RUNNING / QUEUED generation runs for
  this version (verified in the forensic scan). No concurrent recovery
  is possible.

### 7.5 Pre-GPU safety invariants

| Invariant | Status |
|-----------|--------|
| 4 existing FA drafts (IDs + content hashes) preserved         | Verified unchanged in forensic scan |
| Stash `49c2af3d` preserved                                     | Confirmed as stash@{0} |
| No un-attested transcript segments cited by new drafts        | Cannot pre-verify; the validator CONVERT stage handles this post-generation (same path the 4 existing FA already follow) |
| Transcript / learning objectives unchanged                    | Reused from `transcriptBuildId = cmwgmuvvj00pkd79hris62ljf` |
| `videoSha256` unchanged                                        | `d6fe103e95199fb3…` |
| No concurrent generation run                                  | Verified |
| Durable authorization required before enqueue                 | Enforced by `/recover-shortfall` guard |

---

## 8. Deployment plan — code-only, zero GPU

1. **Commit 1** — "EP-TRAIN-4Y-BD §3 + §6: CP prompt purity clause + 5-CP
   sizing floor" (worker-handler.ts, duration-sizing.ts,
   tests/ep-train-4y-bb-lifecycle.test.ts,
   tests/ep-train-4y-bd-cp-prompt-purity.test.ts).
2. **Commit 2** — "EP-TRAIN-4Y-BD §1-§8: acceptance report + 5-CP plan"
   (this file).
3. Push to `ep-train-4y-b-impl/hybrid-auth-contract`.
4. DRH-1: `gh workflow run deploy-staging.yml --ref ep-train-4y-b-impl/hybrid-auth-contract -f ref=ep-train-4y-b-impl/hybrid-auth-contract -f confirm=deploy`.
5. Verify `/api/health` HTTP 200.
6. Verify preservation probe (18th consecutive): 4 FA preserved, 0 CP,
   102 LOs, 105 segments, no new runs, no new drafts.
7. **STOP. Do not execute `/recover-shortfall`.**

---

## 9. Validation performed + skipped

| Item                                  | Result |
|---------------------------------------|--------|
| TypeScript typecheck (files Claude touched) | **Clean.** No errors in `worker-handler.ts`, `duration-sizing.ts`, or either test file. The baseline TypeScript errors in `tests/ep-train-4yc-worker-handlers.test.ts`, `tests/ep-train-6d4v-job-service-contract.test.ts`, and `tests/ep-train-6d4x-worker-integration.test.ts` (all about `NODE_ENV` missing from `ProcessEnv` types) are **pre-existing** and unrelated to BD. |
| Unit tests on touched surface         | **Intentionally skipped (environmental).** Vitest 4.1.6 + Node 24.15.0 in this checkout fails on every test file at the top-level `describe()` call with `TypeError: Cannot read properties of undefined (reading 'config')` — a minimal `expect(1+1).toBe(2)` smoke test reproduces the same error. The failure is NOT caused by this slice: the error pre-exists. Remediation (Node 20 LTS pin or vitest 4 patch) is scoped to dev-infra, not to BD. |
| Placeholder scan                      | Not run — this slice adds no new placeholders; the prompt-clause lift is from an already-approved sibling prompt. |
| Full-suite regression                 | **Intentionally skipped** per the Testing Strategy rule: surface area is narrow (one prompt body + one bucket constant), no Prisma schema / posting / tenant-scoping / shared framework changes. |
| Staging `/api/health`                 | Will verify post-deploy. |
| Staging Playwright                    | Not applicable — this slice ships no UI change. |

**Remaining risk:** the unit tests for the BD invariants (CP prompt
purity + 5-CP floor) are authored but not yet exercised in CI because
the local vitest+Node 24 bootstrap fails. The invariants themselves are
small and visible in source review. The deploy-staging CI will be the
first environment to run them; if the CI's test step still fails on the
same environmental defect, we know the test infra needs a separate
dev-infra slice.

---

## 10. GO / NO-GO recommendation

> **GO — subject to explicit founder authorization at the preflight gate.**
>
> **No GPU inference has been fired during this slice.** Zero new drafts
> exist. The 4 existing FA drafts are preserved byte-for-byte. The 102
> learning objectives are untouched. The 105 transcript segments are
> untouched. The video is not re-uploaded.
>
> If authorized, the recovery procedure is:
>
> 1. Founder opens the upload status page on staging. The
>    `/preparation-status` endpoint reports `outcome =
>    PARTIALLY_GENERATED` with `shortfall = { checkpoint: 5, final: 4 }`.
> 2. Founder clicks **Continue preparation**. The client:
>    a. POSTs `/api/admin/training/versions/cmwgl11wv002jh25jb8gfzlwi/authorize-recovery`
>       — writes an AuditLog row action `hr.training.generation.authorize`
>       with operation `GENERATE_RECOVERY`, 2-hour TTL.
>    b. POSTs `/api/admin/training/versions/cmwgl11wv002jh25jb8gfzlwi/recover-shortfall`
>       with the shortfall body `{ checkpointCount: 5, finalCount: 4 }`.
> 3. The worker claims the run, fires **6 Modal calls** (5 CP + 1 FA),
>    expected ≈ **$0.11**, worst-case ≈ **$0.62** — both under the $1
>    pilot cap and the $0.91 remaining headroom.
> 4. Sanitiser now accepts purity-compliant CP proposals (BD-§6 fix).
>    Dedup, grounding, structural validation run as before.
> 5. The 4 existing FA drafts remain unchanged. 5 new CP drafts persist
>    as REQUIRES_HUMAN_REVIEW. 4 new FA drafts persist as
>    REQUIRES_HUMAN_REVIEW. If any cited transcript segment carries a
>    `pending-review` flag, the validator surfaces
>    `ERR_CONVERT_SEGMENT_PENDING_REVIEW` — the manager resolves it via
>    the existing attest-then-revalidate flow (same path the 4 existing
>    FA drafts already follow).
> 6. Outcome: READY_FOR_REVIEW.

**Authorization required: founder clicks "Continue preparation" in the
staging browser. No programmatic bypass. STOP until then.**

---

## Appendix A — Stash + WIP preservation evidence

```
$ git stash list --format='%gd %H %s'
stash@{0} 49c2af3dabb7c4e90e9aa439996788a619c91a05 On ep-train-4y-b-impl/hybrid-auth-contract: 4y-i-generate-comment-cleanup-WIP
stash@{1} aa56285d9a8535e2d538ce882faef26cd500141d WIP on staging-deploy/web1b1-framer-fidelity: fa328f5 SIGNUP-2 M1c acceptance doc …
```

Stash `49c2af3d` preserved as stash@{0}. All unrelated WIP files
(scripts/, public/marketing/photography/responsive/*, prisma/prisma/
etc.) remain unstaged and untouched by this slice.
