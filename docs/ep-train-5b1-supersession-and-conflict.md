# EP-TRAIN-5B-1 — Revision Supersession & Retake Conflict Governance

**Status:** Deployed to staging 2026-11-02. Completes the EP-TRAIN-5B
administrative workflow with two governance behaviours the directive
flagged after the initial 5B landing:

1. **Automatic supersession** when a revision replaces an older
   version — removes the risk of an employee being left with
   contradictory outstanding requirements on obsolete + current
   versions.
2. **Mandatory per-employee conflict resolution** on Require Retake
   when an employee already has an outstanding requirement — removes
   the risk of silently stacking overlapping obligations.

**Supersedes guidance in:** EP-TRAIN-5B design doc §10 "Not implemented
in 5B" bullet about auto-supersession.

---

## 1. Revision supersession (publishDraftWithPolicy)

### 1.1 What runs

When a revision is published under any policy (`ALL_APPLICABLE`,
`NON_COMPLETERS`, `SELECTED`), for every employee in the target set:

1. The new `REVISION` obligation is created against the newly
   published version (unchanged from 5B).
2. **NEW**: every `OUTSTANDING` `INITIAL` or `REVISION` obligation
   belonging to that same employee on OLDER versions of the SAME
   course is transitioned to `SUPERSEDED`, with
   `supersededByObligationId` pointing at the new obligation.

Both steps run inside a `prisma.$transaction` per employee, so the
employee is never observable mid-flight with "new requirement issued
AND old requirement still outstanding."

### 1.2 What never runs

- `MANUAL_REINSTATE` obligations are **never auto-superseded** by a
  revision publish. They represent an independent manager-initiated
  policy and only the manager (via Require Retake → Replace) can
  cancel them.
- Employees NOT in the target set keep their prior obligations
  unchanged. NON_COMPLETERS leaves prior-completers alone;
  SELECTED leaves the un-selected alone.
- No `TrainingCompletion`, `TrainingAttempt`, or `TrainingProgress`
  row is read, modified, or deleted.

### 1.3 Audit

The existing `hr.training.revision.publish` audit entry now carries
`supersededObligationCount` in `after.*`. Combined with `eventId` the
Controller can reconstruct exactly which obligations were superseded
by which publish.

## 2. Require Retake conflict governance (issueManualReinstatement)

### 2.1 The service contract

`issueManualReinstatement` now accepts an optional
`conflictResolution: Record<employeeId, "KEEP_BOTH" | "REPLACE">`.

Three precondition-level outcomes:

| Precondition for employee E | Service behaviour |
|---|---|
| No prior OUTSTANDING on this course | `conflictResolution[E]` ignored; new obligation issued. `perEmployee[*].conflictResolution === "NONE"`. |
| Prior OUTSTANDING exists AND `conflictResolution[E] === "KEEP_BOTH"` | New obligation issued; prior left `OUTSTANDING`. Two coexist, satisfied FIFO per EP-TRAIN-5A-1 §4. |
| Prior OUTSTANDING exists AND `conflictResolution[E] === "REPLACE"` | Every prior OUTSTANDING on this course for this employee is `CANCELED` (with `reasonNote` suffixed `[canceled] Replaced by retake request <eventId>`); new obligation issued. Single OUTSTANDING remains. |
| Prior OUTSTANDING exists AND no resolution supplied | `ConflictError` thrown. **No obligation created. No prior canceled.** The UI must re-prompt the manager. |

The `ConflictError` message names the number of unresolved employees;
the UI can refetch the preview and ask the manager for choices.

### 2.2 The UI contract

In the Require Retake modal's **Review** step, for every employee
whose preview carries `existingOutstandingObligations.length > 0`,
two radio buttons appear inline in the "Existing requirement"
column:

- **Keep both** — "Employee will need two separate completions."
- **Replace existing** — "Cancel the prior requirement, issue this
  new one."

The **Confirm & issue** button is disabled until every conflicted
employee has a selection. Submitting without resolutions is blocked
client-side AND server-side (the server throws `ConflictError` if
somehow the request reaches it unresolved).

### 2.3 Transactional atomicity

For `REPLACE`: `cancelObligation` on every prior + `issueObligation`
for the new row run inside one `prisma.$transaction` per employee,
so the employee is never observable in "prior canceled AND new not
yet issued" state.

For `KEEP_BOTH`: the issue runs by itself; prior is untouched.

### 2.4 Idempotency

Same mechanism as 5B — single server-generated `eventId` per
confirmed submission → `issuanceKey = rtk:${eventId}:${employeeId}`.
A UI double-submit with the same conflict choices resolves to the
same obligations.

A re-submission with a NEW `eventId` and `conflictResolution:
REPLACE` for the SAME employee would:
- Cancel the newly-issued OUTSTANDING from the first call (now the
  only OUTSTANDING on the course).
- Issue a new OUTSTANDING under the new `eventId`.
Net result: one OUTSTANDING per employee, prior terminal rows
preserved. Not the sort of thing a manager would do on purpose, but
the system behaves correctly if they do.

### 2.5 Audit

The existing `hr.training.manual-reinstate.issue` audit entry now
carries:

- `keptBothCount` — employees for whom KEEP_BOTH was selected
- `replacedCount` — employees for whom REPLACE was selected
- `canceledPriorObligationCount` — total prior OUTSTANDING rows
  canceled under REPLACE
- `issueFailedCount` — employees for whom the per-employee tx
  failed (reserved for operator visibility; always 0 in healthy
  conditions)

## 3. Policy table (updated from 5B)

| Pre-existing OUTSTANDING | New event | Action (5B-1) |
|---|---|---|
| None | any | Create OUTSTANDING |
| INITIAL on v1 | REVISION publish (ANY policy, same employee in target) | **New REVISION on v2 created; v1 INITIAL auto-SUPERSEDED (NEW)** |
| REVISION on v2 | REVISION on v3 (same employee in target) | **New REVISION on v3; v2 REVISION auto-SUPERSEDED (NEW)** |
| MANUAL_REINSTATE on v1 | REVISION publish (any policy) | New REVISION created; **MANUAL_REINSTATE NEVER auto-superseded (NEW, explicit)** |
| INITIAL / REVISION / MANUAL_REINSTATE on v1 | Require Retake, no conflict resolution | **ConflictError refusal (NEW)** |
| … same as above | Require Retake, resolution = KEEP_BOTH | New MANUAL_REINSTATE issued; prior left OUTSTANDING |
| … same as above | Require Retake, resolution = REPLACE | Prior OUTSTANDING(s) all CANCELED; new MANUAL_REINSTATE issued |

## 4. Historical data preservation

Unchanged from 5B:
- No `TrainingCompletion`, `TrainingAttempt`, or `TrainingProgress`
  row is deleted, mutated, or marked failed.
- Chris Turcato's 9/30/9 history remains byte-for-byte identical
  after this slice ships.

## 5. Tests

`tests/hr/training/revisions.test.ts` — 30 of 30 PASS, adding 10 new
EP-TRAIN-5B-1 scenarios on top of the 20 EP-TRAIN-5B scenarios:

| EP-TRAIN-5B-1 scenario | Verifies |
|---|---|
| ALL_APPLICABLE supersedes OUTSTANDING INITIAL on an older version | Core supersession for every target employee |
| NON_COMPLETERS supersedes ONLY non-completers' prior OUTSTANDING | Scoped supersession respects target set |
| SELECTED supersedes ONLY selected employees' prior OUTSTANDING | Explicit-selection supersession scope |
| REVISION publish NEVER auto-supersedes MANUAL_REINSTATE | Independent-policy invariant |
| Idempotent publish does not duplicate SUPERSEDED rows | Replay safety |
| ConflictError on unresolved prior OUTSTANDING | Server-side guard |
| KEEP_BOTH leaves prior OUTSTANDING + creates second OUTSTANDING | FIFO coexistence |
| REPLACE cancels prior + creates single OUTSTANDING | Clean replacement |
| REPLACE cancels BOTH MANUAL_REINSTATE and INITIAL/REVISION priors | Comprehensive cancel scope |
| No conflict for an employee without prior OUTSTANDING: resolution not required | Default no-op path |

21/21 EP-TRAIN-5A-1 obligation contract tests still PASS.

## 6. Rollback

Both changes are purely additive on the obligation table — no new
migration, no schema change.

- Rolling back the auto-supersession: `UPDATE "TrainingObligation" SET status = 'OUTSTANDING', "supersededByObligationId" = NULL WHERE status = 'SUPERSEDED' AND "supersededByObligationId" IN (<new REVISION ids>);`
- Rolling back a REPLACE cancellation: `UPDATE "TrainingObligation" SET status = 'OUTSTANDING' WHERE id IN (<canceled ids>);` — but the `reasonNote` suffix is informational-only; no harm leaving it.

Both are safe because EP-TRAIN-5C has not landed — nothing employee-
facing reads these rows yet.

## 7. Not implemented in 5B-1

- Employee Portal consumption of obligations → **5C**
- Dashboard de-duplication for same-reason overlapping obligations → **5C**
- Recurring recertification scheduling → future
- Historical / audit-focused Controller reporting pages → future
