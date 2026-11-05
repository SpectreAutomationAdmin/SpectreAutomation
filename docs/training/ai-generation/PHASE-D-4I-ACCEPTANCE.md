# EP-TRAIN-6D-4I — Persisted AI Review UX & Evidence Fidelity — Acceptance (STAGING)

> **Status.** READY FOR FOUNDER ACCEPTANCE — 2026-11-05.
>
> **Scope delivered.** Reviewer-first persisted AI review surface
> with: single-stem question presentation, unified lifecycle +
> validation status, concise queue rows, reviewer-first source
> evidence panel with plain-language errors + advisories + explicit
> "transcript body not persisted" callout + collapsible technical
> provenance, and an honest fixture-placeholder badge on grounding
> fingerprints that aren't real SHAs. Approved global chrome
> (sidebar, brand, typography, three-column layout) preserved
> verbatim.
>
> **Scope withheld.** No new inference. No Modal / Qwen. No new
> mutation endpoints. No approve / edit / reject / revalidate /
> regenerate / publish surface. No schema change. No RBAC change.
> No new permission grants. No production. The 8 historical
> candidates from EP-TRAIN-6D-4H remain on staging, unchanged.

---

## 1. Deployment

| | Pre-6D-4I | Deployed |
|---|---|---|
| Web | Fly v1094 / `sha-12e18ff76074` | **Fly v1095** / `sha-5e60fa59894f` |
| Worker | Fly v330 / `sha-12e18ff76074` | **Fly v331** / `sha-5e60fa59894f` |

[DRH-1 run 42033904363](https://github.com/SpectreAutomationAdmin/SpectreAutomation/actions/runs/42033904363) — **success**.
`/api/health` returned HTTP 200 post-deploy. `sync-rbac` ran and
reported `permissions:201 roles:14 rolePermissions_upserted:748 pruned:0`
(unchanged from 6D-4G — no new grants).

Rollback anchor: commit `12e18ff7` / image `sha-12e18ff76074` on
`staging-deploy/ep-train-6d-4g-club-admin-read-grant`.

---

## 2. Investigation — `fixture-q8` grounding identifier

### Origin

The identifier `fixture-q8` (and `fixture-q1` through `fixture-q7`)
was synthesized by the EP-TRAIN-6D-1 fixture authoring helper at
[src/components/ai-training/fixtures.ts:119](../../../src/components/ai-training/fixtures.ts#L119):

```ts
function makeAuth(label: string): PilotAuthorizationV1 {
  return {
    ...
    approvedGroundingProjectionSha256: "fixture-" + label,
    ...
    fingerprint: "fixture-not-live",
  };
}
```

It is explicitly a placeholder, not a cryptographic hash. The real
EP-TRAIN-6C pilot runs did compute a grounding projection SHA, but
when the fixture file was created in EP-TRAIN-6D-1 the original SHA
was replaced with this placeholder string so the UI would not
present fixture data as having a recoverable hash.

EP-TRAIN-6D-4H (the historical import) correctly carried the
placeholder through verbatim rather than inventing a fake SHA. This
is the right posture — but the 6D-4H UI rendered the placeholder as
if it were a hash (`Grounding fixture-q8...`), which was
misleading at a glance.

### Resolution in this slice

- The UI gates the "fixture placeholder" badge on
  `isRealSha256(detail.groundingProjectionSha256)` — exactly 64
  lowercase hex characters. Any future row with a real SHA renders
  without the fixture tag.
- When the value does NOT match, the collapsible provenance footer
  renders the full value + an amber `FIXTURE PLACEHOLDER` badge +
  the reviewer-facing note: *"This candidate was imported from a
  historical pilot where the grounding projection hash was not
  retained. The cited segments and validation remain authoritative;
  the grounding fingerprint is a fixture placeholder."*

Verified on staging in the Q8 provenance-open screenshot
(`test-results/ep-train-6d4i/after/q8-after-provenance-open-1440x900.png`,
visible mid-right of the TECHNICAL PROVENANCE section).

---

## 3. Source-evidence panel — reviewer-first layout

The directive called this out as highest priority. The new layout
leads with what the reviewer actually needs, and never invents
transcript excerpts or timestamps.

### What the reviewer sees now (top → bottom)

| Block | Content | Source |
|---|---|---|
| Panel title | "What the model saw" (friendly) | — |
| **Source material** | Course title, course version (number + title), video presence + duration | Live join on `TrainingCourse` + `TrainingCourseVersion` (tenant-guarded in the server page) |
| Source-org mismatch | Amber alert callout with reviewer guidance (ONLY when `SOURCE_ORG_MISMATCH` flag is on the latest validation) | `detail.latestValidation.flags` |
| **Cited transcript segments** | Segment-id chips (e.g. `seg 5`, `seg 8`) | `detail.draft.sourceSegmentIds` |
| Transcript body callout | Explicit "Not persisted on the AI-review schema in this slice" + reviewer guidance to consult the source video / resolved transcript | Honest schema-gap callout |
| Timestamp callout | Explicit "Timestamps per cited segment are not persisted either" | Honest schema-gap callout |
| **Validation errors** | ONE row per error: plain-language summary (via `ERROR_CODE_LABELS` curated map) + raw code preserved below for audit | `detail.latestValidation.errors` |
| **Advisories** | ONE row per flag: plain-language summary (via `FLAG_LABELS` curated map) + raw code preserved below for audit | `detail.latestValidation.flags` |
| Clean-run confirmation | Emerald "No validation errors and no advisories recorded" (only when both arrays are empty) | — |
| Historical validations | Compact audit trail | `detail.historicalValidations` |
| **Technical provenance** | Collapsible `<details>` with all SHAs + IDs + fixture-placeholder badge + reviewer note | `detail.*` SHAs + `isRealSha256()` gate |

### Evidence-fidelity invariants (enforced by code + Playwright)

1. **No invented transcript excerpts.** The `CandidateDetail`
   interface has no transcript-body field
   ([src/lib/hr/training/ai-review/read-service.ts:110](../../../src/lib/hr/training/ai-review/read-service.ts#L110)
   comment: *"Source-material metadata only. NO transcript bodies."*).
   The UI never synthesizes any text from the cited segment IDs.
2. **No invented timestamps.** The schema does not persist per-passage
   start/end seconds; the UI renders only the segment IDs and says so.
3. **Explicit unavailable state** for transcript body, timestamps,
   and video playback. All three are reviewer-visible callouts, not
   hidden silence.
4. **Fixture-placeholder honesty** (see §2 above).
5. **Validator errors + flags** show plain language + raw code; the
   plain-language mapping lives in `ERROR_CODE_LABELS` and
   `FLAG_LABELS` constants and is curated, not auto-generated.
6. **Playwright assertion** that the schema-gap callouts are visible
   on the aside: `tests/e2e/ep-train-6d4i-after.staging.spec.ts`
   checks "Transcript body", "Not persisted on the AI-review schema
   in this slice", and "Timestamps per cited segment are not
   persisted" are all present in the deployed aside.

### Schema / data gaps reported

The persisted AI-review schema (
[prisma-postgres/schema.prisma](../../../prisma-postgres/schema.prisma))
does not store:

- Transcript passage text (the `GroundingPassage.text` body).
- Per-passage `startSec` / `endSec`.
- A human-readable source-organisation name — mismatch is only
  signalled through the `SOURCE_ORG_MISMATCH` flag; the UI
  surfaces the flag with reviewer guidance but cannot show the
  mismatched org name directly.
- The source video's filename or human-readable title; we show
  the course version's title + duration instead.

Any future consequential workflow that depends on reviewers reading
the actual transcript body will need a separately-authorised slice
to extend the schema and the write path. This slice does NOT make
that change.

---

## 4. Question presentation — de-duplicated stem

### Before

Header rendered `detail.draft.questionText.slice(0, 120)` as a
truncated `<h2>` AND the body rendered the full question under
"MODEL-GENERATED QUESTION" — the reviewer saw the question twice.

### After

Header renders ONLY the question-type eyebrow + unified status
badge + subline + generated date + record version. The question
body appears ONCE under a single "QUESTION" eyebrow, large serif,
followed by answer choices and the model explanation. The correct
answer indicator (emerald background, CORRECT label) is unchanged.

---

## 5. Review queue — meaningful summaries

### Before

Each row showed `{r.draftId.slice(0, 8)}` ("draft_hi…") as the
primary string, with the question title underneath. Three independent
badges (state + verdict + err/flag counts) clustered on one line.

### After

Each row shows:
- **Question title** (full, up to one clause / 90 chars). The
  `queueTitle()` helper strips any `[TEST FIXTURE …]` prefix and
  truncates at the first sentence boundary.
- One **lifecycle pill** — plain-language label (`Needs review`,
  `Rejected`, `Approved`, `Validating`, `Edited (stale)`, …).
- One **compact validation pill** — strongest-signal-wins
  (`N errors` > `Rejected` > `N advisories` > `Grounded` /
  `Pending validation` / `Clean`).
- Compact "Generated YYYY-MM-DD" footer.
- Full `draftId` is preserved in the `title` tooltip (accessible
  on hover) and in the `aria-label`.

---

## 6. Status hierarchy — one primary, one subline

### Before

Two badges: the lifecycle state (`REQUIRES_HUMAN_REVIEW`) and the
validation verdict (`REQUIRES_HUMAN_VERIFICATION`). Reviewer could
not tell which was which, and the overlap read as duplication.

### After

A single `computeStatus(detail)` function collapses lifecycle +
verdict into ONE primary label with a tone-matched badge AND a
one-line subline that explains the state in reviewer terms:

| State / verdict | Primary label | Tone | Subline |
|---|---|---|---|
| REJECTED (state or verdict) | "Rejected" | danger | "N hard validation errors — this candidate cannot be approved." |
| APPROVED_DRAFT | "Approved draft" | success | "Draft approved. Publication requires a separate authorised step." |
| ARCHIVED | "Archived" | neutral | "Historical record — superseded or past retention." |
| VALIDATION_FAILED | "Validation failed" | danger | "An internal validation run did not complete. Re-run required." |
| VALIDATION_PENDING / GENERATED | "Awaiting validation" | neutral | "Validator has not produced a verdict for the current content yet." |
| EDITED_VALIDATION_STALE | "Edited — revalidation needed" | warning | "The draft was edited after validation; current verdict is stale." |
| REQUIRES_HUMAN_REVIEW + verdict REQUIRES_HUMAN_VERIFICATION | "Needs reviewer decision" | warning | "Validator passed hard checks but flagged N advisor(ies) for human confirmation. Not approved — not grounded." |
| REQUIRES_HUMAN_REVIEW (other) | "Needs reviewer decision" | warning | "Queued for human reviewer attention." |

The directive's "Do not imply REQUIRES_HUMAN_VERIFICATION means
the candidate is grounded or approved" is explicitly honoured by
the subline wording **"Not approved — not grounded."**

---

## 7. Layout + global chrome

- Three-column grid preserved verbatim:
  `lg:grid-cols-[280px_minmax(0,1fr)_380px]` with `gap-6`, inside
  `max-w-[1600px]`.
- Sidebar, brand, typography, admin top-bar — unchanged.
- Serif display font + stone palette — unchanged.
- The admin surface's top-bar wordmark + breadcrumb + user chip —
  unchanged.

### Mobile observation (not fixed in this slice — per directive)

At 390 × 844 the admin sidebar remains expanded, consuming roughly
half the viewport. This is inherited from the admin layout chrome
and is out of scope per the directive's *"Review mobile behavior at
390 × 844 **without altering global navigation unless separately
authorized**."* The persisted-review content itself renders inside
whatever width the admin layout gives it; the mode notice banner,
PERSISTED REVIEW badge, breadcrumb and brand remain visible. A
future slice would need to address the admin sidebar's responsive
collapse behaviour independently.

---

## 8. Before / after evidence

All screenshots captured via authenticated CLUB_ADMIN session
(`cturcato@spectreautomation.com`) against the deployed staging
application. BEFORE on Fly v1094 (6D-4H baseline); AFTER on Fly
v1095 (6D-4I).

| Subject | Viewport | BEFORE | AFTER |
|---|---|---|---|
| Q8 — REQUIRES_HUMAN_REVIEW (parking) | 1440 × 900 | `test-results/ep-train-6d4i/before/q8-before-1440x900.png` | `test-results/ep-train-6d4i/after/q8-after-1440x900.png` |
| Q6 — REJECTED (administrator attribution) | 1440 × 900 | `test-results/ep-train-6d4i/before/q6-before-1440x900.png` | `test-results/ep-train-6d4i/after/q6-after-1440x900.png` |
| Q3 — REJECTED (OSHA + regulator + insurance) | 1440 × 900 | `test-results/ep-train-6d4i/before/q3-before-1440x900.png` | `test-results/ep-train-6d4i/after/q3-after-1440x900.png` |
| Q8 with technical-provenance OPEN | 1440 × 900 full-page | — | `test-results/ep-train-6d4i/after/q8-after-provenance-open-1440x900.png` |
| Q8 on mobile | 390 × 844 | `test-results/ep-train-6d4i/before/mobile-q8-before-390x844.png` | `test-results/ep-train-6d4i/after/mobile-q8-after-390x844.png` |

### Delta highlights (per the Q8 after shot)

- Queue rows now read as questions, not IDs.
- Center column: "NEEDS REVIEWER DECISION" + subline "Validator
  passed hard checks but flagged 1 advisory for human confirmation.
  Not approved — not grounded." This is the clearest possible
  reading of `REQUIRES_HUMAN_VERIFICATION`.
- Right column: Course / Version / Video rendered as reviewer-facing
  text instead of hash fingerprints; cited segment with explicit
  "Transcript body not persisted" callout + timestamp callout;
  advisories in plain language ("Answer wording introduces phrasing
  beyond what the cited passages support.") with the raw
  `FLAG_UNSUPPORTED_ANSWER_WORDS` code preserved underneath.
- Collapsible "TECHNICAL PROVENANCE (SHOW HASHES + IDS)" footer at
  the bottom of the evidence panel; opens via native `<details>`.
- In the provenance-open shot: `GROUNDING FINGERPRINT fixture-q8`
  with amber **FIXTURE PLACEHOLDER** badge + reviewer note.

### Delta highlights (per the Q3 after shot)

- "REJECTED" primary badge + "3 hard validation errors — this
  candidate cannot be approved." subline.
- **"SOURCE-ORGANISATION MISMATCH"** dedicated amber callout at
  the top of the evidence panel — explicit, not hidden as a chip
  at the bottom.

---

## 9. Invariants verified post-deploy

| Invariant | Mechanism | Result |
|---|---|---|
| All 8 historical candidates remain unchanged | Playwright AFTER spec asserts `GET /api/admin/ai-training/drafts?limit=50` returns `rows.length === 8` | PASS |
| Original source text + validation verdicts intact | Rows + validator payloads unchanged in DB; UI screenshots show the same question text, same verdict categories | PASS |
| No invented evidence or timestamps | Playwright asserts the "Not persisted on the AI-review schema in this slice" + "Timestamps per cited segment are not persisted" callouts render on the deployed aside | PASS |
| Tenant isolation unchanged | Server page still gates on `hr:training:ai:read` + `clubId` filter; schema unchanged | PASS |
| No new mutation endpoints | 6D-4G `/api/admin/ai-training/drafts` still GET-only (contract tests + the 6D-4G Playwright POST → 405 assertion remain valid; no new route added) | PASS |
| All approve/edit/reject controls remain disabled | Playwright AFTER spec asserts zero enabled `Approve`/`Edit`/`Reject`/`Revalidate`/`Request regeneration` buttons | PASS |
| No published training records modified | Import-side invariant from 6D-4H holds — no code in this slice touches `TrainingQuestion`, `TrainingAssignment`, `TrainingCompletion` or `TrainingObligation` | PASS |
| RBAC / permissions unchanged | No edit to `src/lib/permissions.ts`; sync-rbac logged `pruned:0` on deploy | PASS |
| Schema / migrations unchanged | `git diff` on `prisma/` and `prisma-postgres/` returns empty | PASS |

---

## 10. Scripts + artifacts

| Artifact | Path |
|---|---|
| Server page change | [src/app/app/admin/ai-training/review/persisted/page.tsx](../../../src/app/app/admin/ai-training/review/persisted/page.tsx) |
| Workspace rewrite | [src/components/ai-training/PersistedReviewWorkspace.tsx](../../../src/components/ai-training/PersistedReviewWorkspace.tsx) |
| BEFORE Playwright | [tests/e2e/ep-train-6d4i-before.staging.spec.ts](../../../tests/e2e/ep-train-6d4i-before.staging.spec.ts) |
| AFTER Playwright | [tests/e2e/ep-train-6d4i-after.staging.spec.ts](../../../tests/e2e/ep-train-6d4i-after.staging.spec.ts) |
| BEFORE screenshots | `test-results/ep-train-6d4i/before/*.png` (4 files) |
| AFTER screenshots | `test-results/ep-train-6d4i/after/*.png` (5 files) |
| Deployed baseline | Fly v1095 / `sha-5e60fa59894f` (web + worker) |
| Rollback anchor | Fly v1094 / `sha-12e18ff76074` |
| DRH-1 run | https://github.com/SpectreAutomationAdmin/SpectreAutomation/actions/runs/42033904363 |
| Phase-1 commit | `5e60fa59` on `staging-deploy/ep-train-6d-4i-review-ux` |

---

## 11. Founder visual-review checklist

Log in as `cturcato@spectreautomation.com` (CLUB_ADMIN on Coulee
Ridge) and open
`https://staging.spectreautomation.com/app/admin/ai-training/review/persisted`.

- [ ] Review queue header reads "8 candidates in queue".
- [ ] Queue rows read as questions, not IDs. One lifecycle pill +
      one validation pill per row.
- [ ] Open Q8 (parking-policy). Verify:
  - [ ] Single "NEEDS REVIEWER DECISION" badge with subline
        explaining REQUIRES_HUMAN_VERIFICATION ≠ grounded / approved.
  - [ ] Question stem appears exactly once.
  - [ ] "What the model saw" evidence panel leads with Course /
        Version / Video (not hashes).
  - [ ] "Transcript body" callout explicitly says "Not persisted…".
  - [ ] "Timestamps per cited segment are not persisted either."
  - [ ] Click "TECHNICAL PROVENANCE (show hashes + IDs)" to expand.
        Grounding fingerprint `fixture-q8` carries the amber
        "FIXTURE PLACEHOLDER" badge + reviewer note.
- [ ] Open Q3 (safety-near-miss). Verify:
  - [ ] "REJECTED" badge + "3 hard validation errors — this
        candidate cannot be approved." subline.
  - [ ] Dedicated "SOURCE-ORGANISATION MISMATCH" amber callout at
        the top of the evidence panel.
  - [ ] 3 validation errors rendered in plain language with raw
        codes preserved beneath.
- [ ] Open Q6 (phone-call-discretion). Verify:
  - [ ] "REJECTED" + "2 hard validation errors" subline.
  - [ ] "Subject of the obligation is ambiguous…" plain-language
        rendering of ERR_UNSUPPORTED_NAMED_ENTITY_SUBJECT.
- [ ] Confirm no "Approve / Edit / Reject / Revalidate / Request
      regeneration" button is enabled on any screen.
- [ ] Confirm the brand chrome (sidebar, breadcrumb, wordmark)
      remains identical to the pre-6D-4I state.

---

## 12. STOP

Per the directive's final section:

- No Modal / Qwen inference — done.
- No new generation — done.
- No approval, editing, regeneration or publication — done.
- No production deployment — done.
- Unrelated WIP files preserved — done (branch returned to
  `staging-deploy/web1b1-framer-fidelity` with the stashed 126
  pre-existing files restored via `git stash pop`).

Rollback remains available via re-deploying commit `12e18ff7` /
image `sha-12e18ff76074`. No further functional development will
begin without a new founder directive.
