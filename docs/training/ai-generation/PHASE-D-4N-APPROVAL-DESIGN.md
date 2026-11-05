# EP-TRAIN-6D-4N — Human-Verified Answer & Server-Authoritative Approval Governance

**Status:** Offline implementation DELIVERED on branch `ep-train-6d-4n/human-verification-approval` (based on accepted 4M commit `875b68fe`). No staging or production touched. Awaiting founder acceptance.

**Scope:** server-authoritative approval service + API route + verified-answer resolver + UI presentation. **No schema change** — the preflight confirmed the 4B lifecycle + 4K `verifiedCorrectAnswerSnapshotJson` + 4L ingestion canonical hash + 4M evidence reader fully support the approval contract.

**Companion:** [PHASE-D-4N-ACCEPTANCE.md](PHASE-D-4N-ACCEPTANCE.md).

---

## 1. Preflight — schema sufficiency

Per directive §3, before implementation I audited:

| Existing component | Role in 4N | 4N dependency satisfied? |
|---|---|---|
| 4B `evaluateApprovalServerSide` (approval-guard.ts) | 12 of 17 refusal reasons already encoded (`DRAFT_NOT_FOUND`, `CROSS_TENANT`, `REVIEWER_LACKS_PERMISSION`, `CONTENT_HASH_MISMATCH`, `CONCURRENT_MODIFICATION`, `VALIDATION_MISSING`, `VALIDATION_SOURCE_INVALID`, `CANDIDATE_REJECTED`, `UNRESOLVED_HARD_ERRORS`, `SOURCE_VERSION_CHANGED`, `STATE_NOT_APPROVABLE`, `VALIDATION_SERVICE_UNAVAILABLE`) | ✅ Composed verbatim — 4N doesn't weaken the guard. |
| 4B `writeStateTransition` (transactional-audit.ts) | Atomic state move + append-only `TrainingQuestionAiStateTransition` row + optimistic concurrency | ✅ Composed verbatim — the authoritative lifecycle record is still the transition row. |
| 4B `TrainingQuestionAiOperationKey` | Idempotency with 24-hour TTL and a DB-level unique index `(route, requestKey, reviewerUserId, draftId)` | ✅ Used for the approve route's idempotency key. |
| 4B `TrainingQuestionAiReview` | Reviewer disposition + note + draftContentHash + validationId binding | ✅ Appended on approval. |
| 4K `verifiedCorrectAnswerSnapshotJson` | Nullable column on `TrainingQuestionAiValidation`; 4K established the shape | ✅ Written only from this slice; 4L never touches it; 4M never reads it as authoritative. |
| 4L canonical-hash helpers (`content-hash.ts` `canonicalise` + `sha256Hex`) | Request-payload fingerprinting + draft content hashing | ✅ Reused. |
| 4M `resolveCandidateEvidence` | Evidence presentation + integrity signals | ✅ Unchanged — 4N adds a sibling `resolveVerifiedAnswer` with its own integrity checks for the approval decision chain. |

**Conclusion:** no schema change required. **No tables, no columns, no indexes, no migrations added.** The directive's §3 "do not silently add tables or columns" instruction is honoured by design.

---

## 2. Approval contract

### 2.1 Request shape

`ApprovalRequestInput` (type-safe at the service boundary + API-layer coerced):

| Field | Required | Validation |
|---|---|---|
| `draftId` | yes | non-empty string |
| `expectedRecordVersion` | yes | non-negative integer |
| `expectedContentHash` | yes | 64-char lowercase hex |
| `expectedValidationId` | yes | non-empty string |
| `verifiedCorrectAnswerIndex` | yes | integer; `NaN` → `VERIFIED_ANSWER_MISSING` (400) |
| `expectedOptionText` | optional (belt-and-braces) | if present, must byte-exact match the server-derived option text |
| `evidenceAttestation` | yes | **must be `true`** or `EVIDENCE_ATTESTATION_MISSING` (400) |
| `idempotencyKey` | yes | UUID v4 shape |
| `reviewerNote` | optional | ≤ 2000 chars |

The server NEVER trusts the browser's displayed answer text. The verified index is used ONLY as an offset into the stored, immutable `draftJson.options[]`, which is content-hash-locked by the 4B `contentHash` invariant.

### 2.2 The 17 rejection rules (directive §6)

| # | Directive rule | Where enforced | Rejection code | HTTP |
|---|---|---|---|---|
| 1 | Missing verified answer | `approval-service.ts` pre-tx | `VERIFIED_ANSWER_MISSING` | 400 |
| 2 | Out-of-range index | pre-tx + inside tx (after option array is loaded) | `VERIFIED_ANSWER_OUT_OF_RANGE` | 400 |
| 3 | Text / option mismatch | inside tx (after server-derivation) | `VERIFIED_ANSWER_TEXT_MISMATCH` | 409 |
| 4 | Invalid question type | inside tx | `QUESTION_TYPE_INVALID` | 409 |
| 4b | Answer cardinality invalid (MULTI_ANSWER, TRUE_FALSE≠2 options, SINGLE_CHOICE<2 or >8) | inside tx | `ANSWER_CARDINALITY_INVALID` | 409 |
| 5 | Stale `recordVersion` | 4B guard (`CONCURRENT_MODIFICATION`) | `APPROVAL_GUARD_BLOCKED` | 409 |
| 6 | Stale content hash | 4B guard (`CONTENT_HASH_MISMATCH`) | `APPROVAL_GUARD_BLOCKED` | 409 |
| 7 | Validation tied to a different draft hash | pre-guard binding assertion | `VALIDATION_MISMATCH` | 409 |
| 8 | Missing validation | 4B guard (`VALIDATION_MISSING`) | `APPROVAL_GUARD_BLOCKED` | 409 |
| 9 | Hard validation errors | 4B guard (`UNRESOLVED_HARD_ERRORS`) | `APPROVAL_GUARD_BLOCKED` | 409 |
| 10 | Rejected draft | 4B guard (`CANDIDATE_REJECTED`) | `APPROVAL_GUARD_BLOCKED` | 409 |
| 11 | Superseded draft | 4B guard (`STATE_NOT_APPROVABLE`, since superseded drafts are in a non-approvable state) | `APPROVAL_GUARD_BLOCKED` | 409 |
| 12 | Fixture-sourced validation | 4B guard (`VALIDATION_SOURCE_INVALID`) | `APPROVAL_GUARD_BLOCKED` | 409 |
| 13 | Cross-tenant | 4B guard (`CROSS_TENANT` → 404 same-shape) | `APPROVAL_GUARD_BLOCKED` | 404 |
| 14 | Unauthorized reviewer | 4B guard (`REVIEWER_LACKS_PERMISSION` → 403) | `APPROVAL_GUARD_BLOCKED` | 403 (API route re-maps to 404 same-shape per directive §4) |
| 15 | Missing / inconsistent evidence (attestation missing) | pre-tx | `EVIDENCE_ATTESTATION_MISSING` | 400 |
| 16 | Replayed idempotency key with different payload | pre-tx cache + P2002 recovery | `IDEMPOTENCY_CONFLICT` | 409 |
| 17 | Unsupported lifecycle transition | 4B guard (`STATE_NOT_APPROVABLE`) + 4B `writeStateTransition` (`TRANSITION_BLOCKED`) | `APPROVAL_GUARD_BLOCKED` / `TRANSITION_BLOCKED` | 409 |

Service-unavailable: `VALIDATION_SERVICE_UNAVAILABLE` → 503 if the caller injects `opts.validationServiceHealthy: false`.

**The 4B guard is NOT weakened.** 4N composes it and adds 4N-specific pre-tx + tx-internal checks.

### 2.3 MULTI_ANSWER refusal

Per directive §5: *"For multi-answer questions, do not silently apply a single-index contract that cannot represent the correct answer set. Either implement an explicitly validated multi-index contract or refuse multi-answer approval pending a separately accepted extension."*

4N refuses with `ANSWER_CARDINALITY_INVALID` and logs the requirement for a later multi-index extension slice. The refusal is unit-tested.

### 2.4 Historical candidate policy (directive §7)

The eight 6D-4H candidates all have:
- `groundingProjectionSha256` of the form `fixture-<label>` (not a real SHA-256).
- `groundingProjectionId` = NULL (no 4K projection row exists).
- A validation row with `validatorSource = "fixture"`.
- Verdicts in `{REQUIRES_HUMAN_VERIFICATION, REJECTED}`.

For these drafts, the 4B guard's `VALIDATION_SOURCE_INVALID` check refuses approval. 4N does NOT weaken this. 4N does NOT backfill, fabricate evidence, modify generated content, or apply a shortcut. If the founder authorises a historical-evidence backfill in a future slice (4O), that slice must:

1. Produce real `TrainingGroundingProjection` rows with real SHA-256 hashes.
2. Re-validate the historical content through the integrated pipeline to produce a non-fixture validation row.
3. Only then may approval proceed through 4N without modification.

---

## 3. Atomic approval transaction

The entire mutation runs inside ONE Prisma `$transaction`:

```
BEGIN
  SELECT TrainingQuestionAiDraft WHERE id=? AND clubId=?
  SELECT TrainingQuestionAiValidation WHERE id=?
  SELECT TrainingCourseVersion WHERE id=?
  evaluateApprovalServerSide(...)
  THROW if blocked

  parseDraftJsonStrict → options[]
  CHECK questionType, cardinality, index bounds, expectedOptionText

  UPDATE TrainingQuestionAiValidation
      SET verifiedCorrectAnswerSnapshotJson = <snapshot>
  INSERT TrainingQuestionAiReview (disposition: "APPROVED", ...)

  writeStateTransition(...)                     — 4B helper
    UPDATE TrainingQuestionAiDraft
        WHERE recordVersion = expected
        SET state = "APPROVED_DRAFT", recordVersion = expected + 1
    (count=0 → THROW CONCURRENT_MODIFICATION)
    INSERT TrainingQuestionAiStateTransition

  INSERT TrainingQuestionAiOperationKey (DB unique index serialises races)
COMMIT
```

Post-commit:
- `audit()` emits `training.ai.question.verified-correct.recorded` (non-blocking, CLAUDE.md pattern).
- Audit payload includes `draftId`, `reviewId`, `transitionId`, `validationId`, `verifiedCorrectAnswerIndex`, `verifiedByUserId`, `verifiedAt`, `recordVersionAfter`. **No credentials, no tokens, no secret-bearing metadata.**

Any failure inside the transaction rolls back EVERY mutation — verified by the SQLite contract test "rollback — a stale recordVersion leaves zero rows".

---

## 4. Idempotency

### 4.1 Replay with same payload

Pre-transaction cache-lookup: `findUnique` on the operation-key composite index. If a row exists AND its `__payloadFingerprint` matches the current request's fingerprint, the cached response is returned verbatim with `replay: true`. **No mutation, no transaction, no audit emission on replay.**

Payload fingerprint = SHA-256 of the canonical JSON of:
```
{ draftId, expectedContentHash, expectedValidationId, expectedRecordVersion,
  verifiedCorrectAnswerIndex, expectedOptionText, evidenceAttestation }
```

(The idempotency key itself and the reviewer note are deliberately excluded — the key IS the identity; the note is narrative.)

### 4.2 Replay with different payload

Same key + different fingerprint → `IDEMPOTENCY_CONFLICT` (409). The approval does not proceed. Mutation guarantee: exactly one authoritative approval per idempotency key per `(route, requestKey, reviewerUserId, draftId)` tuple.

### 4.3 Concurrent-race recovery

If two requests with the same key + same payload race:
- Both execute their pre-cache lookups simultaneously → both see no cached row → both enter their transactions.
- Both attempt to insert the operation-key row at commit time.
- One commits; the other hits Prisma `P2002` on the unique index.
- The service catches `P2002`, re-reads the cached row, and:
  - if the cached fingerprint matches, returns the cached response with `replay: true`;
  - if the cached fingerprint differs, raises `IDEMPOTENCY_CONFLICT`.

If two requests with the same key + DIFFERENT payloads race, the loser may surface EITHER `IDEMPOTENCY_CONFLICT` OR `TRANSITION_BLOCKED` (optimistic concurrency on the draft's `recordVersion`). Both outcomes guarantee: no duplicate approval row persists.

---

## 5. Verified-answer snapshot

### 5.1 Shape

```json
{
  "schemaVersion": "verified-correct-answer-snapshot-v1",
  "optionIndex": <number>,
  "optionText": <server-derived string>,
  "verifiedByUserId": <principal.id>,
  "verifiedAt": <ISO-8601>,
  "draftContentHash": <draft.contentHash>,
  "validationId": <validation.id>
}
```

### 5.2 Writing invariants

- Written by 4N ONLY. Never by 4L (transcription ingest), never by 4M (reader), never by any other code path.
- `draftContentHash` binds the snapshot to the exact immutable draft.
- `validationId` binds the snapshot to the exact validation row.
- The snapshot is written INSIDE the same transaction as the lifecycle transition.

### 5.3 Reading invariants (directive §10)

`resolveVerifiedAnswer` performs SIX checks before returning `kind: "verified"`:

1. **Lifecycle eligibility** — draft state in `{APPROVED_DRAFT, ARCHIVED}`. Otherwise `unverified`.
2. **APPROVED review exists** — a `TrainingQuestionAiReview` with `disposition = "APPROVED"`. Otherwise `integrity-warning: APPROVAL_LIFECYCLE_INELIGIBLE`.
3. **Review hash binding** — `review.draftContentHash == draft.contentHash` (current). Otherwise `integrity-warning: SNAPSHOT_HASH_BINDING_STALE`.
4. **Validation + snapshot present** — `review.validation.verifiedCorrectAnswerSnapshotJson` non-null. Otherwise `integrity-warning: SNAPSHOT_VALIDATION_BINDING_STALE`.
5. **Snapshot shape + internal bindings** — snapshot JSON parses + has all required fields + `snapshot.draftContentHash == draft.contentHash` + `snapshot.validationId == review.validation.id`. Otherwise `integrity-warning` with the matching code.
6. **Option text + index** — `optionIndex < options.length` AND `options[optionIndex].text == snapshot.optionText`. Otherwise `integrity-warning: SNAPSHOT_OPTION_MISMATCH`.

**A snapshot alone is not enough.** The reader must confirm every one of the six bindings.

If any check fails, the UI renders the answer as unverified AND surfaces the `integrity-warning` banner with the safe diagnostic + opaque code. **No raw hash is leaked into the banner.**

---

## 6. UI behaviour

### 6.1 Approval states

| Draft state × verifiedAnswer resolution | Answer-choice styling |
|---|---|
| Any state, `kind: "unverified"` | All options stone-neutral. Model-selected chip on model's pick. |
| Any state, `kind: "integrity-warning"` | All options stone-neutral + integrity warning banner above options. |
| `APPROVED_DRAFT` / `ARCHIVED`, `kind: "verified"` | Exactly ONE option emerald with "Verified correct" label. Reviewer name in the preamble. Model-selected chip preserved on any OTHER model-picked option. |

### 6.2 Disagreement surfacing

When the reviewer verified a DIFFERENT index than the model's prediction, a note below the options reads:

> *"Note: the reviewer verified a different answer than the model's original prediction. The model's selection is shown above as 'Model-selected · unverified' for comparison."*

This surfaces the disagreement to subsequent viewers without treating it as a failure of the reviewer. (Directive §10: *"Make disagreement between the model and reviewer visible without treating it as a failure of the reviewer."*)

### 6.3 Approval UI controls

4N does NOT enable interactive approval buttons in the UI. The existing read-only guard (4B / 6D-3) that labels the "Approve" / "Edit" / "Reject" / "Revalidate" / "Request regeneration" buttons remains unchanged — all are rendered `disabled`.

This is deliberate. Per directive §10: *"Approval UI controls may be implemented for authorized users, but must remain disabled for unauthorized roles."* The current state satisfies the "disabled for unauthorized" half. Enabling the controls for an authorised reviewer AND wiring them to call the 4N API route requires a separately-authorised UX slice that designs:

- A cross-check prompt (reviewer confirms they reviewed the evidence → populates `evidenceAttestation: true`).
- A radio selector that captures `verifiedCorrectAnswerIndex`.
- A disabled-button state while the request is in-flight.
- Error-banner rendering for each of the 17 rejection codes.
- Success state with a transition to the approved view.

4N's API + service are fully ready for that UX slice to call them.

### 6.4 Publication controls

Explicitly NOT added. Approval = `APPROVED_DRAFT` lifecycle state, which is distinct from publication. Publication is a separately-authorised slice.

---

## 7. Permission model

- Permission: existing `hr:training:ai:approve`.
- Roles that hold it today: SUPER_ADMIN only (via `isSuperAdmin()` shortcut).
- CLUB_ADMIN: retains read-only via `hr:training:ai:read` (4G policy). Does NOT gain approve.
- Unauthorised approval attempts:
  - Null principal → `UnauthenticatedError` (401).
  - Authenticated but missing permission → `REVIEWER_LACKS_PERMISSION` → 403 at the guard; the API route maps to 404 same-shape per directive §4.
- Cross-tenant → 404 same-shape at the guard.
- SUPER_ADMIN's existing bypass is acknowledged: the permission check passes for SUPER_ADMIN, but the guard still enforces lifecycle, validation, evidence, and concurrency checks on SUPER_ADMIN just like any other principal. Verified by the "SUPER_ADMIN subject to validation gates" PG test.

**No new role grants.** The directive's "no new role grants" instruction is honoured.

---

## 8. Test evidence

### 8.1 SQLite contract — 23/23 PASS

[tests/ep-train-6d4n-approval-contract.test.ts](../../../tests/ep-train-6d4n-approval-contract.test.ts). Covers:

- Happy path with reviewer selecting a DIFFERENT index than the model.
- 17 rejection rules (all directive §6 rows exercised).
- Idempotency replay (same payload) + conflict (different payload).
- Lifecycle refusal on REJECTED-state drafts.
- Atomic rollback: a pre-approval refusal leaves zero review / transition / snapshot rows.
- UUID v4 shape enforcement on idempotency keys.
- Reviewer-note length cap (2000 chars).

### 8.2 jsdom UI contract — 6/6 PASS

[tests/ep-train-6d4n-workspace-ui.test.tsx](../../../tests/ep-train-6d4n-workspace-ui.test.tsx). Covers:

- Unverified rendering: all stone, no emerald, model-selected chip.
- Verified rendering: exactly one emerald option with reviewer name.
- Disagreement visible: both "Model-selected · unverified" AND "Verified correct" labels present + the explanatory note.
- Integrity-warning banner renders on failed-integrity state + options stay neutral.
- No enabled mutation buttons.
- Three-column layout preserved regardless of verified-answer resolution.

### 8.3 Disposable Postgres 16 harness — 6/6 PASS

`scratchpad/ep-train-6d4n/integration-test.ts`. Covers:

- Full atomic approval end-to-end on real PG.
- Concurrent identical approvals (3× `Promise.allSettled`) → exactly 1 creator, no duplicate state transitions.
- Concurrent CONFLICTING approvals (same key, different index) → 1 creator; loser raises `IDEMPOTENCY_CONFLICT` OR `TRANSITION_BLOCKED` (both acceptable; both prevent duplicate approval rows).
- Cross-tenant 404 same-shape.
- SUPER_ADMIN still subject to validation gates (REJECTED verdict refused).
- Verified snapshot shape + credential-free transition meta.

Captured output: `scratchpad/ep-train-6d4n/integration-test-output.txt`.

### 8.4 Full 4B → 4N targeted regression — 151/151 PASS

```
tests/ep-train-6d4b-ai-review-governance.test.ts
tests/ep-train-6d4d-read-service-contract.test.ts
tests/ep-train-6d4d-real-db-integration.test.ts
tests/ep-train-6d4l-transcription-ingest-contract.test.ts
tests/ep-train-6d4m-evidence-reader-contract.test.ts
tests/ep-train-6d4m-workspace-ui.test.tsx
tests/ep-train-6d4n-approval-contract.test.ts
tests/ep-train-6d4n-workspace-ui.test.tsx
tests/training-ai-generation-grounding.test.ts
```

All 151 pass. No regressions.

### 8.5 Prisma + typecheck

- `npx prisma validate` → both schemas valid (4N makes no schema change).
- `npx tsc --noEmit` → zero 4N-attributable errors.

### 8.6 Nav audit — not applicable

`npm run nav:audit` applies to new user-facing routes. 4N adds a POST API route, not a page. The existing `/app/admin/ai-training/review/persisted` page is the only reader surface and is already covered by the 4D audit allow-list.

---

## 9. 5-status report

Per directive §12. Each line is MUTUALLY EXCLUSIVE; do not conflate.

| Status | 4N value |
|---|---|
| Technically implemented | ✅ YES — service, API route, verified-answer resolver, UI presentation. |
| Tested against disposable PostgreSQL | ✅ YES — 6-scenario harness PASS including concurrency + atomic rollback. |
| Deployed to staging | ❌ NO. Directive §13 forbids. |
| Visually accepted | ❌ NO. Live screenshot requires authenticated staging session + seeded real evidence; same deferral as 4M §4.6. |
| Enabled for real managers | ❌ NO. The approval route is implemented but NO UI button triggers it. Enabling requires a separately-authorised reviewer-UX slice (see §6.3). |

---

## 10. Outstanding blockers + next slice recommendation

### 10.1 Outstanding blockers

None. 4N is complete as a server-authoritative approval boundary with full test coverage.

### 10.2 Recommended next slice

**Slice 4P (or renamed per founder preference): Interactive reviewer UX for AI-training approval.**

Scope:

1. Enable the "Approve" button in `PersistedReviewWorkspace.tsx` when the principal holds `hr:training:ai:approve`. The button remains disabled when:
   - the principal lacks the permission (directive §10), or
   - the draft's lifecycle state is not `REQUIRES_HUMAN_REVIEW`, or
   - the draft's latest validation is `REJECTED` / fixture-sourced.
2. Add an approval dialog that collects:
   - `verifiedCorrectAnswerIndex` via a radio selector showing the draft's options.
   - `evidenceAttestation` via an explicit checkbox labelled *"I reviewed the source evidence for this candidate."*
   - Optional `reviewerNote`.
3. On submit, call `POST /api/admin/ai-training/drafts/[id]/approve` with the gathered inputs + a client-generated UUID v4 idempotency key.
4. Render each of 4N's 17 rejection codes as a reviewer-readable error.
5. On success, transition the detail pane to the "Verified correct" rendering (already implemented by 4N).

Slice 4P requires separate founder authorisation. Do not initiate.

**Alternative next slice (parallel path): 4O historical-evidence backfill.** The eight 6D-4H candidates cannot be approved through 4N today (fixture-source validation refused by the 4B guard). A backfill slice would produce real projections + a re-validation pass, after which the historical candidates become approvable through the standard 4N pipeline. 4O is deferred per 4L / 4M acceptance and remains optional.

---

## 11. Files touched by this slice

| Path | Change |
|---|---|
| `src/lib/hr/training/ai-review/approval-service.ts` | NEW — atomic approval service |
| `src/lib/hr/training/ai-review/verified-answer-reader.ts` | NEW — integrity-checked verified-answer resolver |
| `src/app/api/admin/ai-training/drafts/[id]/approve/route.ts` | NEW — POST approval route |
| `src/app/app/admin/ai-training/review/persisted/page.tsx` | modified — calls `resolveVerifiedAnswer`, passes new `verifiedAnswer` prop |
| `src/components/ai-training/PersistedReviewWorkspace.tsx` | modified — added `verifiedAnswer` prop, emerald rendering for the ONE verified option + "Model-selected · unverified" chip for OTHERS + disagreement note + integrity-warning banner |
| `tests/ep-train-6d4n-approval-contract.test.ts` | NEW — 23 SQLite service contract tests |
| `tests/ep-train-6d4n-workspace-ui.test.tsx` | NEW — 6 jsdom UI presentation tests |
| `docs/training/ai-generation/PHASE-D-4N-APPROVAL-DESIGN.md` | NEW — this file |
| `docs/training/ai-generation/PHASE-D-4N-ACCEPTANCE.md` | NEW — companion acceptance doc |

Files NOT committed (gitignored `scratchpad/`):
- `scratchpad/ep-train-6d4n/integration-test.ts` — real-PG harness; 6 scenarios verbatim-enumerated in §8.3.
- `scratchpad/ep-train-6d4n/integration-test-output.txt` + `integration-test-result.json` — captured PASS evidence.

Nothing else. No schema change. No migration. No worker. No new API endpoint beyond the single approve route. No RBAC grant.

---

## 12. STOP boundaries — all honoured

- ✅ No staging or production deployment.
- ✅ No database migration against shared environments (zero schema change).
- ✅ No Modal/Qwen inference.
- ✅ No transcription worker activation.
- ✅ No historical candidate modification. The eight 6D-4H candidates remain exactly as they were under 4M.
- ✅ No employee assignment.
- ✅ No training publication.
- ✅ No new role grants.
- ✅ No unrelated UI or global-navigation changes (three-column layout, header, queue, typography preserved).
- ✅ 126 unrelated WIP files on `staging-deploy/web1b1-framer-fidelity` preserved via `git stash push -u`.
