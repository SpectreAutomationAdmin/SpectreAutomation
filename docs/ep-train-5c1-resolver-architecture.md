# EP-TRAIN-5C-1 — Obligation-Aware Compliance Resolver + Backfill Dry-Run

**Status:** Deployed to staging 2026-11-02 as a dormant foundation.
Introduces an obligation-aware compliance resolver and a backfill
dry-run script. **No employee-facing surface consults the new
resolver yet.** 5C-2 (player engine), 5C-3 (employee UX), and 5C-4
(final activation) remain gated on founder review of the dry-run
report delivered here.

**Supersedes guidance in:** EP-TRAIN-5A §4 "backfill design (NOT YET
RUN)" bullet.

---

## 1. Architecture audit — current employee training lifecycle

Walked every call site that assumes "existing completion ⇒ no
further requirement." Findings in order of blast radius:

### 1.1 Server resolver

[`src/lib/hr/training/applicability.ts`](../src/lib/hr/training/applicability.ts) — the single source of truth for current eligibility:

- `resolveApplicableCourses(employeeId)` — returns the one PUBLISHED
  version per course for which this employee is applicable (via
  all / dept / position / assigned).
- `resolveEmployeeSchedulingEligibility(employeeId)` — joins the
  applicable list with `TrainingCompletion` rows keyed on
  `(employeeId, courseVersionId)`.
  - **Line 240**: `completed: !!completion` — exposes a per-course
    boolean.
  - **Line 247**: `if (completion) continue` — excludes a required
    course from `outstandingTraining` whenever a completion exists on
    the currently-published version id.

**Reads obligations?** No. Pre-5C-1 the resolver is completion-only.

### 1.2 Server attempt / player state

[`src/lib/hr/training/attempts.ts`](../src/lib/hr/training/attempts.ts):

- `getPlayerState` — line 279: `finalAssessmentUnlocked: reasons.length === 0 && completion === null`. A completion row BLOCKS the final-assessment unlock, which also drives the course page's "replay only" mode and the player's `alreadyCompleted` prop.
- `submitAttempt` — write path idempotency guard switched to `attemptId` in EP-TRAIN-5A-1. **No obligation consultation.** When a passing attempt lands, a `TrainingCompletion` is created but NOT linked to any `TrainingObligation.satisfiedByCompletionId`.

### 1.3 Employee course page

[`src/app/employee/(authed)/safety-training/[versionId]/page.tsx`](../src/app/employee/(authed)/safety-training/[versionId]/page.tsx):

- **Line 113**: `completion = findFirst(..., orderBy: completedAt desc)` — "latest completion wins" for the course page.
- **Line 134**: `canRetake = view.version.retakesAllowed && !completion && submittedAttempts.length > 0` — the Retake button appears only when NO completion exists AND submitted attempts exist. This is the biggest source of the "replay-only" trap.
- **Line 152–157**: course state classification is `completed` iff `completion !== null`.
- **Line 169–171**: `outstandingRequired` filter excludes `.completed` courses from the Required Training rail (EP-UX-2B).
- **Line 273**: `alreadyCompleted={completion !== null}` passed to `CoursePlayer`.

### 1.4 CoursePlayer

[`src/app/employee/(authed)/safety-training/[versionId]/CoursePlayer.tsx`](../src/app/employee/(authed)/safety-training/[versionId]/CoursePlayer.tsx):

`alreadyCompleted` is referenced at **9 sites** (lines 227, 254, 417, 469, 491, 538, 582, 848, 855) — guards every state-machine transition that would otherwise start a new attempt:

- Line 254: skip the final-knowledge-test overlay engine.
- Line 417: skip `recordVideoProgress` writes.
- Line 491, 855: skip the final-assessment start / submit paths.
- Line 538: `handleCheckpointTrigger` returns early.
- Line 582, 848: suppress checkpoint overlay opening.

**Consequence**: setting `alreadyCompleted=true` turns the player into pure replay — exactly what EP-TRAIN-4E locked in. A new obligation needs a different seam.

### 1.5 Dashboard

[`src/app/employee/(authed)/safety-training/page.tsx`](../src/app/employee/(authed)/safety-training/page.tsx):

- Line 74–81: `assignedRequiredCount` / `completedRequiredCount` / `completedPercent` all derived from `.completed` booleans — a completed-but-newly-required course would inflate `completedRequiredCount` under the pre-5C derivation.
- Line 103–105: `outstandingRequired` filter excludes `.completed` courses.
- Line 85–87: `completed` section pulls every row with `a.completed === true` for Training History (unchanged behavior — history is correct as-is).

### 1.6 Required Training Rail (course page)

Same shape as dashboard: filters `.completed === false` courses. A revised-training obligation on a completed-but-newly-required course would need to appear here — pre-5C it does not.

### 1.7 Scheduling eligibility

[`src/lib/hr/scheduling-eligibility.ts`](../src/lib/hr/scheduling-eligibility.ts) — gates scheduling writes on `resolveEmployeeSchedulingEligibility(...).eligible`, which currently is `outstandingTraining.length === 0`. If 5C switches the base resolver to be obligation-aware, this gate updates automatically. In 5C-1 it stays as-is.

### 1.8 TrainingProgress uniqueness

[`prisma/schema.prisma`](../prisma/schema.prisma) `TrainingProgress`:

```
@@unique([employeeId, courseVersionId])
```

One progress row per `(employee, version)`. **A retake would reuse the completed row's `secondsWatched` + `farthestSecond` + `checkpointClearedJson`** — directly violating directive §6 "Previous watched coverage must not satisfy the new obligation." This is a 5C-2 concern — the directive calls it out explicitly.

### 1.9 TrainingAttempt uniqueness

```
@@unique([employeeId, courseVersionId, attemptNumber])
```

Per-attempt uniqueness. A retake increments `attemptNumber`. No change needed in 5C-1.

### 1.10 TrainingCompletion ↔ TrainingObligation

[`src/lib/hr/training/attempts.ts`](../src/lib/hr/training/attempts.ts) `submitAttempt`:

- Creates a `TrainingCompletion` row on a passing final attempt.
- **Does NOT link to any obligation** via `satisfiedByCompletionId`.
- The obligation remains OUTSTANDING forever unless manually satisfied via `satisfyObligationWithCompletion`.

**5C-2 fix** (not shipped here): after the completion is created, pick the oldest eligible OUTSTANDING obligation via EP-TRAIN-5A-1's `pickObligationToSatisfy` and call `satisfyObligationWithCompletion` inside the same transaction.

### 1.11 Summary — the 5C surface area

| Layer | Current behavior | 5C-2 / 5C-3 change required |
|---|---|---|
| Dashboard count / rail | Hides completed courses | Must show if OUTSTANDING obligation present (5C-3) |
| Course page `completion` | Latest-wins boolean | Must distinguish "latest + still compliant" from "latest + superseded" (5C-3) |
| Course page `canRetake` | Only after a failed attempt | Must enable when OUTSTANDING obligation exists even if a completion row exists (5C-3) |
| `CoursePlayer.alreadyCompleted` | True iff any completion row | Must be false when a NEW OUTSTANDING obligation exists on this course (5C-3) |
| `TrainingProgress` row | 1 per (employee, version) | Must scope to attempt or obligation for retakes (5C-2) |
| `submitAttempt` completion write | Creates row, no link | Must atomically link to active obligation + mark SATISFIED (5C-2) |
| `getPlayerState.finalAssessmentUnlocked` | Blocked by any completion | Must unlock when a NEW attempt is in progress for an OUTSTANDING obligation (5C-2) |
| Dashboard metrics | Counts completions as current compliance | Must distinguish historical vs current (5C-3) |

---

## 2. New resolver (`resolveEmployeeTrainingCompliance`)

**New module**: [`src/lib/hr/training/compliance-resolver.ts`](../src/lib/hr/training/compliance-resolver.ts).

**Dormant**: not imported from any UI, API route, or employee-facing surface. Exported for the backfill script + for 5C-2/5C-3/5C-4 to consume.

### 2.1 Public shape

```ts
export type ComplianceState =
  | "NO_REQUIREMENT"      // course not applicable
  | "INITIAL_REQUIRED"    // applicable, required, no completion AND no OUTSTANDING obligation
                          //   (pre-5C baseline path for a freshly applicable required course)
  | "COMPLIANT"           // valid completion exists AND no OUTSTANDING obligation
  | "UPDATED_REQUIRED"    // OUTSTANDING REVISION obligation on current (or future) version
  | "RETAKE_REQUIRED"     // OUTSTANDING MANUAL_REINSTATE obligation on current version
  | "IN_PROGRESS"         // one of the above REQUIRED states + progress has advanced
  | "MULTIPLE_OUTSTANDING";

export interface CourseCompliance {
  courseId: string;
  courseTitle: string;
  courseCode: string;
  category: string;
  publishedVersionId: string;
  publishedVersionNumber: number;
  state: ComplianceState;
  /** The oldest actionable OUTSTANDING obligation (FIFO per EP-TRAIN-5A-1 §4).
   *  Null when state === "NO_REQUIREMENT" or "COMPLIANT". */
  activeObligation: {
    obligationId: string;
    reason: "INITIAL" | "REVISION" | "MANUAL_REINSTATE";
    issuedAt: Date;
    dueAt: Date | null;
    courseVersionId: string;
    reasonNote: string | null;
  } | null;
  /** Latest valid completion on the ACTIVE obligation's version (or on
   *  the currently published version when no obligation exists). */
  latestCompletion: {
    completionId: string;
    completedAt: Date;
    score: number;
    courseVersionId: string;
  } | null;
  /** Every historical completion on this course, newest first.
   *  Enables Training History display (directive §8). */
  history: Array<{
    completionId: string;
    completedAt: Date;
    score: number;
    courseVersionId: string;
    courseVersionNumber: number;
  }>;
  /** Count of coexisting OUTSTANDING obligations on this course.
   *  >1 means the Keep-Both path -- UI shows active + "N more to come". */
  outstandingObligationCount: number;
}

export interface EmployeeTrainingCompliance {
  employeeId: string;
  clubId: string;
  /** Summary metrics for the dashboard (directive §4). */
  summary: {
    applicableCourseCount: number;
    requiredCourseCount: number;
    compliantCount: number;
    outstandingObligationCount: number;  // sum of actionable requirements
    inProgressCount: number;
  };
  /** One row per applicable course. */
  courses: CourseCompliance[];
}
```

### 2.2 Resolution algorithm (pure read)

1. Load applicable courses via existing `resolveApplicableCourses`.
2. Load every TrainingCompletion for this employee across every applicable course version (full history).
3. Load every OUTSTANDING TrainingObligation for this employee across every applicable course.
4. For each applicable course:
   a. Pick the oldest OUTSTANDING obligation (FIFO).
   b. Find the latest completion on that obligation's version id.
   c. Classify into one of the 7 non-NO_REQUIREMENT states per the table in §1.11.
   d. Build the `history` list sorted by `completedAt DESC`.
5. Build the summary metrics.

Pure function. No writes. No audit. No side effects.

### 2.3 Grandfathering

The resolver DOES NOT re-apply the publish-time policy (ALL / NON_COMPLETERS / SELECTED). That policy was consumed at publish time by EP-TRAIN-5B — if an employee was grandfathered under NON_COMPLETERS, NO REVISION obligation was issued and the resolver sees `COMPLIANT`. The resolver is purely downstream of the obligation stream.

### 2.4 FIFO + Keep Both

When `outstandingObligationCount > 1`, `activeObligation` is the oldest by `issuedAt ASC`. 5C-3's dashboard shows "1 of N" so the employee knows another requirement is coming. Completing the active obligation satisfies ONE row; the next OUTSTANDING becomes `activeObligation` on refresh.

---

## 3. Backfill dry-run (`scripts/ep-train-5c1-obligation-backfill-dryrun.mjs`)

**Status**: DRY-RUN ONLY. The script refuses any attempt to run with `DRY_RUN=0` and prints a loud message pointing at the activation path (5C-4). Any live backfill requires founder authorization + a separate script.

### 3.1 What it reports

Per directive §3, every (employee × applicable course) pair is classified into one of five categories:

| Category | Meaning | Will the active resolver flag OUTSTANDING? |
|---|---|---|
| `PREVIOUSLY_COMPLETED_COMPLIANT` | Completion exists on currently published version, no OUTSTANDING obligation. **No backfill obligation needed.** | No |
| `APPLICABLE_NOT_COMPLETED` | Required but never completed, no OUTSTANDING. Backfill would issue INITIAL. | Yes (via the backfill INITIAL) |
| `PREVIOUSLY_COMPLETED_REVISION_REQUIRED` | Completion on an older version, OUTSTANDING REVISION on current. **No INITIAL needed** — the REVISION already drives UX. | Yes (via existing REVISION) |
| `PREVIOUSLY_COMPLETED_MANUAL_REINSTATE_REQUIRED` | Completion exists, OUTSTANDING MANUAL_REINSTATE. | Yes (via existing MANUAL_REINSTATE) |
| `NO_APPLICABLE_REQUIRED` | Course not required or not applicable. | No |

Per directive: "Do not issue a new initial obligation to employees whose existing valid completion already satisfies the requirement." → The backfill only writes INITIAL for category `APPLICABLE_NOT_COMPLETED`.

### 3.2 Report payload (JSON printed to stdout)

```json
{
  "ok": true,
  "dryRun": true,
  "runAt": "2026-11-02T...",
  "grandTotals": {
    "clubs": N,
    "employees": N,
    "coursesApplied": N,
    "previouslyCompletedCompliant": N,
    "applicableNotCompleted": N,
    "previouslyCompletedRevisionRequired": N,
    "previouslyCompletedManualReinstateRequired": N,
    "noApplicableRequired": N,
    "potentialConflicts": N
  },
  "proposedNewInitialObligations": N,
  "existingRevisionObligations": N,
  "existingManualReinstateObligations": N,
  "complianceStateChangesOnActivation": {
    "willFlipFromCompliantToOutstanding": [{ employeeId, courseId, reason }, ...],
    "willFlipFromOutstandingToCompliant": [...]
  },
  "perClub": [...],
  "potentialConflictsDetail": [{employeeId, courseId, note}, ...]
}
```

The report is pure read + stdout. No DB writes.

### 3.3 Idempotency design (for the LIVE backfill, 5C-4)

When the activation backfill runs (separate script, separate authorization), it will issue INITIAL obligations with:
- `issuanceKey = init:backfill:<employeeId>:<versionId>` — stable, deterministic.
- `issuedAt = new Date()` — the backfill is a one-time event; the resolver uses `issuedAt <= completedAt` guard to prevent an older completion from auto-satisfying this new INITIAL (per EP-TRAIN-5A-1 invariant 3).

Re-running the live backfill is a no-op per EP-TRAIN-5A-1's composite UNIQUE on `(clubId, employeeId, courseVersionId, reason, issuanceKey)`.

### 3.4 Potential conflicts flagged

The dry-run report also surfaces:
- Employees with existing OUTSTANDING obligations on versions NO LONGER PUBLISHED (orphan obligations) — unexpected, should be investigated before activation.
- Employees whose compliance would flip from "compliant" (pre-5C) to "outstanding" (post-5C) — this should be ONLY employees who have an existing OUTSTANDING REVISION/MANUAL_REINSTATE from 5B workflows that have not yet been exercised.
- Employees whose compliance would flip in the OTHER direction (outstanding → compliant) — this would indicate a bug; expected to be 0.

---

## 4. What this slice does NOT do

- No change to the active `resolveEmployeeSchedulingEligibility` resolver.
- No change to the dashboard, course page, player, or any UI.
- No change to `submitAttempt` — new completions still do not link to obligations.
- No change to `TrainingProgress` uniqueness (5C-2's responsibility).
- No live backfill run — only the dry-run script is deployed.
- No new permissions, API routes, or server actions.
- No schema change.

5C-2 wires the completion write path + progress isolation.
5C-3 integrates the obligation-aware resolver into dashboard + course page + player.
5C-4 runs the live backfill + flips the active resolver.

---

## 5. Preservation invariants (unchanged by 5C-1)

- Chris Turcato's 9 TrainingCompletion + 30 TrainingAttempt + 9 TrainingProgress rows remain byte-for-byte identical.
- EP-TRAIN-4E storage-integrity safeguards unchanged.
- EP-UX-2D layout unchanged.
- Current employee-facing behavior is byte-for-byte identical before and after this slice.

---

## 6. STOP boundary

Per directive §11: **"Begin EP-TRAIN-5C-1 only. STOP after delivering
the resolver architecture and backfill dry-run for founder approval."**

The founder will review the dry-run report produced by
`scripts/ep-train-5c1-obligation-backfill-dryrun.mjs` on staging + the
architecture document above before authorizing EP-TRAIN-5C-2.
