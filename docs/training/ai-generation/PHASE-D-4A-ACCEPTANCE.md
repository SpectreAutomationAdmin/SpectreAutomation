# EP-TRAIN-6D-4A — Proposed Acceptance Test Matrix

**Status:** DESIGN-ONLY. No tests implemented. No code changes.
**Companion to:** [PHASE-D-4A-ARCHITECTURE.md](PHASE-D-4A-ARCHITECTURE.md)
**Scope:** the test matrix that each downstream implementation slice
(6D-4B through 6D-6) must satisfy before its staging acceptance.

This document is the audit trail the founder can hand to a reviewer
and ask "did they actually test this?". Each row below has to
correspond to a passing test or an explicit "deferred to slice X with
founder authorisation" annotation.

---

## 1. Matrix organisation

Grouped by directive §12 category. Every row carries:

- **ID** — stable identifier for cross-referencing in later slices.
- **Precondition** — the fixture / state the test runs against.
- **Action** — what the test does.
- **Expected** — what the server must return / write.
- **Negative control** — the thing that MUST NOT happen (per directive §12).
- **Targets slice** — which 6D-4* slice first delivers the enforcement.

---

## 2. Tenant isolation (directive §12 · tenant isolation + cross-tenant media)

| ID | Precondition | Action | Expected | Negative control | Slice |
|----|--------------|--------|----------|------------------|:----:|
| TI-01 | Draft `D` owned by club `A` | Reviewer `R_B` (active club `B`) calls `GET /drafts/D` | **404** `not_found` (same-shape as "truly absent") | R_B must NOT receive the draft payload | 6D-4C |
| TI-02 | Draft `D` owned by club `A` | R_B calls `GET /drafts/D/history` | 404 | R_B must NOT see any state transition row | 6D-4C |
| TI-03 | Draft `D` owned by club `A` | R_B calls `POST /drafts/D/review` with action=APPROVE | 404 (tenant filter short-circuits BEFORE the approval guard runs) | R_B must NOT advance D to APPROVED_DRAFT; must NOT see guard-reason detail | 6D-4E |
| TI-04 | Draft `D` owned by club `A` | R_B calls `POST /drafts/D/edit` | 404 | R_B's edit must NOT create a successor draft | 6D-4D |
| TI-05 | Reviewer with `activeClubId = A`, draft D in club A, media in club A | Reviewer requests `GET /api/hr/training/versions/.../video` | 200 + stream | Baseline positive case for cross-tenant proof — tests the permission bridge | 6D-4F |
| TI-06 | Reviewer with `activeClubId = B`, media in club A | Same video request | 404 (same-shape as absent) | Media must NOT stream across tenants | 6D-4F |
| TI-07 | All TI-01-TI-06 attempts | `AuditLog` inspection | Every tenant-rejected attempt writes an `AuditLog` row with `userId`, `ip`, `userAgent`, `action = "training.ai.review.cross-tenant-attempt"` | Audit must capture cross-tenant probes so they're detectable | 6D-4C |

---

## 3. RBAC (directive §12)

| ID | Precondition | Action | Expected | Negative control | Slice |
|----|--------------|--------|----------|------------------|:----:|
| RBAC-01 | Principal has no training permissions | `GET /drafts` | 403 `forbidden` | Must not list candidates | 6D-4C |
| RBAC-02 | Principal has `hr:training:read` only (no `:ai:review`) | `GET /drafts/D` | 403 | `hr:training:read` alone does NOT unlock the AI queue | 6D-4C |
| RBAC-03 | Principal has `hr:training:ai:review` only | `POST /drafts/D/review` with action=APPROVE | 403 (`REVIEWER_LACKS_PERMISSION`) | Rejection path remains available | 6D-4E |
| RBAC-04 | Principal has `hr:training:ai:approve` AND content-hash matches AND validation clean | Same action | 200 + draft state → `APPROVED_DRAFT` | — | 6D-4E |
| RBAC-05 | Principal has `hr:training:ai:approve` but NOT `hr:training:ai:remediate-rejected`, draft state = `REJECTED` | APPROVE attempt | 409 `invalid_transition` (REJECTED is terminal without remediation) | Must not resurrect a rejected candidate | 6D-4E |
| RBAC-06 | Principal has `hr:training:ai:revalidate` | `POST /drafts/D/review` action=REQUEST_REVALIDATION | 200 + state → `VALIDATION_PENDING` | Must not auto-approve on revalidation | 6D-4D |
| RBAC-07 | Principal has `hr:training:ai:review` but no `:edit` | `POST /drafts/D/edit` | 403 | Edit must not create a new draft row | 6D-4D |
| RBAC-08 | Principal has every `:ai:*` permission | REQUEST_REGENERATION | **501** `not_implemented` (slice 6D-4B–6D-4E) | Must not invoke Modal in 6D-4* | 6D-4C |
| RBAC-09 | Principal with full `:ai:*` but on wrong `activeClubId` | Any mutation | 404 (tenant short-circuit beats RBAC check) | Cross-tenant 404 must NOT leak that a permission check would have succeeded on the right tenant | 6D-4C |

---

## 4. Invalid transitions (directive §4 + §12)

| ID | Precondition | Action | Expected | Negative control | Slice |
|----|--------------|--------|----------|------------------|:----:|
| TR-01 | Draft state = `GENERATED` | APPROVE | 409 `invalid_transition` | `GENERATED → APPROVED_DRAFT` must NEVER be allowed (must pass through validation first) | 6D-4E |
| TR-02 | Draft state = `VALIDATION_PENDING` | APPROVE | 409 `invalid_transition` (also VALIDATION_MISSING via guard) | Pending validation must NOT allow approval | 6D-4E |
| TR-03 | Draft state = `VALIDATION_FAILED` | APPROVE | 409 `invalid_transition` | Failed validation blocks approval | 6D-4E |
| TR-04 | Draft state = `REJECTED` | APPROVE without `hr:training:ai:remediate-rejected` | 409 `invalid_transition` | REJECTED → APPROVED without remediation chain MUST NOT happen | 6D-4E |
| TR-05 | Draft state = `REJECTED` + principal has remediate perm | APPROVE | 409 `invalid_transition` ALSO — direct REJECTED → APPROVED is still forbidden; path must be REJECTED → REQUIRES_HUMAN_REVIEW (via new validation on a new hash) first | Must enforce the chain, not just the permission | 6D-4E |
| TR-06 | Draft state = `APPROVED_DRAFT` | Any REVIEW action | 409 `invalid_transition` (terminal from reviewer perspective; only ARCHIVE allowed) | Must NOT re-approve, re-reject, or re-edit an approved draft | 6D-4E |
| TR-07 | Draft state = `ARCHIVED` | Any action | 404 (archived drafts are invisible to the queue + review API) | — | 6D-4C |
| TR-08 | Draft state = `EDITED_VALIDATION_STALE` | APPROVE | 409 `invalid_transition` + guard reason `VALIDATION_STALE` | Stale edit must NOT be approvable | 6D-4E |

---

## 5. Stale validation (directive §12)

| ID | Precondition | Action | Expected | Negative control | Slice |
|----|--------------|--------|----------|------------------|:----:|
| SV-01 | Draft `D` validated clean; reviewer edits → new draft `D'` (hash changes); `D'.state = EDITED_VALIDATION_STALE` | APPROVE on `D'` | 409 `approval_blocked` + reason `VALIDATION_STALE` | Must NOT approve on the pre-edit validation | 6D-4E |
| SV-02 | SV-01 + reviewer requests revalidation (fixture outcome: clean) + validation row written for `D'`'s hash | APPROVE | 200 | Positive control — revalidation unblocks approval | 6D-4E |
| SV-03 | SV-01 + revalidation produces `verdict = REJECTED` | APPROVE | 409 + reason `CANDIDATE_REJECTED` | Must NOT approve on the new rejected validation | 6D-4E |
| SV-04 | SV-01 + validation row written but its `draftContentHash` differs from current `D'.contentHash` (impossible in production but testable) | APPROVE | 409 + reason `VALIDATION_MISSING` (no validation matching the current hash) | Hash-join must be strict equality | 6D-4E |

---

## 6. Content-hash mismatch (directive §5 + §12)

| ID | Precondition | Action | Expected | Negative control | Slice |
|----|--------------|--------|----------|------------------|:----:|
| CH-01 | Draft `D`, current `contentHash = H1` | APPROVE with `submittedContentHash = H2` | 409 + reason `CONTENT_HASH_MISMATCH` | Must NOT accept approval of a different content version | 6D-4E |
| CH-02 | Draft `D`, current `H1` | EDIT with `submittedContentHash = H2` | 409 `stale` + payload includes `currentContentHash = H1` | UI can refetch and retry | 6D-4D |
| CH-03 | Two reviewers open `D` simultaneously; Reviewer A edits (new hash `H2`); Reviewer B still sees `H1`; B submits APPROVE with `H1` | 409 `stale` + `currentContentHash = H2` | Must NOT approve Reviewer A's new content under B's stale understanding | 6D-4E |

---

## 7. Optimistic concurrency (directive §5 + §12)

| ID | Precondition | Action | Expected | Negative control | Slice |
|----|--------------|--------|----------|------------------|:----:|
| OC-01 | Draft `D`, `recordVersion = 5` | APPROVE with `submittedRecordVersion = 5`, all guards pass | 200 + draft `recordVersion → 6` | — | 6D-4E |
| OC-02 | Draft `D`, `recordVersion = 5` | APPROVE with `submittedRecordVersion = 4` | 409 `stale` + `currentRecordVersion = 5` | Must NOT apply an update based on a stale read | 6D-4E |
| OC-03 | Two concurrent APPROVE requests from the same principal, both carrying `recordVersion = 5` | First wins (200, version → 6); second fails 409 | Must NOT double-write (no "both succeed" interleaving) | 6D-4E |
| OC-04 | Two concurrent REJECT requests | Same semantics as OC-03 | — | 6D-4E |

---

## 8. Duplicate requests (directive §12)

| ID | Precondition | Action | Expected | Negative control | Slice |
|----|--------------|--------|----------|------------------|:----:|
| DR-01 | APPROVE with `requestKey = K1` (fresh) | 200 | — | — | 6D-4E |
| DR-02 | Same APPROVE repeated within 60 s with same `K1` | 200 + response body IDENTICAL to DR-01 (replay from idempotency table) | Must NOT write a second review row or double-audit | 6D-4E |
| DR-03 | APPROVE with new `K2` after a successful `K1` on the same draft | 409 `invalid_transition` (draft is now APPROVED_DRAFT) | Idempotency keys cannot be used to bypass state-machine constraints | 6D-4E |
| DR-04 | REJECT with `K3` after a successful APPROVE with `K1` | 409 `invalid_transition` | — | 6D-4E |
| DR-05 | `K1` reused 61 s after DR-01 | 409 `invalid_transition` (idempotency key expired AND state is now APPROVED_DRAFT) | — | 6D-4E |

---

## 9. Revalidation failure (directive §12)

| ID | Precondition | Action | Expected | Negative control | Slice |
|----|--------------|--------|----------|------------------|:----:|
| RF-01 | Draft `D` in `EDITED_VALIDATION_STALE`; reviewer REQUEST_REVALIDATION; pipeline throws | State → `VALIDATION_FAILED` + validation row with `stage = EXCEPTION`; audit `training.ai.draft.validation.failed` | Approve must remain blocked; UI shows "Validation failed" banner | 6D-4D |
| RF-02 | RF-01 + reviewer retries REQUEST_REVALIDATION; pipeline succeeds | State → `REQUIRES_HUMAN_REVIEW`; fresh validation row written | Retry must succeed cleanly | 6D-4D |
| RF-03 | Validation service is explicitly unavailable (health probe fails) | APPROVE | 503 + reason `VALIDATION_SERVICE_UNAVAILABLE` | Must NOT approve while pipeline is unhealthy | 6D-4E |

---

## 10. Audit integrity (directive §12)

| ID | Precondition | Action | Expected | Negative control | Slice |
|----|--------------|--------|----------|------------------|:----:|
| AU-01 | Clean APPROVE | `AuditLog` contains `training.ai.review.approved` with `entityType = "TrainingQuestionAiReview"`, `entityId`, `clubId`, `userId`, `ip`, `userAgent`, `meta.validationId`, `meta.contentHash` | No sensitive transcript body in meta | 6D-4E |
| AU-02 | Guard-blocked APPROVE | `training.ai.review.approve-blocked` with `meta.reasons`, `meta.contentHashSubmitted`, `meta.contentHashCurrent`, `meta.validatorSource` | Must capture the blocking reason set | 6D-4E |
| AU-03 | Reviewer EDIT | `training.ai.draft.edited` with `meta.previousDraftId`, `meta.previousContentHash`, `meta.newContentHash` | Previous `TrainingQuestionAiDraft` row transitions to ARCHIVED but is NOT deleted | 6D-4D |
| AU-04 | REQUEST_REGENERATION | `training.ai.draft.regeneration.requested` + 501 response | Must NOT invoke Modal in 6D-4* slices | 6D-4C |
| AU-05 | Cross-tenant 404 (TI-03) | `training.ai.review.cross-tenant-attempt` with `userId`, `ip`, `userAgent`, `meta.attemptedDraftId` | Audit captures the probe without leaking the draft to the attacker | 6D-4C |
| AU-06 | `audit()` throws | The write operation STILL succeeds (per existing `audit.ts` policy "never let audit failures bubble up") + the audit failure is logged to ops | Must NOT block legitimate work on audit failure | all |
| AU-07 | No credentials in any audit row | Grep across `AuditLog.metaJson` finds zero HMAC secrets, Modal proxy keys, or R2 signed URLs | Credential hygiene | all |

---

## 11. Source-version mismatch (directive §12)

| ID | Precondition | Action | Expected | Negative control | Slice |
|----|--------------|--------|----------|------------------|:----:|
| SVM-01 | Draft `D` bound to `courseVersionId = V1`, `sourceVideoSha256 = S1`; `TrainingCourseVersion V1.videoSha256` is subsequently updated to `S2` (admin re-uploaded the video on the DRAFT version) | APPROVE on `D` | 409 + reason `SOURCE_VERSION_CHANGED` | Must NOT approve a draft that cites a video version that no longer exists | 6D-4E |
| SVM-02 | Same, but `V1` has been published (so it's immutable and `videoSha256` cannot change) | APPROVE | 200 (positive control) | — | 6D-4E |
| SVM-03 | Draft `D` bound to `V1`; admin creates a new version `V2` (fresh DRAFT) | APPROVE on `D` | 200 (V1 unchanged; D still binds to V1) | New version must NOT block approvals on old-version drafts | 6D-4E |
| SVM-04 | Admin RETIRES `V1` | APPROVE on `D` | 409 + reason `SOURCE_VERSION_CHANGED` (or `RETIRED`) | Retired courses must NOT accept new approved drafts | 6D-4E |

---

## 12. Cross-tenant media access (directive §12 + §10)

| ID | Precondition | Action | Expected | Negative control | Slice |
|----|--------------|--------|----------|------------------|:----:|
| CTM-01 | Reviewer in club A, draft in club A, media request for the correct version | 200 + stream | — | 6D-4F |
| CTM-02 | Reviewer in club A requests media for a version in club B | 404 same-shape | Must NOT stream; must NOT return a Range-aware response | 6D-4F |
| CTM-03 | Reviewer with ONLY `hr:training:ai:review` (no base `hr:training:read`) in club A requests media for a draft-attached version in club A | 200 (permission bridge in §9.3 of architecture doc) | Positive control for the bridge | 6D-4F |
| CTM-04 | Signed R2 URL probe — try to curl a direct R2 object URL | 403/404 from R2 | Must NOT be publicly accessible | 6D-4F |

---

## 13. Publication boundary (directive §12)

| ID | Precondition | Action | Expected | Negative control | Slice |
|----|--------------|--------|----------|------------------|:----:|
| PUB-01 | Draft in `APPROVED_DRAFT` | Query `TrainingQuestion` table for `sourceAiDraftId = D.id` | Zero rows | Approval must NOT auto-insert into TrainingQuestion | 6D-4E |
| PUB-02 | `APPROVED_DRAFT` + principal has `hr:training:publish` on the version | Try to attach via the inclusion API (does not exist in 6D-4*) | 404 (route does not exist) | Publication path isn't open in 6D-4* | 6D-4E |
| PUB-03 | All approved drafts across all states | Employee-portal `GET /api/employee-portal/training/courses/[id]` payload | NEVER contains AI-draft content (only PUBLISHED `TrainingQuestion` rows) | Employees must NEVER see unpublished AI drafts | 6D-4C |
| PUB-04 | Approved draft D + attempt to use it in a `TrainingAttempt` | Server refuses (no draft content in grading path) | Grading is bound to `TrainingAnswerOption.isCorrect` only; AI drafts have no such relationship | 6D-4C |

---

## 14. Rollback + recovery (directive §12)

| ID | Precondition | Action | Expected | Negative control | Slice |
|----|--------------|--------|----------|------------------|:----:|
| RB-01 | 6D-4B migration applied to staging; immediately revert migration | Rollback cleanly; no data loss to existing `TrainingQuestion` rows | Zero impact on existing training surfaces | 6D-4B |
| RB-02 | 6D-4E deployed; a critical bug surfaces in the server-side guard | Deploy previous image (`accbb0c + 6D-4B/C/D` without 6D-4E) | Approval route returns 501/503; no automatic state changes | 6D-4E |
| RB-03 | Approval written then rolled back (hypothetical) | Draft stays in `APPROVED_DRAFT`; TrainingQuestion unaffected; audit shows the approve + the subsequent manual archive | No cascade failures on downstream training surfaces | 6D-4E |
| RB-04 | Idempotency-key table grows unbounded | Scheduled cleanup job deletes rows older than the TTL window | Table size remains bounded | 6D-4B |

---

## 15. Negative-control summary

The directive explicitly asked for negative controls. Collected from
every row above:

- Cross-tenant data NEVER visible (TI-01-07, CTM-01-04, RBAC-09)
- Cross-tenant media NEVER streams (CTM-02)
- Rejected candidates NEVER promoted to approved without the documented remediation chain (TR-04, TR-05, RBAC-05)
- Stale validation NEVER passes approval (SV-01, SV-04, TR-08)
- Mismatched content hash NEVER approved (CH-01, CH-03)
- Stale `recordVersion` NEVER wins a write (OC-02, OC-03, OC-04)
- Duplicate requests NEVER double-write (DR-02)
- Idempotency keys NEVER bypass state-machine constraints (DR-03, DR-04, DR-05)
- Failed validation NEVER yields an approved draft (TR-03, RF-01)
- Validation-service outage NEVER produces false approval (RF-03)
- Source-video change NEVER tolerated silently (SVM-01, SVM-04)
- Employee-portal NEVER sees unpublished AI drafts (PUB-03)
- Grading NEVER consumes AI-draft content (PUB-04)
- Audit NEVER contains credentials (AU-07)
- Audit NEVER blocks legitimate writes when the audit service itself fails (AU-06)
- Approval NEVER happens without the server-side guard writing a corresponding audit row (AU-01, AU-02)
- Public R2 URL NEVER accessible (CTM-04)

---

## 16. Per-slice acceptance gate

Each downstream implementation slice MUST satisfy its row's tests
before staging acceptance. Approximate row counts per slice:

| Slice | Required test rows | Notes |
|-------|-------------------:|-------|
| 6D-4B | 2 (RB-01, RB-04) + unit tests on the pure server-guard function | Foundational; no API behaviour to assert |
| 6D-4C | 14 (TI-01, TI-02, TI-07, RBAC-01, RBAC-02, RBAC-08, RBAC-09, TR-07, AU-05, AU-06, AU-07, PUB-03, PUB-04) | Read-only slice — a lot of RBAC + tenant controls apply |
| 6D-4D | 9 (TI-04, RBAC-06, RBAC-07, TR-01, TR-02, TR-03, CH-02, RF-01, RF-02, AU-03) | Mutation on edits + revalidation |
| 6D-4E | ~30 (every approval + rejection + concurrency + guard + rollback row) | Safety-critical; highest coverage expectation |
| 6D-4F | 4 (CTM-01, CTM-02, CTM-03, CTM-04) | Media bridge |
| 6D-5 | New matrix (not covered here; separate directive) | Re-authorises Modal |
| 6D-6 | New matrix (not covered here; separate directive) | Publication governance |

---

## 17. Mandatory STOP (directive §14)

- Acceptance test matrix complete. ✓
- Zero tests implemented. ✓
- Zero code changes beyond this document + the architecture doc. ✓
- 6D-4B through 6D-6 — **none** authorised to begin.

**Founder acceptance standard (directive closing paragraph):**

> *"Produce a concrete, repository-grounded design for a secure,
> tenant-isolated and auditable AI question-review backend, with
> immutable validation-to-content binding and server-enforced approval
> governance, before any persistent implementation begins."*

Status: **met**. This matrix translates every directive §12 category
into an executable test specification, with explicit negative
controls and a slice-by-slice responsibility map. A reviewer can read
a row and know exactly what a passing test looks like. An auditor can
grep `AuditLog` for the expected action strings. A founder can decide
which rows block each staging acceptance.
