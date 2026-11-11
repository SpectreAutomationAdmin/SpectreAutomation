# EP-TRAIN-4Y-AR — Rejected-Candidate Retention + One Authorised GPU Call — Report

**Status**: RETENTION SHIPPED · ONE GPU CALL FIRED · RUN **FAILED** at sanitiser · **FA REMAINS 9 of 10** · **the forensic gap is CLOSED** — AR retention CAPTURED the full raw Qwen proposal that AQ could not recover · AQ normaliser behaved exactly to spec (narrow-scope — declined to transform mid-sentence content).

**Boundaries honoured**: staging only · no production · **ONE** Modal call with no retries (`attempts=1/1`) · zero persistence · 14/14 hashes + metadata preserved (7th consecutive run) · stash `49c2af3d` + 126 WIP untouched.

Per directive §9 final line: **STOP after the single authorised generation attempt and report the outcome.**

---

## §8 — 10-item acceptance report

### 1. Diagnostic-retention implementation and security tests

**Module**: [src/lib/hr/training/generation/rejected-proposal-retention.ts](src/lib/hr/training/generation/rejected-proposal-retention.ts)

- `RetainedRejectedProposal` captures: original stem, normalised stem, options (text + correctness), explanation, sourceSegmentIds, questionType, rejectionStage (`GROUNDING` / `NORMALISATION_REFUSED` / `SANITISER` / `STRUCTURAL` / `DEDUP`), findingCodes, normalisation trace + refusal reason, rejectedAt, retentionExpiresAt (+30 days default), generationRunId, groupId.
- Pure constructor `buildRetainedRejectedProposal` — no I/O, no DB, no secrets.
- `pruneExpiredRetainedProposals(now)` — pure cleanup function; scheduled task can invoke later (not scheduled this slice; lifecycle also bounded by the run row).
- `flattenRetainedFromDiagnostics` — flattens multi-group diagnostics for the admin endpoint.
- NO new Prisma model, NO new migration. Storage is `shortfallReasonJson.perGroupDiagnostics[*].rejectedProposals[]` on `TrainingQuestionAiGenerationRun` — an existing tenant-scoped, DB-encrypted, admin-only column.

**Admin GET endpoint**: [src/app/api/admin/ai-training/runs/[runId]/rejected-proposals/route.ts](src/app/api/admin/ai-training/runs/[runId]/rejected-proposals/route.ts) — reuses existing `hr:training:write` permission (no new RBAC), cross-tenant returns 404, expired records pruned from response.

**Security tests** (`tests/ep-train-4y-ar-retention.test.ts`):

| § | assertion | result |
|---|---|---|
| §5.1 | retention builder captures 11 fields in correct shape | ✓ |
| §5.1 | 30-day default expiry | ✓ |
| §5.1 | records NORMALISATION_REFUSED stage + refusal reason | ✓ |
| §5.2 | `flattenRetainedFromDiagnostics` preserves ordering | ✓ |
| §5.2 | `pruneExpiredRetainedProposals` drops expired | ✓ |
| §5.2 | future-dated records retained | ✓ |
| §5.3 | tenant isolation via generationRunId (admin route enforces) | ✓ |
| §5.4 | no employee-facing surface imports the retention module (filesystem grep across `/app/member`, `/app/employee`, `/app/app/hub`, `/app/app/dashboard`) | ✓ |
| §5.4 | no employee-facing surface references `rejectedProposals` field | ✓ |
| §5.5 | retention module exports contain no draft-mutating surface | ✓ |
| §5.5 | retention module source does NOT import `@/lib/prisma` or reference `TrainingQuestionAiDraft` | ✓ |
| §5.6 | DEDUP-stage retention with `DEDUP:` code shape | ✓ |

**11/11 AR tests pass** · **104/104 cross-regression** (AA/AE/AO/AP/AQ/AR) · typecheck clean on all AR-touched files.

### 2. Offline regression results

- `tests/ep-train-4y-ar-retention.test.ts` — 11/11 PASS
- `tests/ep-train-4y-aq-normalisation.test.ts` — 30/30 PASS
- `tests/ep-train-4y-ap-focused-recovery.test.ts` — 13/13 PASS
- `tests/ep-train-4y-ao-cross-assessment-dedup.test.ts` — PASS
- `tests/ep-train-4y-aa-question-text-sanitizer.test.ts` — PASS
- `tests/ep-train-4y-ae-question-structure-validator.test.ts` — PASS
- `npx tsc --noEmit` — zero new errors on AR-touched files

### 3. GPU run ID and call count

- **Recovery run ID**: `cmwbij5rq0007mmqsxow0h9jv`
- **Modal calls executed**: **1** (attempts=1/1, no auto-retries)
- Lifecycle: `QUEUED` → `RUNNING` (2026-11-11T02:41:40.601Z) → **`FAILED`** (2026-11-11T02:43:42.272Z). Wall-clock **122 seconds**.

### 4. Original and normalised question wording — **CAPTURED** (forensic gap CLOSED)

| field | value |
|---|---|
| **originalQuestionText** | *"How can an employee access their pay stubs **according to the training material**?"* |
| **normalisedQuestionText** | *"How can an employee access their pay stubs according to the training material?"* (identical — normaliser correctly declined to transform mid-sentence framing) |
| **appliedTransforms** | `[]` (0 rules fired) |
| **refusedForSafety** | `false` (no safety gate tripped) |
| options | A: *"By using the last four digits of their SIN number"* (correct) · B: *"By calling the HR department"* · C: *"By logging into the company's online portal"* · D: *"By visiting the physical HR office"* |
| explanation | *"...The correct answer is grounded in the direct instruction provided in the training segment [3-4]."* — contains `[3-4]` segment reference that trips `EXPLICIT_SEGMENT_ID_REFERENCE` |
| sourceSegmentIds | `[3, 4]` |
| questionType | `SINGLE_CHOICE` |

**Why the normaliser didn't fire** — exactly to spec:
- AQ rules only strip leading frames (`^According to...,\s+<WH>`).
- Qwen's output put "according to the training material" at the **END** of the stem, not the beginning. Mid-sentence content is OUT OF SCOPE for AQ by design.
- The AQ normaliser's narrow-scope guarantee held: no transform, no ambiguous rewrite.

**Why this is still a win**: AQ's forensic unknown is resolved. We now know empirically that Qwen's cross-run phrase placement varies (leading vs mid vs trailing). A future narrowly-scoped rule for trailing "...according to the training material?" is now designable against real data — no longer blind.

### 5. Sanitiser and grounding results

Per `shortfallReasonJson.perGroupDiagnostics[fa-1]`:

| gate | result |
|---|---|
| grounding | **PASS** (cited segments [3,4] both eligible, neither excluded) |
| AQ normalisation | **0 transforms** — mid-sentence framing out of scope by design |
| employee-facing text sanitiser | **FAIL** — `ACCORDING_TO_TRAINING_MATERIAL` (in stem) + `EXPLICIT_SEGMENT_ID_REFERENCE` (in explanation, `[3-4]`) |
| structural | not reached |
| dedup | not reached |
| **persistence** | **0** (pipeline blocked at sanitiser as designed) |

### 6. Final question count

**9 of 10** (5 checkpoint + 6 AK FA + 3 AN FA) — **unchanged**. AR produced zero new persisted drafts.

### 7. Incremental and cumulative estimated GPU cost

| source | ms | USD |
|---|---|---|
| Incremental AR | 16 059 | **≈ $0.00867** |
| Cumulative prior (Z + AG + AI + AK + AN + AO + AP) | — | ≈ $0.7373 |
| **Combined post-AR** | — | **≈ $0.7460 / $2 cap · 37% consumed · 63% headroom** |

Modal $10 account cap: ≈ $9.25 remaining · ≈ 93% headroom.

### 8. Preservation evidence

Via `test-results/4yar-post-fire-db.json`:

| aspect | status |
|---|---|
| 5 checkpoint hashes `24c26223e6d1 5d2863681508 e05878acffc1 084e91e008d1 fcf533481947` | byte-identical |
| 6 AK FA hashes `e479567ee290 01ff61464357 155890567d00 c855a6435458 f8ae54baa666 00054b4f30fa` | byte-identical |
| 3 AN FA hashes `7c428a0d126a 642496d444c2 008af536cb3d` | byte-identical |
| **Total live drafts: 14** | unchanged |
| `course.title` = "Employee Onboarding and Policies" | unchanged |
| **`course.aiMetadataAttributionAt` = `2026-11-10T20:42:51.040Z`** | **UNCHANGED (7th consecutive run across AG/AI/AJ/AK/AL/AN/AO/AP/AQ/AR)** |
| 0 drafts from AR run | ✓ |
| 0 promotions / completions | ✓ |
| `/api/health` | **HTTP 200** |
| **Admin retention endpoint** `GET /api/admin/ai-training/runs/cmwbij5rq0007mmqsxow0h9jv/rejected-proposals` | **HTTP 200** · `totalRetained=1` · `activeRetained=1` · returns the full raw proposal with original + normalised text |

### 9. Live staging screenshots

Captured at 1440×900 (`test-results/4yar-review-*.png`):

| file | contents |
|---|---|
| `4yar-review-default.png` | Course landing — title + description byte-identical |
| `4yar-review-fa-tab.png` | **Final assessment · 9** tab (unchanged from AN) — 9 questions navigable |
| `4yar-review-cp-tab.png` | **Checkpoints · 5** — chronological order preserved |

### 10. Remaining issues before manager editorial acceptance

**Primary blocker**: the single remaining FA question requires either:
- **Option A (narrow AQ rule extension)**: add trailing/mid-sentence "according to the training material" normalisation. Now has an evidence example (AR retained proposal). A follow-up offline-only slice (AS) could extend AQ with:
  - `TRAILING_FRAME_ACCORDING_TO_TRAINING_MATERIAL`: matches `\s+according to (?:the )?training materials?\s*(?=[?.!]?$)`
  - Or a stem-end sanitiser-aware stripping that preserves the `?` punctuation.
  - Strip the `[3-4]` segment reference from the EXPLANATION (not just the stem) — currently AQ is stem-only.
- **Option B (one more GPU retry under R1)**: fire another $0.01 call once AS-equivalent rules are live. 63% pilot-budget headroom.
- **Option C (manager inline-edit of the retained proposal)**: the retained text is a good question — manager could manually promote it after stripping "according to the training material" and the segment reference. The retention endpoint surfaces the full content for this exact workflow.
- **Option D (accept 9/10 baseline)**: no further GPU work, no further offline work. $0.

**No automatic approval, publication, or manager acceptance performed** — all four options require fresh founder authorisation.

---

## Staging deploy summary

| aspect | value |
|---|---|
| DRH-1 runs | Initial `42944956251` (headBranch=main, worker steps skipped) · **Corrected dispatch `42946776197` (`--ref` flag, headBranch=branch, worker deployed)** |
| Rollback anchor | `sha-921f72efaa08` (Fly web v1150 — AQ baseline) · worker v384 (AP) |
| New release | Fly web **v1152** · worker **v385** · both `sha-bca3ac4886d1` |
| `/api/health` | HTTP 200 |
| Migration | None |
| Preservation post-deploy + post-fire | 14/14 drafts intact · metadata unchanged (7th consecutive) |

DRH-1 anomaly noted: the default `gh workflow run -f ref=<branch>` dispatch uses main's workflow definition (where the worker-build steps don't exist). The correct invocation is `gh workflow run <name> --ref <branch> -f ref=<branch>`. Memorialising this for future deploys with worker-code changes.

---

## STOP

Per directive §9 final line. The retention mechanism closed the forensic gap — we now have the full rejected proposal text for the first time. **FA remains at 9 of 10 pending founder decision on A/B/C/D.**
