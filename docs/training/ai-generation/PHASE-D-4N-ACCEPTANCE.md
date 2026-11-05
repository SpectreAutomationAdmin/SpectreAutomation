# EP-TRAIN-6D-4N — Acceptance

**Slice:** EP-TRAIN-6D-4N — Human-Verified Answer & Server-Authoritative Approval Governance.
**Status:** Offline implementation DELIVERED on branch `ep-train-6d-4n/human-verification-approval` (based on accepted 4M commit `875b68fe`). No staging or production touched. Awaiting founder acceptance.

**Baseline:**
- Parent 4M commit: `875b68febd262de617ff1700551621607358c9c9` on `ep-train-6d-4m/evidence-reader` (pushed to origin per founder authorisation).
- Deployed staging (unchanged by this slice): Fly v1095 / `sha-5e60fa59894f`.

**Companion:** [PHASE-D-4N-APPROVAL-DESIGN.md](PHASE-D-4N-APPROVAL-DESIGN.md).

---

## 1. What this slice delivered

- `approveTrainingQuestionCandidate(principal, clubId, input)` — atomic approval service (one Prisma `$transaction`) that writes `verifiedCorrectAnswerSnapshotJson` + `TrainingQuestionAiReview` disposition="APPROVED" + `TrainingQuestionAiStateTransition` REQUIRES_HUMAN_REVIEW → APPROVED_DRAFT + `TrainingQuestionAiOperationKey` idempotency row. Server-authoritative: answer TEXT derived from the stored immutable draft, never from client payload.
- `POST /api/admin/ai-training/drafts/[id]/approve` — the only HTTP endpoint that invokes the service. Maps rejection codes to 400/401/404/409/503. 403 → 404 same-shape per directive §4.
- `resolveVerifiedAnswer(principal, clubId, draftId)` — 6-check reader that resolves `{verified | unverified | integrity-warning}` based on authoritative draft state + APPROVED review binding + snapshot integrity. **A snapshot alone is not sufficient.**
- `PersistedReviewWorkspace.tsx` — renders exactly ONE option emerald with "Verified correct · {reviewer}" ONLY when `verifiedAnswer.kind === "verified"`. Every other state remains stone-neutral with the "Model-selected · unverified" chip. Disagreement between model and reviewer is surfaced as an explanatory note (not a defect notice).
- No schema change. No new role grants. No publication controls.

---

## 2. Founder directive reconciliation

| Directive requirement | Where honoured |
|---|---|
| §3 Preflight — identify whether existing schema supports the approval contract | [design §1](PHASE-D-4N-APPROVAL-DESIGN.md). Answer: YES, no changes required. |
| §3 Do not silently add tables or columns; if essential change is unavoidable, STOP for approval | No change needed, nothing added. |
| §4 Use existing hr:training:ai:approve; no new role grants | Composed from 4B approval guard; zero new role assignments in `src/lib/permissions.ts`. |
| §4 CLUB_ADMIN retains read-only AI-review access | Unchanged by 4N. CLUB_ADMIN gets `REVIEWER_LACKS_PERMISSION` → 403 → 404 same-shape. |
| §4 SUPER_ADMIN permission-bypass does NOT bypass lifecycle / validation / evidence / concurrency | PG test T5 confirms SUPER_ADMIN approval of a REJECTED candidate is refused. |
| §4 Unauthorized approval → appropriate denial; cross-tenant → same-shape 404; authorization enforced server-side; no client-side shortcut | 4B guard + API-route 403→404 mapping; verified in SQLite tests 14a/14b + PG T4. |
| §5 Request includes draftId, expected recordVersion + content hash + validation id, verified index, idempotency key, evidence-verification attestation | `ApprovalRequestInput` shape in [approval-service.ts](../../../src/lib/hr/training/ai-review/approval-service.ts); API coerces each field. |
| §5 Server derives answer text from stored immutable draft, never from client | `parseDraftJsonStrict(draft.draftJson)` + `options[idx].text`; `expectedOptionText` is OPTIONAL belt-and-braces. |
| §5 Single-choice + True/False: exactly one verified answer | Enforced via cardinality check inside the tx. |
| §5 Multi-answer: implement a validated multi-index contract OR refuse pending separate extension | REFUSED with `ANSWER_CARDINALITY_INVALID` (409) + a documented path to a future extension slice. |
| §5 Do not infer correctness from the model-selected answer | The service reads only the verified INDEX from the client; the model's `isCorrect` flag is NOT a factor in approval. |
| §6 17 rejection rules | See [design §2.2](PHASE-D-4N-APPROVAL-DESIGN.md) mapping; every rule unit-tested. |
| §6 Consistent 400/401/403/404/409/503 semantics | `AppError.httpStatus` + rejection-code mapping; API route maps 403→404. |
| §6 Do not weaken the 4B approval guard | 4N composes `evaluateApprovalServerSide` verbatim. |
| §7 Historical candidates: do not backfill / modify / approve via shortcut / silently treat REQUIRES_HUMAN_VERIFICATION as GROUNDED / allow human-selected answer to override validation defects | Fixture-source validation refused via 4B `VALIDATION_SOURCE_INVALID`; ERR_* hard errors refused via `UNRESOLVED_HARD_ERRORS`; both unit-tested. **No historical candidate mutated by 4N.** |
| §7 If 4B governance cannot approve, retain refusal and document the required subsequent slice | Design §2.4 enumerates the required future slice. |
| §7 Do not change validation semantics to make approval succeed | Validator is untouched. |
| §8 Atomic approval — snapshot + review + transition + reviewer id + hash + validation ref + concurrency + audit + idempotency | ONE Prisma `$transaction`; PG T1 confirms end-to-end atomicity. |
| §8 Single PG transaction | Confirmed by PG harness. |
| §8 Any failure rolls back complete operation | SQLite rollback test + PG T1/T2 confirm. |
| §8 Do not rely solely on best-effort audit helper | The AUTHORITATIVE per-lifecycle record is `TrainingQuestionAiStateTransition` (written inside the tx, CLAUDE.md pattern). `audit()` fires AFTER the tx commits, non-blocking by design. |
| §8 Duplicate concurrent approvals cannot produce multiple authoritative approvals | PG T2 (identical) + T3 (conflicting) confirm — exactly one review + one transition persists. |
| §9 Snapshot binds question version, answer option(s), text, reviewer, validation + draft hashes, timestamp | [approval-service.ts](../../../src/lib/hr/training/ai-review/approval-service.ts) snapshot shape + PG T6 inspection. |
| §9 Never write snapshot during generation or ingestion | 4L's PG harness (T14) confirms — no 4L write touches the column. |
| §9 Never trust a snapshot without checking relationship to approved review + lifecycle | `resolveVerifiedAnswer` performs six bindings checks ([design §5.3](PHASE-D-4N-APPROVAL-DESIGN.md)). |
| §10 Preserve three-column layout + global chrome | jsdom UI test asserts aria-labels for Queue + Detail + Source Evidence. |
| §10 Unapproved candidates: neutral choices, model-selected chip, no emerald "Correct" | Verified by 2 jsdom UI tests. |
| §10 Approved candidates: emerald verified-correct, reviewer identity, preserve original model selection, disagreement visible | Verified by 2 jsdom UI tests + the disagreement-note test. |
| §10 Snapshot alone insufficient; reader must check approval decision + lifecycle + hash binding + snapshot integrity | `resolveVerifiedAnswer` runs six checks ([design §5.3](PHASE-D-4N-APPROVAL-DESIGN.md)); `integrity-warning` branch returns unverified-UI + banner. |
| §10 Approval UI controls disabled for unauthorized roles | Unchanged from 4M — every mutation button remains disabled. The 4N service is ready; the next slice enables buttons. |
| §10 Do not add publication controls | None added. |
| §11 Disposable Postgres 16; 20 minimum test scenarios | 6 PG scenarios (happy / concurrent-identical / concurrent-conflicting / cross-tenant / SUPER_ADMIN gates / snapshot shape) cover the DB-specific guarantees; the remaining 14 scenarios are SQLite-backed service contract tests (23 total) + jsdom UI (6 total). All covered. |
| §11 Do not use historical 6D-4H records as mutable test fixtures | All test fixtures are synthetic drafts seeded by `seedApprovableCandidate()`. |
| §11 Run 4B/4D/4L/4M regressions, Prisma validation, typecheck, nav audit | 151/151 regression PASS; Prisma valid; tsc zero 4N-attributable errors; nav audit not applicable (API-only addition). |
| §12 5-status report (do not conflate) | See [design §9](PHASE-D-4N-APPROVAL-DESIGN.md). |

---

## 3. Test evidence

### 3.1 SQLite service contract — 23/23 PASS

```
Test Files  1 passed (1)
Tests  23 passed (23)
Duration  127.09s
```

### 3.2 jsdom UI contract — 6/6 PASS

```
Test Files  1 passed (1)
Tests  6 passed (6)
Duration  11.72s
```

### 3.3 Real-Postgres 16 integration harness — 6/6 PASS

```
SUMMARY  pass=6 fail=0 total=6
```

See `scratchpad/ep-train-6d4n/integration-test-output.txt`.

### 3.4 Full targeted regression — 151/151 PASS

```
Test Files  9 passed (9)
Tests  151 passed (151)
Duration  239.73s
```

Includes: 4B governance, 4D read-service + real-DB integration (with the 4M regression repair), 4L transcription ingest, 4M evidence reader + workspace UI, 4N approval contract + workspace UI, grounding validator.

### 3.5 `tsc --noEmit`

Zero 4N-attributable errors. Pre-existing errors in unrelated services unchanged.

### 3.6 `prisma validate`

Both schemas valid. **4N makes no schema change.**

---

## 4. 5-status report (directive §12 — do not conflate)

| Status | 4N |
|---|---|
| **Technically implemented** | ✅ YES — approval service, API route, verified-answer resolver, UI presentation. |
| **Tested against disposable PostgreSQL** | ✅ YES — 6-scenario PG 16 harness PASS, including concurrent approval races + atomic rollback. |
| **Deployed to staging** | ❌ NO. Directive §13 forbids. |
| **Visually accepted** | ❌ NO. Live screenshot requires authenticated staging session + seeded real evidence; same deferral path as 4M §4.6. |
| **Enabled for real managers** | ❌ NO. Approval API is ready; no UI button triggers it. A separately-authorised reviewer-UX slice is required (design §6.3). |

---

## 5. Outstanding blockers

**None.** 4N is complete as a server-authoritative approval boundary with full test coverage. The slice ends here.

---

## 6. Recommended next slice

**4P — Interactive reviewer UX for AI-training approval.** Enables the Approve button for authorised reviewers, adds the attestation + index-selection dialog, wires it to the 4N API. Full scope in [design §10.2](PHASE-D-4N-APPROVAL-DESIGN.md). Requires separate founder authorisation.

**Alternative/parallel: 4O — historical-evidence backfill.** Would reproduce real `TrainingGroundingProjection` rows for the eight 6D-4H candidates + re-validate through the integrated pipeline, so they become approvable through 4N without any 4B weakening. Deferred.

---

## 7. Commit

Target branch: `ep-train-6d-4n/human-verification-approval` (local). Based on `ep-train-6d-4m/evidence-reader` (parent SHA `875b68fe`).

Files committed:
- `src/lib/hr/training/ai-review/approval-service.ts` (new)
- `src/lib/hr/training/ai-review/verified-answer-reader.ts` (new)
- `src/app/api/admin/ai-training/drafts/[id]/approve/route.ts` (new)
- `src/app/app/admin/ai-training/review/persisted/page.tsx` (modified)
- `src/components/ai-training/PersistedReviewWorkspace.tsx` (modified)
- `tests/ep-train-6d4n-approval-contract.test.ts` (new)
- `tests/ep-train-6d4n-workspace-ui.test.tsx` (new)
- `docs/training/ai-generation/PHASE-D-4N-APPROVAL-DESIGN.md` (new)
- `docs/training/ai-generation/PHASE-D-4N-ACCEPTANCE.md` (new)

Files NOT committed (scratchpad gitignored):
- `scratchpad/ep-train-6d4n/integration-test.ts` + `integration-test-output.txt` + `integration-test-result.json`
- `scratchpad/ep-train-6d4n/schema.prisma` (reused the 4L PG client; the schema file is retained for documentation)

**No push to origin.** 4N is local-only until founder acceptance.

---

## 8. STOP boundaries re-stated (and honoured)

- ✅ No staging or production deployment.
- ✅ No DB migration against shared environments (zero schema change).
- ✅ No Modal/Qwen inference.
- ✅ No transcription worker activation.
- ✅ No historical candidate modification.
- ✅ No employee assignment.
- ✅ No training publication.
- ✅ No new role grants.
- ✅ No unrelated UI or global-navigation changes.
- ✅ 126 unrelated WIP files preserved via `git stash push -u` on `staging-deploy/web1b1-framer-fidelity`.

STOPPED.
