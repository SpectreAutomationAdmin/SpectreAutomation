# EP-TRAIN-5C-4B — Compatibility Preflight: STOP finding

**Status:** PREFLIGHT **FAILED**. Pilot NOT executed. Zero writes
performed. Zero obligations issued.

**Trigger:** Founder directive §3 mandatory STOP gate — "Determine
whether the dashboard will show exactly two outstanding courses /
all eight outstanding courses / a combination" and "do not execute
the pilot if the result would be misleading, inconsistent, or
contrary to the approved two-course scope."

**Baseline:** `spectre-staging:sha-a6bf36202d71` (Fly v1074). `/api/health` = 200.
Founder preservation `{9, 30, 9, 0}` byte-identical.

**Decision:** STOP. Pilot cannot execute without a smallest-correction
code change (§5 below). Return findings for founder review.

---

## 1. Preflight question (verbatim §3)

> Determine whether the dashboard will show:
> - Exactly two outstanding courses.
> - All eight outstanding courses.
> - A combination of obligation-aware and legacy-required states.
>
> Also determine whether the current compliance resolver will
> interpret the six non-issued requirements as outstanding.

## 2. Preflight finding — the dashboard would show **all eight outstanding, indistinguishable**

### 2.1 Compliance resolver behaviour (per `src/lib/hr/training/compliance-resolver.ts:231`)

For each applicable course, the resolver classifies into one of 7
states. The relevant branch:

```ts
} else if (latestCompletion) {
  state = "COMPLIANT";
} else if (app.version.required) {
  state = "INITIAL_REQUIRED";          // ← inferred (no obligation needed)
} else {
  state = "NO_REQUIREMENT";
}
```

**`INITIAL_REQUIRED` is INFERRED for every applicable + required
course that has no completion AND no OUTSTANDING obligation.** The
resolver does NOT require an actual `TrainingObligation` row with
reason=INITIAL. It infers the state purely from "no completion +
required + applicable".

Marc's post-pilot resolver output (projected):

| # | Course | Has OUTSTANDING obligation? | Has completion? | Resolver state |
|---|---|---|---|---|
| 1 | ORIENTATION_2027 | **YES (INITIAL)** | no | `INITIAL_REQUIRED` |
| 2 | EQUIPMENT_SAFETY_2026 | no | no | `INITIAL_REQUIRED` |
| 3 | FIRE_SAFETY | **YES (INITIAL)** | no | `INITIAL_REQUIRED` |
| 4 | FOOD_SAFETY_2026 | no | no | `INITIAL_REQUIRED` |
| 5 | DEMO_FR_SAFETY | no | no | `INITIAL_REQUIRED` |
| 6 | KNIFE_SAFETY_2026 | no | no | `INITIAL_REQUIRED` |
| 7 | ROOFTOP_SAFETY_2026 | no | no | `INITIAL_REQUIRED` |
| 8 | GAS_VERSUS_DIESEL | no | no | `INITIAL_REQUIRED` |
| 9 | SAFE-BASICS | no | yes | `COMPLIANT` |
| 10 | B31_STAGING_ACCEPTANCE | no | yes | `COMPLIANT` |

**All 8 non-completed courses return the same state** regardless of
whether an actual obligation row exists.

### 2.2 Dashboard chip rendering (per `src/app/employee/(authed)/safety-training/page.tsx:415`)

```ts
const showObligationChip = obState && obState.label !== "Required";
```

Mapping from state to `obState.label`:
- `UPDATED_REQUIRED` → "Updated Training Required" → chip visible
- `RETAKE_REQUIRED` → "Retake Required" → chip visible
- `IN_PROGRESS` → "In Progress" → chip visible
- `MULTIPLE_OUTSTANDING` → "Additional Retake Required" → chip visible
- `INITIAL_REQUIRED` → **"Required"** → **chip SUPPRESSED**

**Result:** post-pilot, Marc's dashboard would show:
- 8 cards in the Required Training rail (same count as pre-pilot).
- Zero obligation chips rendered on any card (same as pre-pilot — no
  non-"Required" labels anywhere).
- Dashboard summary "outstanding = 8" (same as pre-pilot).
- `data-obligation-label="Required"` on every card (same as pre-pilot).

### 2.3 Course page state pill (per `.../[versionId]/page.tsx:572`)

```ts
if (state === "initial-required") {
  return <span>Not Started</span>;   // stone/grey, no distinguishing text
}
```

**Result:** post-pilot, the course page for ORIENTATION_2027 shows
"Not Started" state pill — **identical to EQUIPMENT_SAFETY_2026**
which has no obligation.

### 2.4 Course page Training Status panel (per same file)

The panel has special variants for `updated-required` and
`retake-required` with explicit labels ("Updated Training Required",
"Retake Required"). For `initial-required` it falls through to the
same default panel as `not-started` — no distinguishing copy or
header.

### 2.5 Your Result tab

Shows an amber "previous completion remains on record" prelude for
`updated-required` + `retake-required` only. `initial-required`
falls through to default — no distinguishing surface.

### 2.6 Required Training rail

Lists every `outstandingRequired` course (all 8 for Marc). Each item
renders the same way; the actual-obligation rows are not visually
distinguished from inferred-INITIAL rows.

---

## 3. Interpretation

Compared against the preflight's multiple-choice options:

| Option | Match? |
|---|---|
| Exactly two outstanding courses | **No** |
| All eight outstanding courses | **Yes** — resolver returns outstanding for all 8 |
| A combination of obligation-aware and legacy-required states | Partially — all 8 are classified by the obligation-aware resolver, but they map to the SAME visible state (`INITIAL_REQUIRED → "Required" → no chip`) |

> "Also determine whether the current compliance resolver will
> interpret the six non-issued requirements as outstanding."

**Yes.** The resolver returns `INITIAL_REQUIRED` for all 6 non-issued
required courses via the inferred branch at `compliance-resolver.ts:234-235`.

> "Do not execute the pilot if the result would be misleading,
> inconsistent, or contrary to the approved two-course scope."

The result is **inconsistent with the approved two-course scope**:
executing the pilot would create 2 OUTSTANDING INITIAL rows in the
database, but the Employee Portal UI would be **byte-identical** to
pre-pilot. Marc's dashboard would still show 8 "Required" cards with
no chips, no state pill difference, no panel difference. The two
issued obligations are invisible at the UI layer.

This **fails** the directive §6 acceptance evidence requirement:
"Verify that the new obligations appear correctly in: Safety &
Training dashboard / Required Training cards / course pages /
Training Status panels / Required Training rail / dashboard
completion metrics." None of these surfaces would render anything
different after the pilot.

### 3.1 What the pilot WOULD prove (if executed)

- Database: 2 OUTSTANDING INITIAL rows written to `TrainingObligation`.
- Audit: 2 `hr.training.obligation.issue.initial.backfill` rows in
  `AuditLog`.
- Idempotency: a rerun yields `{created: 0, skipped: 2}` via the
  composite UNIQUE.
- Tenant isolation: the obligations carry Marc's `employeeId` + the
  Coulee Ridge `clubId`.
- Resolver output: the two obligations become `active.obligationId`
  values on the resolver's `courses[].activeObligation` field —
  queryable but not UI-surfaced.

### 3.2 What the pilot WOULD NOT prove (per directive §6)

- Dashboard renders the obligations differently.
- Course page state pill shows obligation-specific text.
- Required Training card chip changes.
- Summary metrics shift.
- A reviewer can visually confirm the pilot occurred.

---

## 4. STOP boundary

Per directive §3 ("Do not execute the pilot if the result would be
misleading, inconsistent, or contrary to the approved two-course
scope"): **PILOT NOT EXECUTED.** Database counts unchanged. Founder
preservation `{9, 30, 9, 0}` byte-identical.

---

## 5. Smallest recommended corrections

Four options, ordered by scope. **None executed.** All require
founder authorization.

### Option α — UI distinction between actual INITIAL and inferred (smallest)

Add a visual delta for courses that have an actual OUTSTANDING INITIAL
obligation, without changing the resolver's state model.

**Code changes (minimum):**

1. `src/lib/hr/training/compliance-resolver.ts` — no change. The
   resolver already carries `courses[i].activeObligation` which is
   non-null when an actual obligation exists. The UI consumes this
   today.

2. `src/app/employee/(authed)/safety-training/page.tsx` — change the
   chip-visibility logic + the per-course annotation to distinguish:
   ```ts
   // Before:
   if (state === "INITIAL_REQUIRED") { obligationStateByCourseId.set(... { label: "Required", multiple }) }
   // After:
   if (state === "INITIAL_REQUIRED" && compliance?.activeObligation?.reason === "INITIAL") {
     obligationStateByCourseId.set(..., { label: "Initial Training Required", multiple });
   } else if (state === "INITIAL_REQUIRED") {
     obligationStateByCourseId.set(..., { label: "Required", multiple });
   }
   // And relax the chip-visibility guard to include "Initial Training Required".
   const showObligationChip = obState && obState.label !== "Required";
   // (the new "Initial Training Required" label passes this guard automatically)
   ```

3. `src/app/employee/(authed)/safety-training/[versionId]/page.tsx` —
   change `StatePill` + `TrainingStatusPanel` to render
   obligation-backed `initial-required` differently from inferred:
   ```ts
   // StatePill: when state="initial-required" AND activeObligation != null → "Initial Training Required" (amber), else "Not Started" (stone/grey).
   // TrainingStatusPanel: add a new amber variant for state="initial-required" && activeObligation (mirroring the Retake Required variant copy).
   ```

**Effect on data:**
- Marc's 2 pilot courses: dashboard chip "Initial Training Required"; course page state pill "Initial Training Required"; Training Status Panel amber variant.
- Marc's 6 non-pilot courses: dashboard chip SUPPRESSED (as today, labelled "Required"); course page state pill "Not Started"; default status panel.
- Other employees: no change (they have no actual INITIAL obligations, so no chip is added).

**Risks:**
- Zero compliance reversals (resolver unchanged).
- Zero scheduling-eligibility change.
- Requires a staging deploy via DRH-1.
- Must pass the EP-TRAIN-5C-3A/B/C acceptance Playwright before merge (fixture-based regression).

**Blast radius:** low. Narrow UI-only change scoped to the obligation
chip label + the state pill + one panel variant.

### Option β — Narrow course applicability (previously declined under Option C)

Reduce `appliesToDeptIds` / `appliesToPositionIds` on the 6 non-pilot
courses so Marc is no longer applicable. Then his dashboard shows
only ORIENTATION_2027 + FIRE_SAFETY + SAFE-BASICS + B31_STAGING_ACCEPTANCE.
Pilot's 2 obligations are visible by elimination.

**Decline per founder's §2 (configuration policy stays Option C).**

### Option γ — Change the resolver so INITIAL_REQUIRED requires an actual obligation

Flip the inference logic: `INITIAL_REQUIRED` is only returned when an
actual INITIAL obligation exists. Pre-backfill employees with no
completion show `NO_REQUIREMENT` or a new state.

**Risk:** high. This flips every employee's dashboard "outstanding
count" to 0 overnight. Marc currently shows "8 outstanding" — after
this change, he shows "0 outstanding — all caught up". That is a
compliance reversal (willFlipFromCompliantToOutstanding would be
negative, which is new state). The founder's safety invariant from
5C-4A ("zero unexplained reversals") would require explicit override.

**Not recommended.**

### Option δ — Defer the pilot to EP-TRAIN-5C-4C (resolver cutover slice)

Build Option α as part of a dedicated UI slice. Execute the Marc
pilot inside that slice's deploy window, with the new UI distinction
already in place.

**Pros:** cleanest sequencing. Pilot is visible from the first write.

**Cons:** adds a slice before the pilot executes. Pilot timing
deferred.

---

## 6. Recommended path forward

**Option α — small UI code change — before executing the pilot.**

Rationale:
- Smallest total change (3 files, ~15–20 lines).
- Resolver semantics preserved (zero compliance reversals).
- Scheduling-eligibility unchanged (zero scheduling impact).
- Pilot becomes visible on the dashboard chip + course page state
  pill + status panel — all 3 §6 surfaces light up.
- Non-pilot employees unchanged (their inferred `INITIAL_REQUIRED`
  continues to render as "Required" chip-suppressed, which is the
  current product behaviour).

**Required founder authorizations:**
1. Approve Option α as the compatibility correction.
2. Approve a scoped code change + staging deploy to add the three
   new UI branches.
3. Approve re-presenting the 2-obligation pilot after the UI change
   lands (same 2 courses, same issuance keys, same scope).

If the founder prefers Option δ (full slice), confirm that this
preflight finding closes 5C-4B and opens 5C-4C.

---

## 7. What this preflight did NOT do

- Did not execute the pilot.
- Did not issue any obligations.
- Did not modify course configuration.
- Did not change the resolver.
- Did not change scheduling-eligibility code.
- Did not deploy.
- Did not modify Marc's dashboard or any employee's data.

Founder preservation `{9, 30, 9, 0}` and global counts
`{obligations:0, completions:11, attempts:33, progress:12}` are
byte-identical to the 5C-4A acceptance.

---

## 8. STOP boundary (per directive §10)

Not initiating:
- The 2-obligation pilot execution.
- Any Option α / β / γ / δ code change.
- The remaining 39 proposed obligations.
- Course applicability changes.
- Global compliance resolver activation.
- Scheduling-enforcement changes.
- Production deploy.
- Recurring recertification.
- Any modification to unrelated modules.

**Awaiting founder decision on §5 Option α / δ (or an alternative)
before any further action.**
