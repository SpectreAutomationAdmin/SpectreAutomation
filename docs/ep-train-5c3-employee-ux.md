# EP-TRAIN-5C-3 — Employee Portal Training Reinstatement Integration

**Status:** Deployed to staging 2026-11-02. Wires the obligation-aware
state into the Employee Portal dashboard + course page + player.
EP-UX-2D layout preserved; no visual redesign.

**Scope boundary (directive §9 "activation boundary"):**

- The pre-5C-3 compliance resolver (`resolveEmployeeSchedulingEligibility`)
  remains the primary signal for applicability, scheduling eligibility,
  and training history.
- The obligation-aware state is overlaid via the EP-TRAIN-5C-1 resolver
  (`resolveEmployeeTrainingCompliance`) ONLY where an OUTSTANDING
  `TrainingObligation` row exists for the (employee × course).
- Pre-5C-4 production has **0 TrainingObligation rows** (dormant since
  5A per 5C-1 — the live backfill is still unauthorized). Every real
  employee sees byte-for-byte the pre-5C-3 EP-UX-2D experience.
- Isolated fixture employees with manually-seeded obligations can
  exercise the new UI without touching legitimate records.

---

## 1. Compatibility boundary — how the UI stays safe

Both resolvers run server-side on every dashboard + course page render:

| Resolver | Pre-5C-3 output | Post-5C-3 output (no obligations) | Post-5C-3 output (with obligations) |
|---|---|---|---|
| `resolveEmployeeSchedulingEligibility` | per-course applicability + per-version completion → `applicable[]` + `outstandingTraining[]` + `eligible` boolean | **Unchanged** | **Unchanged** (still used for applicability, scheduling, history) |
| `resolveEmployeeTrainingCompliance` (NEW consumer) | *(didn't exist)* | returns `state="COMPLIANT"` or `"INITIAL_REQUIRED"` for each applicable row — matches pre-5C-3 semantics 1:1 | returns `UPDATED_REQUIRED` / `RETAKE_REQUIRED` / `MULTIPLE_OUTSTANDING` / `IN_PROGRESS` on the courses with obligations |

The dashboard + course page overlay the compliance-resolver state onto
the applicability rows:

```ts
const complianceStateByCourseId = new Map(compliance.courses.map((c) => [c.courseId, c.state]));
const currentlyCompliantCount = requiredApplicable.filter((a) => {
  const state = complianceStateByCourseId.get(a.courseId);
  if (state === undefined) return a.completed;      // pre-5C-3 fallback
  return state === "COMPLIANT";
}).length;
```

Pre-5C-4 every state resolves to `COMPLIANT` or `INITIAL_REQUIRED`
(because no OUTSTANDING obligations exist), which maps 1:1 to the
pre-5C-3 `a.completed === true` / `a.completed === false` partition.
Dashboard metrics are therefore byte-for-byte unchanged for every
real employee.

## 2. Dashboard changes

[`src/app/employee/(authed)/safety-training/page.tsx`](../src/app/employee/(authed)/safety-training/page.tsx):

- **New summary metric semantics** (directive §4):
  - `currentlyCompliantCount` = courses with `state === "COMPLIANT"` (completion exists AND no OUTSTANDING).
  - `outstandingRequiredCount` = courses with any actionable state (`INITIAL_REQUIRED` / `UPDATED_REQUIRED` / `RETAKE_REQUIRED` / `IN_PROGRESS` / `MULTIPLE_OUTSTANDING`).
  - `completedPercent` and `allCompleted` driven by the new counts — a 100% compliance claim CANNOT be made while any OUTSTANDING retake remains.
- **Required Training list** now includes courses with a historical completion AND an OUTSTANDING obligation.
- **Per-card obligation chip** rendered inline when the obligation state is `UPDATED_REQUIRED` / `RETAKE_REQUIRED` / `IN_PROGRESS` / `MULTIPLE_OUTSTANDING` (no chip for the pre-5C-3 `Required` default).
- **"Multiple completions required" chip** rendered on `MULTIPLE_OUTSTANDING` so the employee understands the Keep Both case.
- The card's link navigates to the course detail URL (which resolves the FIFO oldest obligation on open — directive §3 "The card must navigate to the oldest actionable obligation").

## 3. Course page changes

[`src/app/employee/(authed)/safety-training/[versionId]/page.tsx`](../src/app/employee/(authed)/safety-training/%5BversionId%5D/page.tsx):

- Added `resolveActiveObligationForSession` to the parallel `Promise.all` server-side read.
- **New state classification**: when an active obligation exists, the course `state` becomes `updated-required` / `retake-required` / `initial-required` / `in-progress`. The pre-5C-3 `completed` / `in-progress` / `not-started` states are preserved for the no-obligation path.
- **`alreadyCompleted` handoff to CoursePlayer**: now `treatAsCurrentlyCompleted = activeObligation ? false : (completion !== null)`. When an obligation exists, the player enters the new-attempt flow (EP-TRAIN-5C-2 engine) rather than the replay-only state.
- **`StatePill`** extended with three new variants (same amber palette as In Progress — EP-UX-2D visual system preserved; only the label changes):
  - `updated-required` → "Updated Training Required"
  - `retake-required` → "Retake Required"
  - `initial-required` → "Not Started"
- **`TrainingStatusPanel`** gains two new variants (per directive §5):
  - `updated-required` variant renders "Updated Training Required" + "An updated version of this training is required. Your previous completion remains on record." + optional due date + prior score + prior completed date + "Start Training" button.
  - `retake-required` variant renders "Retake Required" + "Your club has requested that you repeat this training. Your previous completion remains in your training history." + optional truncated reason note + optional due date + prior metrics + "Start Training".
- **`YourResultPanel`** adds an obligation-aware prelude: when a retake / updated-training is outstanding AND a historical completion exists, the panel shows "Your previous completion from X (Y%) remains on record. A new completion is required to satisfy the current requirement." The historical completion is NEVER rewritten as failed / expired / invalid (directive §7).

## 4. CoursePlayer integration

No changes to `CoursePlayer.tsx` itself — the EP-TRAIN-5C-2 server engine already routes progress / attempts / completion through obligation-scoped paths when an active obligation exists. The client-side `alreadyCompleted` prop is now server-derived from the obligation state, so passing `false` for an active-obligation session cleanly enters the new-attempt flow + preserves the EP-TRAIN-4E replay for a legacy session.

## 5. Training History preservation (directive §7)

Historical completion rows remain visible across every surface:

- Dashboard **Training History** tab shows every historical completion ordered by `completedAt DESC` — unchanged.
- Course page **Your Result** tab shows the latest completion AT ALL (via the pre-existing `completion` row read).
- A new historical row created by a retake surfaces automatically — no new UI needed (the resolver already orders completed-list by `completedAt DESC`).

No historical row is labeled failed / expired / invalid because a new obligation was issued.

## 6. Required Training rail (course page right column)

The pre-5C-3 four-state logic (`list` / `final-in-progress` / `all-caught-up` / `none-assigned`) stays. The rail renders the outstanding list from the same obligation-aware filter as the dashboard, so when a retake is issued it stays in the rail even if a historical completion exists.

The rail's `all-caught-up` state can only render when `outstandingRequired.length === 0`, which under the new filter means every applicable course is `COMPLIANT` (no OUTSTANDING obligation anywhere). The directive's requirement "The rail must not display All Caught Up while any actionable requirement remains outstanding" is satisfied by the same derivation.

## 7. Scope protection (directive §11)

Not touched by this slice:
- Employee Portal chrome / sidebar / branding / wordmark.
- Video-player visual styling.
- Course-page layout (grid, columns, hero header).
- Administrative training workflows.
- Other Spectre modules.

The schema is unchanged (5C-2 shipped the TrainingProgress + TrainingAttempt obligationId columns; 5C-3 only adds UI consumption of the existing fields).

## 8. Preservation audit (post-deploy)

- Chris Turcato's `9 TrainingCompletion + 30 TrainingAttempt + 9 TrainingProgress` rows remain byte-for-byte identical.
- `TrainingObligation` row count: **0** (dormant since 5A per 5C-1).
- Every TrainingProgress + TrainingAttempt row still has `obligationId = NULL` (pre-5C-2 legacy).
- Pre-5C-3 user experience: byte-for-byte identical for every real employee (no OUTSTANDING obligations exist → every resolver call returns the pre-5C-3 state).

## 9. STOP boundary

Per directive §12: *"Do not run the live backfill, activate global compliance enforcement, implement recurring recertification or deploy to production."* / *"STOP after EP-TRAIN-5C-3 for founder visual and functional acceptance."*

Not initiating:
- 5C-4 (live backfill + resolver activation + production deployment)
- Recurring recertification
- Production deployment
