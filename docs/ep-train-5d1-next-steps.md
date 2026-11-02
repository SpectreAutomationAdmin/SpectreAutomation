# EP-TRAIN-5D-1 — Recommended Next Steps

**Status:** Recommendation only. Nothing listed below is authorized
by this audit. The founder decides which (if any) of these to
pursue.

**Baseline at audit end:** `spectre-staging:sha-79b05f36616d`.
Marc's 2 OUTSTANDING INITIAL obligations preserved. Founder
`{9, 30, 9, 0}` byte-identical.

---

## 1. Short recommendation list

| # | Recommendation | Category | Scope | Blast radius | Priority |
|---|---|---|---|---|---|
| R1 | Course-level bulk-assign picker on the "Applicable employees" roster of the course detail page. | 3 (refinement) + 4 (bulk) | Small — 1 new component + 1 server action wrapping the existing `assignCourseToEmployee` in a batched loop + audit per row. | UI-only + per-row writes. Zero resolver change. | High |
| R2 | Applicability-change preview on `PublishRevisionDialog` + a new "scoped preview" link on the version editor's `ApplicabilityPicker`. | 3 (refinement) | Small — new `previewApplicabilityTargets` service + 1 UI drawer. | Read-only + UI. | High |
| R3 | Inline hint on the `ApplicabilityPicker`'s "Assign individually" radio: *"To add employees to this course, open each employee's profile → + Assign training."* Optionally a deep-link to the employee roster. | 3 (refinement) | Trivial — copy change. | Zero. | Low |
| R4 | CSV export on the compliance dashboard. | 4 (partial) + 5 (missing export) | Small — one API route + a download button. | Read-only. | Medium |
| R5 | Overdue training surface on the compliance dashboard: a filter + a prominent "N obligations overdue" count. | 5 (missing surface) | Small — resolver already has `dueAt`; add a filter + a count card. | Read-only. | Medium |
| R6 | Server-side pagination on the compliance roll-up for larger clubs. | 3 (refinement) | Small — add `?page=N&limit=M` to the compliance page. | Read-only. | Medium (becomes blocker beyond ~50 employees per club) |
| R7 | Fix the known checkpoint-clone defect in `startNewDraft` (does NOT clone checkpoints — admin must re-create them on each Revise). | 4 (partial) | Small — extend the clone loop in `courses.ts:385-480` to also clone checkpoints + question↔checkpoint FK map. | Service change + migration-free (reads only). Requires a deploy + regression on 5C-3C §2 publish-revision path. | High |
| R8 | RECERTIFICATION obligation path + scheduler (time-based retake). | 5 (missing) | Medium — new issuance service + a worker/cron for interval-based re-issuance. | Introduces new write path; needs its own compatibility preflight. | **Deferred** — not needed for Marc's pilot or broader rollout; consider only after R1–R7. |
| R9 | Obligation-aware scheduling-eligibility cutover (make `resolveEmployeeTrainingCompliance` the scheduling authority). | 5 (dormant resolver cutover) | Medium — flag + compatibility preflight similar to the 5C-4B-α pattern. | Changes the global scheduling signal. **Explicit founder gate required per the 5C-4A plan §6.** | **Deferred** — strategic decision, not a feature gap. |

## 2. Prioritised ordering

Based on **operational speed** (R1 > R3 > R7), **compliance clarity**
(R2 > R5 > R6), and **reporting** (R4):

**Phase 1 — Discoverability + reporting refinements (small UI slices):**
1. R3 (inline hint — trivial)
2. R1 (course-level bulk-assign picker — the biggest UX win)
3. R2 (applicability-change preview)
4. R4 (CSV export)

**Phase 2 — Scaling refinements:**
5. R6 (pagination)
6. R5 (overdue surface)

**Phase 3 — Known defects + new paths (defer until Phase 1 shipped):**
7. R7 (checkpoint clone on Revise)
8. R8 (RECERTIFICATION path — only if needed by product)

**Phase 4 — Policy / strategic:**
9. R9 (scheduling-eligibility cutover — founder decision)

## 3. What NOT to build (would duplicate existing functionality)

**Do NOT propose or build:**

- Any "introduce department / position applicability" feature — the
  3-way ApplicabilityPicker already exists.
- Any "revise training" workflow — Revise Training + Publish
  Revision + 3 policies are live.
- Any "retake obligations" issuance mechanism — Require Retake
  dialog + MANUAL_REINSTATE service + Keep Both / Replace are live.
- Any "historical completion preservation on revision" guarantee —
  it is a schema invariant across every revision + retake path.
- Any "obligation-aware employee UI" rebuild — EP-TRAIN-5C-3 +
  5C-4B-α cover it.
- Any "per-course roster of applicable employees" — the course
  detail already renders it (read-only).

## 4. Risk + mitigation summary

Each recommended slice is additive — none require backward-
incompatible schema migrations or changes to the obligation stream.
R7 (checkpoint clone) carries the only semantic risk: the current
Revise flow explicitly leaves the DRAFT checkpoint-less so the
admin reconsiders them per revision. If the clone is added, the
admin would need an explicit "clear all checkpoints" affordance.
Design decision for the founder before implementation.

## 5. Final answer to directive §10 Q5

**"What should be improved first?"**

**R1 — Course-level bulk-assign picker.** Rationale:
- Resolves the single biggest UX discoverability gap identified
  in §1.
- Delivers immediate operational speed-up for the common "assign
  this course to a cohort" workflow.
- Reuses existing service (`assignCourseToEmployee`) with no
  resolver or schema change.
- Composable with R2 (preview) and R3 (hint) as a single Phase 1
  bundle.

Approximate effort: 1 small slice (UI + batched action wrapper +
Playwright acceptance). No DRH-1 or production impact beyond a
standard staging deploy.

## STOP

This document is a RECOMMENDATION. The founder decides which
items advance to authorization. No implementation initiated.
