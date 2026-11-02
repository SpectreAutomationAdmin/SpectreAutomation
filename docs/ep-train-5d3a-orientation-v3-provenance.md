# EP-TRAIN-5D-3A — ORIENTATION_2027 v3 Publication Provenance + Impact Report

**Status:** READ-ONLY provenance investigation complete 2026-11-02.
Zero database writes performed. Zero course modifications. Zero
obligation state transitions during this investigation.

**Baseline:** `spectre-staging:sha-00ef2887abd7` (Fly v1081).

Companion:
- EP-TRAIN-5D-3 acceptance report: `docs/ep-train-5d3-acceptance.md`
- 5D-3 fix commit: `00ef288`

---

## 1. Event timeline (reconstructed from audit chain)

All timestamps UTC on 2026-11-02. All five events on
ORIENTATION_2027 v3 (`cmvzdjzt10002wu9jpfsp9hjc`) by the same
`userId: cmrvdenz700034437agp7gqs5` (**the founder, Chris Turcato's
user account on Coulee Ridge**), from `clubId: cmrvdeny7000144372ktmmg9c`.

| # | Time (UTC) | Audit action | Entity | Detail |
|---|---|---|---|---|
| 1 | 14:49:06.959 | `hr.training.version.draft` | v3 (`cmvz…dpfsp9hjc`) | DRAFT v3 cloned from v2 (`cmvwwd7vw004jjjkgpzpn5tzx`) via `startNewDraft` service. |
| 2 | 14:49:14.531 | `hr.training.version.update` | v3 | Admin edited fields: `title`, `description`, `passingScore`, `retakesAllowed`, `requiresKnowledgeTest`, `required`, `appliesToAll`, `appliesToDeptIds`, `appliesToPositionIds`. |
| 3 | 14:49:19.677 | `hr.training.version.update` | v3 | Admin re-saved — same fields. |
| 4 | 14:49:41.745 | `hr.training.version.publish` | v3 | DRAFT → PUBLISHED. v2 → RETIRED. `publishedByUserId` = founder. |
| 5 | 14:49:42.488 | `hr.training.revision.publish` | v3 | Policy `ALL_APPLICABLE`, `eventId=f5771743-5940-4263-8e08-248a8c5221f7`, `affectedCount=5`, `obligationCount=5`, `supersededObligationCount=1`. |

**Elapsed from first click to policy fire:** 35.5 seconds. The
~8 s / ~5 s / ~22 s pauses between consecutive admin actions are
characteristic of interactive human usage of the admin UI (reading
the form, editing fields, clicking Save, reading the confirm
dialog, clicking Publish).

### 1.1 Correlation with the 5D-3 slice timeline

| Slice event | Approximate time |
|---|---|
| 5D-3 commit `00ef288` pushed | ~14:35 UTC |
| DRH-1 run `41468616046` started | ~14:35 UTC |
| DRH-1 build + web deploy + worker deploy + health complete | ~14:45–14:49 UTC (based on run metadata) |
| New image `sha-00ef2887abd7` serving on Fly | ~14:49 UTC |
| **ORIENTATION_2027 v3 publication (this event)** | **14:49:06 → 14:49:42** |
| 5D-3 staging regression `bxoi56jko` (first attempt, failed on assertion) | 14:49:00–14:49:47 window |
| 5D-3 staging regression `b4050qfe9` (passing) | 15:24 → 15:25 |
| 5C-3C regression `btgcfil3i` | 15:23 → 15:28 |

The ORIENTATION_2027 v3 publication fell **inside** the 5D-3 slice's
total execution window but was **not caused** by the 5D-3 Playwright
test (see §4.1).

---

## 2. Actor + authorization evidence

| Field | Value | Evidence |
|---|---|---|
| Acting user id | `cmrvdenz700034437agp7gqs5` | Audit `userId` on all 5 events + `publishedByUserId` on v3 row. |
| Display name | **Chris Turcato (founder)** | Same user id used throughout prior slices as the founder principal. |
| Session type | Interactive admin browser session on staging | Inferred from timing: 36 s elapsed with human-pace pauses between clicks. |
| Permission required | `hr:training:publish` on `clubId=cmrvdeny7000144372ktmmg9c` | Required by `publishDraftWithPolicy`. |
| Permission granted | Yes | Founder holds CLUB_ADMIN on Coulee Ridge; CLUB_ADMIN grants `hr:training:publish` (per `src/lib/permissions.ts:296`). |
| Admin workflow used | **Legitimate course path** (ORIENTATION_2027, not a disposable fixture) | Course code `ORIENTATION_2027` + course id `cmvvgznyf000gz9nu3nbqm09q` — same course the founder has interacted with in every prior slice. |

**Authorization conclusion:** the publish was executed by the
founder's own authenticated session, through the real admin UI
server-action pathway (`publishDraftWithPolicyAction` →
`publishDraftWithPolicy`), with all required permissions in
place. The server accepted the request because the actor was
authorised to do so.

> **The directive § 2 cautions "Do not infer authorization from
> successful API responses or valid permissions."** The evidence
> supporting authorization is additionally the actor identity
> (founder himself) + interactive timing + the realistic edits made
> on the draft (title/description/thresholds) — all consistent with
> deliberate admin usage, not an unauthorised automation. Whether
> the publication was **intended** (business decision) vs
> **exploratory** (testing the admin UI) can only be confirmed by
> the founder.

---

## 3. v3 content snapshot (as it exists today)

| Field | Value |
|---|---|
| `id` | `cmvzdjzt10002wu9jpfsp9hjc` |
| `courseId` | `cmvvgznyf000gz9nu3nbqm09q` (ORIENTATION_2027, Coulee Ridge) |
| `version` | 3 |
| `state` | PUBLISHED |
| `title` | "Coulee Ridge Staff Orientation" |
| `description` | "Orientation for the upcoming golf season" |
| `passingScore` | 85 |
| `appliesToAll` | **true** |
| `required` | true |
| `videoStorageKey` | present (94 MB, 51 s mp4) |
| `publishedAt` | 2026-11-02T14:49:41.533Z |
| `publishedByUserId` | founder |
| **`checkpoints`** | **`[]` (empty)** |
| **`questions`** | **6 total**, every one with `checkpointId: null`, every one `questionType: SINGLE_CHOICE` |

### 3.1 Clone-pattern evidence: v3 was produced with PRE-5D-3 code

v3 inherited v2's content via `startNewDraft`. The resulting v3
has:
- **Zero checkpoints.** If 5D-3's post-fix code had run, every v2
  checkpoint would have been cloned onto v3.
- **Every question `checkpointId = null`.** If any v2 question was
  checkpoint-bound, the pre-5D-3 code dropped the FK (defect #2).
- **Every question `questionType = SINGLE_CHOICE`.** If any v2
  question was `MULTI_ANSWER` or `TRUE_FALSE`, the pre-5D-3 code
  downgraded it (defect #3).

**This proves the DRH-1 image swap had not yet taken effect when
the clone ran at 14:49:06.** The founder's interactive click
exercised the pre-5D-3 (defective) codepath.

The 5D-3 fix is live NOW; a subsequent "Revise training" click on
any course will preserve checkpoints + bindings + types correctly.

---

## 4. Obligation changes caused by eventId `f5771743-5940-4263-8e08-248a8c5221f7`

5 OUTSTANDING REVISION obligations created + 1 OUTSTANDING INITIAL
obligation superseded.

### 4.1 Per-employee impact table (directive §3)

| Employee | Dept | Prior obligation (course) | New obligation | Reason | Issuance key | Current employee-facing compliance state |
|---|---|---|---|---|---|---|
| **E-FOUNDER-DEMO** FounderDemo DemoEmployee | — | (none) | `cmvzdkr1c001kwu9j9sd3esk5` OUTSTANDING | REVISION | `rev:f5771743…:cmvvgku5e00022ml0iz618mul` | Would see "Updated Training Required" on ORIENTATION_2027. |
| **E-00002 Chris Turcato (founder)** | ADMIN | 2 historical completions on v1 + v2 (both RETIRED, score 100%) | `cmvzdkr54001nwu9jwv18toux` OUTSTANDING | REVISION | `rev:f5771743…:cmu0fiaod000187prcy9ufo2d` | Would see "Updated Training Required" on ORIENTATION_2027 despite the two prior completions, because the current PUBLISHED version is v3 and he has no v3 completion. |
| **E-00003 Marc Maldiney** | ADMIN | **`cmvzb74ed0002g41rrbxtlyk5` OUTSTANDING INITIAL** (5C-4B-β pilot, issued 2026-11-02T13:43:06Z on v2 with key `init:5c4b-marc-pilot:v2`) | `cmvzdkr86001qwu9jckxe8wp2` OUTSTANDING REVISION | REVISION | `rev:f5771743…:cmu0ndf4p001vk9md2ntmo2ck` | Would see "Updated Training Required" on v3. His pilot INITIAL row is NOW SUPERSEDED (not deleted); the SUPERSEDED row carries `supersededByObligationId=cmvzdkr86001qwu9jckxe8wp2` pointing at the new REVISION. |
| **E-PAY1A-Test-A** | — | (none) | `cmvzdkrcy001twu9j5cgpnm68` OUTSTANDING | REVISION | `rev:f5771743…:cmuizrw1w000cgmtia9hma0b6` | Would see "Updated Training Required" on v3. |
| **E-PAY1A-Test-B** | — | (none) | `cmvzdkrgr001wwu9j5ohvu95b` OUTSTANDING | REVISION | `rev:f5771743…:cmuizrw4j000ggmtiq6yutgtz` | Would see "Updated Training Required" on v3. |

### 4.2 Marc Maldiney's complete ORIENTATION_2027 obligation history

| Obligation ID | Reason | Status | Version | Issuanced key | Timeline |
|---|---|---|---|---|---|
| `cmvzb74ed0002g41rrbxtlyk5` | INITIAL | **SUPERSEDED** | v2 (RETIRED) | `init:5c4b-marc-pilot:v2` | Issued 2026-11-02T13:43:06Z by 5C-4B-β pilot. Superseded at 14:49:42.166Z by cmvzdkr86. |
| `cmvzdkr86001qwu9jckxe8wp2` | REVISION | OUTSTANDING | v3 (PUBLISHED) | `rev:f5771743…:marc` | Issued 2026-11-02T14:49:42.101Z. |

**The 5C-4B-β pilot INITIAL obligation row is PRESERVED in the DB
with every field intact (issuanceKey, issuedAt, reasonNote, etc.).
Its status transitioned to SUPERSEDED but the row was not
deleted.** The audit chain + the `supersededByObligationId` pointer
allow full forensic reconstruction.

### 4.3 Marc Maldiney's FIRE_SAFETY obligation (unaffected)

| Obligation ID | Reason | Status | Version | Issuance key |
|---|---|---|---|---|
| `cmvzb74i90007g41ryj0d7rc2` | INITIAL | **OUTSTANDING** | FIRE_SAFETY v1 (PUBLISHED) | `init:5c4b-marc-pilot:v1` |

Marc's FIRE_SAFETY INITIAL is unchanged. The ORIENTATION_2027 v3
publish does not affect FIRE_SAFETY obligations.

### 4.4 Founder's obligation (NEWLY issued)

| Field | Value |
|---|---|
| Obligation ID | `cmvzdkr54001nwu9jwv18toux` |
| Employee | E-00002 Chris Turcato (founder) |
| Status | OUTSTANDING |
| Reason | REVISION |
| Course | ORIENTATION_2027 v3 |
| Issuance key | `rev:f5771743-5940-4263-8e08-248a8c5221f7:cmu0fiaod000187prcy9ufo2d` |
| Issued at | 2026-11-02T14:49:41.991Z |
| Issued by | founder (self-issued via the ALL_APPLICABLE policy) |

**The founder issued himself a REVISION obligation.** This is a
side-effect of using `ALL_APPLICABLE` as the publish policy: the
founder is an active Coulee Ridge employee with no completion on
v3, so the service correctly included him in the applicable set.

### 4.5 Was any other employee affected?

**No.** The investigation queried every OUTSTANDING + SUPERSEDED
obligation with `issuanceKey LIKE '%f5771743%'`. Five OUTSTANDING
REVISIONs + one SUPERSEDED INITIAL. No other employee's compliance
state changed as a side-effect of this event.

---

## 5. Publication semantics validation (directive §4)

| Behaviour | Expected per EP-TRAIN-5B / 5B-1 | Observed | Verdict |
|---|---|---|---|
| v2 → RETIRED on v3 publish | ✅ required | ✅ `v2.retiredAt = 2026-11-02T14:49:41.533Z` | Correct |
| `currentVersionId` flipped to v3 | ✅ required | ✅ `ORIENTATION_2027.currentVersionId = cmvzdjzt10002wu9jpfsp9hjc` | Correct |
| `ALL_APPLICABLE` issues REVISION to every applicable employee | ✅ required | ✅ 5 obligations (all 5 active Coulee Ridge employees) | Correct |
| Prior OUTSTANDING INITIAL/REVISION on older versions of same course → auto-SUPERSEDED | ✅ required | ✅ Marc's INITIAL on v2 → SUPERSEDED with pointer to Marc's new REVISION on v3 | Correct |
| MANUAL_REINSTATE NEVER auto-superseded | ✅ required | ✅ No MANUAL_REINSTATE touched (none existed) | Correct |
| Historical TrainingCompletion preserved | ✅ required | ✅ Chris's v1 + v2 completions preserved intact | Correct |
| Audit trail written | ✅ required | ✅ 5 audit rows in order (draft → update×2 → publish → revision.publish) | Correct |

**All observed transitions are technically correct per the
accepted 5B / 5B-1 governance.** The semantics match the
specification exactly.

### 5.1 Technical correctness ≠ business-intent validation

The directive distinguishes:

- **Technically correct supersession** — ✅ All transitions match EP-TRAIN-5B-1 invariants.
- **Intended business-policy behaviour** — ❓ Cannot be determined from the DB. Only the founder can confirm whether the ALL_APPLICABLE publish was deliberate.
- **Unauthorized or unintended test activity** — ❌ Not from my 5D-3 slice (see §6). Not an automated process. The actor is identifiable as the founder's own browser session.

### 5.2 Is the founder's new obligation "a valid requirement" or "an artifact"?

- **Service semantics:** The obligation is valid. It was issued by the correct code path, with the correct policy, carrying the correct issuanceKey format, written to the composite UNIQUE schema correctly, and auditable.
- **Business validity:** The founder has 2 historical completions on prior versions of ORIENTATION_2027 (v1 + v2). A REVISION obligation on v3 effectively says "the content changed enough that your v2 completion no longer satisfies the current requirement." If the actual v3 content was a substantive revision (new title/description/passing score at 85 vs 80), the obligation is appropriate. If v3 was created exploratively to test the UI with placeholder "Blah?" / "Ta dah?" questions preserved from v2, then the obligation is an artifact of exploratory testing.
- **Decision:** founder's. Only the founder can confirm which case applies.

---

## 6. Was any of this attributable to the 5D-3 slice?

**No.** Specifically:

### 6.1 5D-3 code did NOT cause this

The 5D-3 fix only changes `startNewDraft`'s clone behaviour. It
does not add a publish path, does not call `publishDraftWithPolicy`,
and does not issue obligations.

### 6.2 5D-3 Playwright regression did NOT cause this

- My spec navigates to `/safety-training/<fixture.courseId>` (a disposable fixture course, not ORIENTATION_2027).
- My spec clicks only the `training-start-new-draft` button on the course-detail page. That button's server action is bound to the fixture course id via `startNewDraftAction.bind(null, course.id)`.
- My spec does NOT click Publish or any obligation-issuing control.
- My spec runs `teardownIsolatedFixture` in `finally` which cascades-deletes anything the fixture touched.

The audit chain shows the DRAFT v3 was created on
`cmvvgznyf000gz9nu3nbqm09q` (ORIENTATION_2027). My 5D-3 spec would
have created a DRAFT on a `SLICE3_<runId>` course id instead.

### 6.3 The clone-pattern evidence confirms separation

v3's `checkpoints: []` + `questionType: SINGLE_CHOICE` on all 6
questions proves v3 was produced by **pre-5D-3** code. My DRH-1
deploy of the fixed code had not yet taken effect when v3 was
created. Therefore the clone invocation was NOT via my fixed code
path — it was via the pre-fix code path that was still in service
on an in-flight image swap.

### 6.4 Timing coincidence

The founder's interactive admin session fell within the same
minute as my 5D-3 Playwright window. The coincidence is a race
between the DRH-1 deploy + a human session + a Playwright suite —
not a causal relationship. The 5D-3 slice is cleanly separable.

### 6.5 What the 5D-3 slice itself mutated

Zero legitimate rows. The 5D-3 slice contributions are:
- 1 code commit `00ef288` touching `src/lib/hr/training/courses.ts` + 2 test files.
- 7 Vitest contract tests on SQLite (no staging mutation).
- 1 authenticated staging regression that provisioned 1 disposable fixture, exercised 1 Revise Training click on that fixture, cleaned up in `finally`.
- No obligation issuance; no publish; no course config change; no permission change.

---

## 7. Recommended dispositions (directive §5)

**No corrective action authorized by this report.** The following
options are presented for founder decision; each is explicitly
non-destructive.

Across all options, the following records are **immutable** and
MUST remain:
- Historical TrainingCompletion rows (Chris's v1 + v2 completions).
- The 5 TrainingObligation rows + the 1 SUPERSEDED INITIAL row (as
  audit evidence, regardless of status transition).
- AuditLog entries for the 5 publish events.
- The v3 TrainingCourseVersion row.

### Option A — Accept all transitions as intended

**Action:** nothing. v3 remains PUBLISHED, all 5 REVISION
obligations remain OUTSTANDING, Marc's SUPERSEDED INITIAL remains
SUPERSEDED.

| Consequence | Detail |
|---|---|
| Historical completions | Chris's v1 + v2 completions preserved. v3 completion required to clear his new obligation. |
| Employee-facing compliance | All 5 employees would see "Updated Training Required" on ORIENTATION_2027 (the founder would see it on his own dashboard). |
| Current course version | ORIENTATION_2027 at v3 PUBLISHED (unchanged). |
| Audit history | Unchanged. |
| Future revisions | Normal — the next Revise Training on this course would start from v3 (post-5D-3 code would clone correctly). |
| Scheduling eligibility | Legacy resolver reads TrainingCompletion only; none of these affects scheduling. New resolver (dormant) would classify these as UPDATED_REQUIRED. |
| Marc's 5C-4B-β pilot | Pilot INITIAL on v2 remains SUPERSEDED. The pilot's audit trail is intact. |

### Option B — Cancel the 5 OUTSTANDING REVISION obligations (preserve all history)

**Action (requires separate authorization):** `UPDATE
TrainingObligation SET status='CANCELED', updatedAt=NOW() WHERE id
IN ('cmvzdkr1c…', 'cmvzdkr54…', 'cmvzdkr86…', 'cmvzdkrcy…',
'cmvzdkrgr…')`. Audit each row with action
`hr.training.obligation.cancel.rollback`.

| Consequence | Detail |
|---|---|
| Historical completions | Unchanged. |
| Employee-facing compliance | All 5 employees would stop seeing "Updated Training Required" on v3. The dashboard would still show v3 as applicable + no completion → the legacy resolver would classify as inferred `INITIAL_REQUIRED` (chip-suppressed "Required"). |
| Current course version | ORIENTATION_2027 at v3 PUBLISHED (unchanged). |
| Audit history | Each cancellation written to AuditLog. |
| Future revisions | Normal. If the founder republishes v3's content or publishes a v4 with ALL_APPLICABLE, 5 fresh REVISION obligations would re-issue. |
| Scheduling eligibility | No change (unchanged legacy resolver). |
| Marc's 5C-4B-β pilot | Marc's SUPERSEDED INITIAL stays SUPERSEDED. Canceling the REVISION does NOT restore Marc's INITIAL to OUTSTANDING — the SUPERSEDED status is a one-way transition. |

### Option C — Cancel the 5 REVISIONs AND un-supersede Marc's INITIAL

**Action (requires separate authorization + a stronger justification):**
- Option B's cancels, PLUS:
- `UPDATE TrainingObligation SET status='OUTSTANDING',
  supersededByObligationId=NULL, updatedAt=NOW() WHERE id =
  'cmvzb74ed0002g41rrbxtlyk5'` (Marc's pilot INITIAL back to
  OUTSTANDING).
- Audit with action `hr.training.obligation.restore.rollback`.

| Consequence | Detail |
|---|---|
| Historical completions | Unchanged. |
| Employee-facing compliance | 5 REVISIONs canceled. Marc's INITIAL on v2 restored. But v2 is RETIRED — Marc's INITIAL now points at a RETIRED version, which is semantically awkward (the resolver would surface it as `activeObligation` even though the current PUBLISHED version is v3). |
| Current course version | ORIENTATION_2027 at v3 PUBLISHED. v2 RETIRED. |
| Audit history | Each cancel + restore written to AuditLog. |
| Future revisions | Semantically fragile: a subsequent revision publish would auto-supersede Marc's restored INITIAL again. |
| Scheduling eligibility | No change. |
| Marc's 5C-4B-β pilot | Restored to OUTSTANDING on v2. The pilot evidence is restored but the course version it targets is retired. |

**Not recommended.** The 5B-1 supersession is deliberately one-way,
and un-superseding violates the invariant the system is built on.

### Option D — Retire v3 and restore v2 as the current PUBLISHED version

**Action (requires separate authorization + significant
destructiveness):**
- `UPDATE TrainingCourseVersion SET state='RETIRED', retiredAt=NOW() WHERE id='cmvzdjzt10002wu9jpfsp9hjc'`
- `UPDATE TrainingCourseVersion SET state='PUBLISHED', retiredAt=NULL WHERE id='cmvwwd7vw004jjjkgpzpn5tzx'`
- `UPDATE TrainingCourse SET currentVersionId='cmvwwd7vw004jjjkgpzpn5tzx' WHERE id='cmvvgznyf000gz9nu3nbqm09q'`
- Cancel + restore obligations as in Option C.

| Consequence | Detail |
|---|---|
| Historical completions | Unchanged. |
| Employee-facing compliance | Reverts to pre-14:49 state. The founder's dashboard shows ORIENTATION_2027 as COMPLIANT (his v2 completion satisfies v2 again). |
| Current course version | Reverts to v2. v3 marked RETIRED. |
| Audit history | New cancel + restore + publish-state-revert rows added. |
| Future revisions | Normal — the next Revise Training on this course would start from v2 again (post-5D-3 code would clone correctly). |
| Scheduling eligibility | No change (legacy resolver). |
| Marc's 5C-4B-β pilot | Restored to OUTSTANDING on v2 (now PUBLISHED again). |

**Not recommended.** Flipping a PUBLISHED version back from
RETIRED is unprecedented in the EP-TRAIN-5 series and not supported
by any existing admin UI control. It would require a bespoke
one-off script. The audit trail would be more complex than
preserving the current state.

---

## 8. Required correction to future acceptance-test isolation (directive §7.6)

### 8.1 Observed risk

Acceptance tests + interactive admin UI usage can share the same
staging DB. During a DRH-1 deploy window + an active test run,
concurrent human admin clicks can co-mingle with test-driven
fixture activity. The ORIENTATION_2027 v3 event illustrates this
cleanly.

### 8.2 What this event DID NOT prove

- A defect in my 5D-3 fix: it did not run against the fixed code
  (clone artefact proves pre-5D-3 code was in service).
- A defect in the 5D-3 regression spec: it never touches
  ORIENTATION_2027.
- A defect in `publishDraftWithPolicy`: all transitions were
  correct per 5B-1.

### 8.3 Recommended mitigations (NOT implemented in this report)

1. **Snapshot-before-slice preservation gate.** Add a one-shot
   SSH-only script invoked at the START of every acceptance slice
   that captures:
   - Fly image sha.
   - Global counts (obligations/completions/attempts/progress).
   - Founder preservation record.
   - Marc's pilot obligations list (id + status + updatedAt).
   Save to `test-results/preslice-baseline-<timestamp>.json`.
   The slice's acceptance report then diffs against this baseline
   row-by-row so unrelated activity is cleanly separable.

2. **Acceptance-window announcement convention.** When running a
   staging regression, the slice author announces the time window
   so the founder knows interactive admin use may collide. This is
   an operational convention, not code.

3. **No automated remediation.** The directive explicitly prohibits
   automatic rollback. Preserving the audit chain + presenting the
   options is the correct forensic posture.

Each mitigation is non-destructive, additive, and non-urgent. The
5D-3 fix stands on its own evidence.

---

## 9. Preservation audit at end of 5D-3A

| Record | Required | Observed |
|---|---|---|
| Founder completions | 9 | **9** ✅ |
| Founder attempts | 30 | **30** ✅ |
| Founder progress | 9 | **9** ✅ |
| Marc FIRE_SAFETY INITIAL | OUTSTANDING | **OUTSTANDING** ✅ |
| Marc ORIENTATION_2027 INITIAL (5C-4B-β pilot row) | status stable during investigation | **SUPERSEDED** since 14:49:42 (preserved during this investigation) ✅ |
| Founder's new REVISION obligation | status stable during investigation | **OUTSTANDING** (unchanged by investigation) ✅ |
| Fly image | unchanged | `sha-00ef2887abd7` (unchanged) ✅ |
| `/api/health` | 200 | **200** ✅ |

Zero database writes performed during this investigation. The
SSH scripts executed only `prisma.findUnique`, `findMany`,
`count` — no mutations.

---

## 10. STOP

Not initiating:
- Any obligation cancellation.
- Any obligation restoration / un-supersession.
- Any version-state transition.
- Any publication reversal.
- Any permission change.
- Any resolver activation.
- Any scheduling-enforcement change.
- Any deployment.

Awaiting founder decision on §7 Option A vs Option B (or alternative).
