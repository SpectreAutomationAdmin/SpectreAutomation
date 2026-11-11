# EP-TRAIN-4Y-AS — Tenth Question Recovered Through Manager Editorial Workflow — Report

**Status**: ✅ **10 / 10 FINAL ASSESSMENT ACHIEVED** · **ZERO GPU** · recovered through the authorised manager editing workflow built on the AR retained proposal · 14 existing hashes + metadata preserved (8th consecutive run) · 0 auto-approval, 0 auto-publication.

**Boundaries honoured**: staging only · no production · **no GPU inference** · no existing-draft mutation · tenant-scoped · audited · 126 WIP + stash `49c2af3d` intact.

Per directive final line: **STOP after staging verification. No further GPU generation.**

---

## §9 — Final 10-item report

### 1. Full retained proposal and exact validation findings

Retrieved from `GET /api/admin/ai-training/runs/cmwbij5rq0007mmqsxow0h9jv/rejected-proposals`:

| field | value |
|---|---|
| **originalQuestionText** (STEM) | *"How can an employee access their pay stubs according to the training material?"* |
| **options** | A ✓ *"By using the last four digits of their SIN number"* · B *"By calling the HR department"* · C *"By logging into the company's online portal"* · D *"By visiting the physical HR office"* |
| **originalExplanation** | *"Employees can access their pay stubs by using the last four digits of their SIN number, as stated in the training material. … The correct answer is grounded in the direct instruction provided in the **the training segment [3-4]**."* |
| **sourceSegmentIds** | `[3, 4]` |
| **questionType** | `SINGLE_CHOICE` |
| **normalisationTransforms** | `[]` (AQ correctly declined — framing is mid-sentence, out of AQ's leading-only scope) |
| **rejectionStage** | `SANITISER` |
| **findingCodes** | `ACCORDING_TO_TRAINING_MATERIAL,EXPLICIT_SEGMENT_ID_REFERENCE` |

**Exact field locations**:
- `ACCORDING_TO_TRAINING_MATERIAL` → in the **STEM** at the tail position (`"...pay stubs **according to the training material**?"`).
- `EXPLICIT_SEGMENT_ID_REFERENCE` → in the **EXPLANATION** last sentence (`"...the training segment [3-4]."`).

The stem was NOT the only invalid field — the explanation also leaked a segment reference. Per directive §1, both are documented.

### 2. Original versus manager-edited content

| field | original | manager-edited |
|---|---|---|
| stem | *"How can an employee access their pay stubs according to the training material?"* | *"How can employees access their pay stubs?"* |
| option A (correct) | "By using the last four digits of their SIN number" | **UNCHANGED** |
| option B | "By calling the HR department" | **UNCHANGED** |
| option C | "By logging into the company's online portal" | **UNCHANGED** |
| option D | "By visiting the physical HR office" | **UNCHANGED** |
| explanation | contains `"as stated in the training material"` (×2) + `"the training segment [3-4]"` | *"Employees access their pay stubs by using the last four digits of their SIN number. An email notification arrives on each payday, and the last four SIN digits serve as the quick, secure identifier that lets them open the statement. The remaining options describe alternative methods not covered in the onboarding video."* |
| sourceSegmentIds | [3, 4] | **UNCHANGED** |
| questionType | SINGLE_CHOICE | **UNCHANGED** |

Correct-answer identity preserved (option A, "last four digits of SIN"). Grounding unchanged. Factual claim unchanged. Narrow editorial correction only.

### 3. Recovery workflow implementation

Module: [src/lib/hr/training/generation/rejected-proposal-recovery.ts](src/lib/hr/training/generation/rejected-proposal-recovery.ts)

Pipeline steps (per directive §2.1-§2.9):

| step | directive | implementation |
|---|---|---|
| 1 | Load original retained candidate | `shortfallReasonJson.perGroupDiagnostics[g].rejectedProposals[i]` |
| 2 | Display validation findings | `retained-proposals-reader` + plain-English copy on `ManagerReviewClient.RejectedCandidatesCard` |
| 3 | Permit editing of stem / options / explanation | `CorrectionDialog` inline form |
| 4 | Preserve original as immutable provenance | retained record NEVER mutated — contract-tested in §6.3 |
| 5 | Store manager edits as distinct audited revision | `recoveryHistory[]` + `auditLog("hr.training.ai-rejected-proposal.recovered")` |
| 6 | Revalidate with existing validators | normaliser → sanitiser → structural (unchanged modules) |
| 7 | Check grounding against original eligible segments | sourceSegmentIds reused from retained record; GROUNDING-stage recovery REFUSED |
| 8 | Cross-assessment dedup against all existing drafts | `evaluateAgainstPriors` against every live draft for the version |
| 9 | Persist corrected candidate only after validation passes | `TrainingQuestionAiDraft.create(state=REQUIRES_HUMAN_REVIEW)` — gated by all above |

Endpoint: [POST /api/admin/ai-training/runs/[runId]/recover-rejected-proposal](src/app/api/admin/ai-training/runs/[runId]/recover-rejected-proposal/route.ts) — auth (`hr:training:write`) + tenant scope + input coercion + delegation to service.

Manager UX: [ManagerReviewClient.tsx](src/app/app/admin/people/safety-training/[courseId]/[versionId]/review/ManagerReviewClient.tsx) — a muted amber *"Needs correction · N"* card renders above the existing mode tabs when retained candidates exist. Not a new page. Managers see plain English ("References the training material by name — write the question as if speaking to the employee directly"), not raw rule codes.

### 4. Audit and authorization evidence

```json
{
  "id": "cmwbl6amf0009107l0hzr0tqe",
  "action": "hr.training.ai-rejected-proposal.recovered",
  "entityType": "TrainingQuestionAiDraft",
  "entityId": "cmwbl6aic0007107lhfo4n0wl",
  "userId": "cmrvdenz700034437agp7gqs5",
  "createdAt": "2026-11-11T03:55:38.439Z",
  "beforeJson": {
    "runId": "cmwbij5rq0007mmqsxow0h9jv",
    "groupId": "fa-1",
    "proposalIndex": 0,
    "originalQuestionText": "How can an employee access their pay stubs according to the training material?",
    "originalFindingCodes": "ACCORDING_TO_TRAINING_MATERIAL,EXPLICIT_SEGMENT_ID_REFERENCE"
  },
  "afterJson": {
    "draftId": "cmwbl6aic0007107lhfo4n0wl",
    "contentHash": "b4d2ed9ffdf8a184ee0d7fdab7e67aaeebf042e7bbae35db6f9a01570f40f304",
    "editedQuestionText": "How can employees access their pay stubs?"
  },
  "metaJson": {
    "rejectionStage": "SANITISER",
    "sourceSegmentIds": [3, 4],
    "dedupVerdict": "DISTINCT",
    "normalisationApplied": 0
  }
}
```

Also captured in `recoveryHistory[]` on the retained record:

```json
{
  "savedAt": "2026-11-11T03:55:38.408Z",
  "savedByUserId": "cmrvdenz700034437agp7gqs5",
  "savedAsDraftId": "cmwbl6aic0007107lhfo4n0wl",
  "groupId": "fa-1",
  "editedStem": "How can employees access their pay stubs?"
}
```

Authorisation: `hr:training:write` enforced in the service (`hasPermission` gate at the top) BEFORE any DB read. Cross-tenant rejection: `RUN_NOT_FOUND` (indistinguishable from a true 404).

### 5. Full validation results

| validator | input | result |
|---|---|---|
| **Normaliser** | edited stem | `appliedTransforms=[]`, refusedForSafety=false, PASS |
| **Employee-facing text sanitiser** | edited stem + options + explanation | **PASS** (no findings — the forbidden phrases were removed cleanly) |
| **Structural validator** | edited stem + options | **PASS** |
| **Correct-answer integrity** | edited options vs original | **PASS** (option A text unchanged) |
| **Grounding** | sourceSegmentIds [3,4] | **PASS** (same segments as original retained — guaranteed eligible by prior grounding gate) |
| **Cross-assessment dedup** | edited stem vs all 14 existing drafts | **DISTINCT** (verdict = `DISTINCT`, KEPT) |
| **Idempotency** | content hash on first save | new draft (idempotent=false, next save with same hash would return existing id) |

Full HTTP response:
```json
{
  "ok": true,
  "newDraftId": "cmwbl6aic0007107lhfo4n0wl",
  "newContentHash": "b4d2ed9ffdf8a184ee0d7fdab7e67aaeebf042e7bbae35db6f9a01570f40f304",
  "groupId": "fa-1",
  "idempotent": false,
  "validation": {
    "sanitiser": "PASS",
    "structural": "PASS",
    "normalisationApplied": 0,
    "grounding": "PASS",
    "dedup": "KEPT"
  }
}
```

### 6. Final question count

**15 / 15** total live drafts.
- **Checkpoints · 5** (unchanged)
- **Final Assessment · 10** (6 AK + 3 AN + **1 AS-recovered** = 10)

Reached WITHOUT any new GPU inference.

### 7. Preservation hashes

| aspect | status |
|---|---|
| 5 checkpoint hashes `24c26223e6d1 5d2863681508 e05878acffc1 084e91e008d1 fcf533481947` | byte-identical |
| 6 AK FA hashes `e479567ee290 01ff61464357 155890567d00 c855a6435458 f8ae54baa666 00054b4f30fa` | byte-identical |
| 3 AN FA hashes `7c428a0d126a 642496d444c2 008af536cb3d` | byte-identical |
| **1 AS FA hash** `b4d2ed9ffdf8` | new — the recovered 10th question |
| `course.title` = "Employee Onboarding and Policies" | unchanged |
| `course.aiMetadataAttributionAt` = `2026-11-10T20:42:51.040Z` | **unchanged — 8th consecutive preservation run** (AG/AI/AJ/AK/AL/AN/AO/AP/AQ/AR/AS) |
| completions | 0 |
| promotions | 0 |

### 8. Deployment integrity verification

**DRH-1 `--ref` anomaly PERMANENTLY DOCUMENTED and applied:**

| run | invocation | headBranch resolved | worker steps | worker SHA |
|---|---|---|---|---|
| AQ (`42943297802`) | `-f ref=<branch>` only | `main` (wrong) | skipped | stayed at AP v384 |
| AR initial (`42944956251`) | `-f ref=<branch>` only | `main` (wrong) | skipped | stayed at AP v384 |
| AR corrected (`42946776197`) | **`--ref <branch> -f ref=<branch>`** | **`branch`** (right) | ran | advanced to v385 |
| **AS (`42954452034`)** | **`--ref <branch> -f ref=<branch>`** | **`branch`** (right) | **ran** | **v386 sha-12cfe415bd08** |

**AS live deploy state:**

| aspect | value |
|---|---|
| Fly web | **v1153 · `sha-12cfe415bd08`** |
| Fly worker | **v386 · `sha-12cfe415bd08`** (same SHA — web + worker aligned, per WI-SYNC-1b invariant) |
| Rollback anchor | `sha-bca3ac4886d1` (web v1152 / worker v385 — AR baseline) |
| `/api/health` | HTTP 200 |
| Migration | None |

The deployment integrity requirement is satisfied: the worker IS running the AS code (which includes AR retention + AQ normaliser + the AS recovery service). This was verified by SHA inspection on both the web and worker apps post-deploy.

### 9. Staging screenshots

Captured at 1440×900 (`test-results/4yas-review-*.png`):

| file | contents |
|---|---|
| `4yas-review-default.png` | Course landing post-correction |
| `4yas-review-fa-tab.png` | **Final assessment · 10** — the recovered question is navigable |
| `4yas-review-cp-tab.png` | Checkpoints · 5 (unchanged) |
| `4yas-review-after-refresh.png` | After a browser reload — persistence verified (the recovered question remains) |

### 10. Remaining editorial issues before promotion

The new draft `cmwbl6aic0007107lhfo4n0wl` is in `REQUIRES_HUMAN_REVIEW` state — **no automatic promotion or approval**. The directive §7 requirement "verify no automatic approval or publication" is met.

Items for a future founder-approved promotion pass:
- **Reviewer-pass**: The usual separation-of-duties flow still applies — a reviewer with `hr:training:ai:approve` (distinct from the `hr:training:write` author) must approve the draft before it can be promoted.
- **Publication**: distinct from approval; needs `hr:training:publish` and is the founder's decision for the course lifecycle.

Nothing in AS bypasses, weakens, or short-circuits those gates.

---

## Offline + cross-regression results

- `tests/ep-train-4y-as-recovery.test.ts` — **10/10 PASS** (correct-answer integrity, plain-English copy isolation, service-surface shape, endpoint input coercion, no retrospective mutation)
- Cross-regression suite (AA sanitizer + AE structure + AO dedup + AP focused + AQ normaliser + AR retention + AS recovery) — **91/91 PASS**
- `npx tsc --noEmit` on all AS-touched files — **CLEAN**

---

## STOP

Per directive final line. The slice is complete:

- The retention mechanism closed the forensic gap (AR).
- The manager editing workflow turned the retained proposal into a valid 10th draft without GPU (AS).
- The full validation pipeline ran unchanged — no bypass, no weakening, no auto-approval.
- The 14 existing hashes + course metadata are byte-identical.
- The `--ref` dispatch fix is documented and applied so future worker code changes deploy correctly.

**Final Assessment · 10. Checkpoints · 5.** Awaiting reviewer / promotion / publication decisions on the new draft in the normal lifecycle.
