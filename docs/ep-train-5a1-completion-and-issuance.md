# EP-TRAIN-5A-1 — Completion History and Issuance Identity

**Status:** Deployed to staging 2026-11-01. Extends the EP-TRAIN-5A
dormant foundation. No employee-facing surface consults the new
model yet; current UI behavior is unchanged.

**Supersedes:** EP-TRAIN-5A's `outstandingUniqueKey` identity.

---

## 1. Why

The EP-TRAIN-5A acceptance report surfaced two gaps that make the
dormant obligation model unsuitable for the EP-TRAIN-5B/C flows
without correction:

1. **`TrainingCompletion.@@unique([employeeId, courseVersionId])`**
   prevented an employee from completing the same course version
   more than once. The directive requires MANUAL_REINSTATE and
   REVISION retake flows to leave the earlier completion row
   untouched AND persist a new completion for the retake.

2. **`outstandingUniqueKey = ${employeeId}|${versionId}|${reason}`**
   collapsed two legitimate, independent authorized retake events
   (e.g. a Jan reinstatement and a Feb reinstatement for the same
   employee + course) into a single row. Idempotency against UI
   double-click was correctly guarded, but there was no way to
   distinguish separate authorized actions.

## 2. Schema correction

### TrainingCompletion

| Before (5A)                                              | After (5A-1)                                                                                     |
|----------------------------------------------------------|--------------------------------------------------------------------------------------------------|
| `@@unique([employeeId, courseVersionId])`                | `@@index([employeeId, courseVersionId])` (plain index for lookup speed)                           |
| `attemptId @unique` (already existed)                    | `attemptId @unique` (unchanged — now the sole DB "one completion per event" guard)                |

**No row deleted / reset / modified** — the UNIQUE constraint is
swapped for a plain index of identical columns.

### TrainingObligation

| Before (5A)                                                                              | After (5A-1)                                                                                                    |
|------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|
| `outstandingUniqueKey String? @unique` (set on OUTSTANDING; cleared on terminal)         | removed                                                                                                         |
| idempotency = presence of `outstandingUniqueKey = ${employeeId}\|${versionId}\|${reason}` | `issuanceKey String` (mandatory, caller-supplied)                                                               |
| 1 UNIQUE idx                                                                             | `@@unique([clubId, employeeId, courseVersionId, reason, issuanceKey])`                                          |

Terminal transitions (SATISFIED / CANCELED / SUPERSEDED) **preserve**
`issuanceKey` — a replay of the same authorized event returns the
historical row rather than resurrecting it or inserting a duplicate.

## 3. Issuance key conventions

`issuanceKey` is caller-supplied; the service layer only validates it
is non-empty. The convention per reason:

| Reason             | Convention                           | Source of event id                                                   |
|--------------------|--------------------------------------|----------------------------------------------------------------------|
| `INITIAL`          | `init:<applicabilityWindowBucket>`   | Stable derivation from (employee × version × first-applicable-date)  |
| `REVISION`         | `rev:<publicationEventId>`           | Server-generated per publish-with-retake confirmation (5B)           |
| `MANUAL_REINSTATE` | `rtk:<retakeRequestId>`              | Server-generated per Require-Retake form submission (5B)             |
| `RECERTIFICATION`  | `rec:<certificationCycleId>`         | Future                                                               |

`composeIssuanceKey(reason, eventId)` is exported from
[src/lib/hr/training/obligations.ts](../src/lib/hr/training/obligations.ts)
for pattern consistency.

## 4. Overlapping obligation policy (frozen in 5A-1)

The directive asked to "define whether competing requirements are
consolidated, independently satisfied, canceled, or superseded." The
policy below is what the schema + service module support today:

| Pre-existing OUTSTANDING | New event issuance                     | Action                                                                                 |
|--------------------------|----------------------------------------|----------------------------------------------------------------------------------------|
| None                     | any                                    | Create new OUTSTANDING                                                                 |
| INITIAL on v1            | REVISION on v2                         | New REVISION created; 5B must call `supersedeObligation(oldInitial, newRevision)`      |
| INITIAL on v1            | MANUAL_REINSTATE on v1                 | Both coexist OUTSTANDING; completion is matched FIFO (see §5)                          |
| REVISION on v2           | REVISION on v3 (new publish)           | New REVISION; old REVISION → SUPERSEDED (5B flow)                                       |
| REVISION on v2           | MANUAL_REINSTATE on v2                 | Both coexist OUTSTANDING; independent policies                                         |
| MANUAL_REINSTATE on v1   | REVISION on v2                         | New REVISION; MANUAL_REINSTATE untouched (independent)                                 |
| MANUAL_REINSTATE on v1   | MANUAL_REINSTATE on v1 (SAME key)      | No-op (idempotent)                                                                     |
| MANUAL_REINSTATE on v1   | MANUAL_REINSTATE on v1 (DIFFERENT key) | Both coexist OUTSTANDING (two legitimate separate asks)                                |

## 5. FIFO satisfaction order

`pickObligationToSatisfy({ employeeId, courseVersionId, completionCompletedAt })`
returns the oldest OUTSTANDING obligation (by `issuedAt ASC`) whose
`issuedAt <= completionCompletedAt`. When an employee completes a
version:

- If multiple OUTSTANDING obligations exist for that (employee, version),
  the OLDEST eligible one is satisfied first.
- A future-issued obligation (issuedAt > completion time) is ignored
  (per invariant 3 — old completions cannot auto-satisfy future
  obligations, and symmetrically, a completion earlier than a
  future obligation shouldn't be matched to it).
- Subsequent completions by the same employee satisfy the next
  OUTSTANDING in FIFO order.

Dormant in 5A-1 — no caller consumes this helper. 5C's attempt-
submission path will call it after creating the completion row.

## 6. Dashboard de-duplication (future, 5C)

The directive requires: *"Do not allow duplicate outstanding
requirements to appear on the employee dashboard."* With issuanceKey
in place the DATA MODEL can legitimately carry multiple OUTSTANDING
obligations per (employee, version). The DASHBOARD de-duplicates at
render time:

```ts
// 5C pseudocode
const rail = Array.from(
  outstanding
    .reduce((map, ob) => {
      const key = `${ob.courseVersionId}|${ob.reason}`;
      // Collapse to the EARLIEST issuedAt per (version, reason)
      if (!map.has(key) || ob.issuedAt < map.get(key).issuedAt) map.set(key, ob);
      return map;
    }, new Map())
    .values()
);
```

Each card still represents a single oldest obligation; the FIFO
helper above ensures the completion closes the oldest first. The
other OUTSTANDING rows become visible only AFTER the oldest is
satisfied.

## 7. Migration safety

- **Postgres**: `DROP INDEX IF EXISTS` + `ALTER TABLE DROP/ADD COLUMN`
  — in-place, no table rewrite. Zero rows at staging per 5A
  verification.
- **SQLite**: `PRAGMA foreign_keys=OFF; CREATE TABLE new_...; INSERT
  ... SELECT (with legacy:<id> issuanceKey fallback); DROP TABLE;
  RENAME;` — standard SQLite column-remove recipe.
- `TrainingCompletion`: `DROP INDEX ... _key; CREATE INDEX ..._idx`
  on both engines. Rows untouched.
- Rollback: the pre-5A-1 UNIQUE indexes can be recreated (and the
  new ones dropped) in a reverse migration if needed; `issuanceKey`
  values would be preserved as orphan column data.

## 8. Preservation audit

Chris Turcato's history on Coulee Ridge is untouched:
- TrainingCompletion rows: **9** (identical to 5A baseline)
- TrainingAttempt rows: **30** (identical)
- TrainingProgress rows: **9** (identical)
- TrainingObligation rows: **0** (dormant model, no backfill run)

## 9. Scope boundary

- No manager UI
- No employee dashboard changes
- No publish-with-retake confirmation flow
- No MANUAL_REINSTATE admin action
- No recurring recertification scheduler
- No automatic reassignment

All of the above belong to 5B (manager) and 5C (employee) with
separate founder authorization.
