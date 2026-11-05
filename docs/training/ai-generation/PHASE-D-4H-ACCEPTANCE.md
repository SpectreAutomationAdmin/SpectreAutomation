# EP-TRAIN-6D-4H — Historical AI Candidate Import — Acceptance (STAGING)

> **Status.** READY FOR FOUNDER VISUAL REVIEW — 2026-11-05.
>
> **Scope delivered.** 8 authentic EP-TRAIN-6C historical AI
> candidates imported into the persisted AI-review tables on
> staging under the Coulee Ridge development tenant. Original
> question text, answers, citations, validation verdicts and model
> provenance preserved byte-identical. Source-organization
> mismatch (Silver Springs) explicitly flagged. Six founder-facing
> screenshots captured on the deployed persisted-review surface.
>
> **Scope withheld.** No new inference. No Modal / Qwen activation.
> No persisted mutations (approve / edit / reject / revalidate /
> regenerate / archive). No training publication. No employee
> training assignments. No production touched.

---

## 1. Historical candidate inventory

| # | Label | Pilot | Question type | Topic |
|---|---|---|---|---|
| Q1 | `q1-criticism-must-offer-solution`     | EP-TRAIN-6C-9  | SINGLE_CHOICE | Raising workplace concerns requires offering a solution |
| Q2 | `q2-scholarship-nov1-deadline`         | EP-TRAIN-6C-9  | TRUE_FALSE    | Scholarship awareness + November 1st application deadline |
| Q3 | `q3-safety-near-miss-reporting`        | EP-TRAIN-6C-9  | SINGLE_CHOICE | Health-and-safety committee + near-miss reporting |
| Q4 | `q4-member-experience-framing`         | EP-TRAIN-6C-11 | TRUE_FALSE    | Silver Springs member-experience framing |
| Q5 | `q5-no-phones-in-front-of-members`     | EP-TRAIN-6C-11 | TRUE_FALSE    | Phone-policy rule — no phones in front of members |
| Q6 | `q6-phone-call-discretion-back-room`   | EP-TRAIN-6C-11 | TRUE_FALSE    | Phone-call discretion — go to a back room; be discreet |
| Q7 | `q7-negativity-principle`              | EP-TRAIN-6C-11 | TRUE_FALSE    | Workplace culture — negativity breeds more negativity |
| Q8 | `q8-parking-policy`                    | EP-TRAIN-6C-11 | SINGLE_CHOICE | Parking policy — staff on street; members/guests in lot |

Source of record for these candidates:
[src/components/ai-training/fixtures.ts](../../../src/components/ai-training/fixtures.ts),
which was itself seeded from the real Modal A10 pilot runs
EP-TRAIN-6C-9 (Q1-Q3) and EP-TRAIN-6C-11 (Q4-Q8), with
byte-perfect capture per the EP-TRAIN-6C-11 acceptance commit
`a865fe4e` on branch `ep-train-6c-11/wider-coverage-pilot`.

---

## 2. Provenance and integrity assessment

### Immutable source bindings (per-candidate, preserved verbatim)

| Field | Value | Status |
|---|---|---|
| Tenant (clubId) | `cmrvdeny7000144372ktmmg9c` (Coulee Ridge development tenant) | Preserved |
| Course (id) | `cmvzs3vz9000256qcu7lfysoz` ("2026 Employee Rules and Perks - Staff Orientation") | Preserved |
| Course version (id) | `cmvzs3w05000456qcgfgps7gy` (version 1, state=**DRAFT**) | Preserved; DRAFT state confirmed |
| Source video SHA-256 | `d1ddb823437c78478c5f2388b5daa42c957a8706afcce871bd6a522801efee29` | Matches version row byte-identical |
| Resolved transcript build id | `d138a72b1c3eee7329629f5759e528ca8dbeee5000a71a698f512e78191a2237` | Preserved |
| Pilot authorization fingerprint | `fixture-not-live` (per fixture) | Preserved — explicitly marks these as non-live |
| Grounding projection SHA | `fixture-<label>` (per fixture) | Preserved verbatim; never recomputed |

### Governance preflights (run before any write)

The import script refuses to proceed unless ALL of the following
hold:

1. Course `cmvzs3vz9000256qcu7lfysoz` exists AND `retiredAt IS NULL`.
2. Course `clubId === cmrvdeny7000144372ktmmg9c`.
3. Course version `cmvzs3w05000456qcgfgps7gy` exists AND `retiredAt IS NULL`.
4. Course version `courseId === cmvzs3vz9000256qcu7lfysoz`.
5. Course version `state === "DRAFT"` (refuses non-DRAFT).
6. Course version `videoSha256 === d1ddb823437c78478c5f2388b5daa42c957a8706afcce871bd6a522801efee29`.
7. The historical payload is non-empty and shipped as a readable JSON file (not reconstructed from CLI args).

All seven passed.

### Source-organization mismatch preservation

The source video belongs to **Silver Springs Golf & Country
Club**, held in the Coulee Ridge development tenant. The
directive explicitly requires this mismatch to be preserved — the
content must NOT be reinterpreted as Coulee Ridge policy.

- **All 8 imported drafts preserve verbatim "Silver Springs"
  references** in their `draftJson` body (verified by Prisma
  `COUNT(*) WHERE draftJson CONTAINS "Silver Springs" = 8`).
- The real validator produces `SOURCE_ORG_MISMATCH` advisory flags
  on the appropriate candidates (Q2, Q3, Q4 carry the flag; see
  the per-fixture verdict table below).
- None of the imported drafts were edited to substitute Coulee
  Ridge or any other club name.

### Unverified transcript segment handling

Transcript segments **16 and 17** are listed as excluded on every
fixture's `authorization.pilotRestrictions.excludedSegmentIds`.
Verified by inspection: none of the 8 fixtures' grounding passages
or draft `sourceSegmentIds` reference segment 16 or 17. The
`excludedSegmentIds: [16, 17]` field is preserved verbatim on the
imported generation-run provenance (via the per-fixture
`pilotAuthorizationId`).

### Validator provenance

Every validation record carries `validatorSource: "6d-4h-historical"`
to distinguish it from both live-pipeline inferences and fixture
replays. The authentic verdicts were computed offline on the local
machine by running the real `validateTrainingQuestion` pipeline
([src/lib/training/ai-generation/pipeline.ts](../../../src/lib/training/ai-generation/pipeline.ts))
against each fixture's `(draft, grounding, authorization)` triple.
The script, inputs, and raw output live in
`scratchpad/ep-train-6d4h/` (gitignored).

---

## 3. Imported candidate IDs + verdict map

Deterministic draft IDs allow idempotent re-runs without
duplication. Idempotency verified by running the import script
twice; the second run produced `delta: {runs: 0, drafts: 0, validations: 0}`.

| Draft ID | Verdict | Persisted state | Errors | Flags |
|---|---|---|---|---|
| `draft_hist_6c_q1-criticism-must-offer-solution` | REQUIRES_HUMAN_VERIFICATION | REQUIRES_HUMAN_REVIEW | 0 | 1 (FLAG_UNSUPPORTED_ANSWER_WORDS) |
| `draft_hist_6c_q2-scholarship-nov1-deadline`     | **REJECTED** | **REJECTED** | 1 | 2 (incl. SOURCE_ORG_MISMATCH) |
| `draft_hist_6c_q3-safety-near-miss-reporting`    | **REJECTED** | **REJECTED** | 3 (OSHA + regulatory-body + insurance) | 2 (incl. SOURCE_ORG_MISMATCH) |
| `draft_hist_6c_q4-member-experience-framing`     | REQUIRES_HUMAN_VERIFICATION | REQUIRES_HUMAN_REVIEW | 0 | 2 (incl. SOURCE_ORG_MISMATCH) |
| `draft_hist_6c_q5-no-phones-in-front-of-members` | REQUIRES_HUMAN_VERIFICATION | REQUIRES_HUMAN_REVIEW | 0 | 1 |
| `draft_hist_6c_q6-phone-call-discretion-back-room` | **REJECTED** | **REJECTED** | 2 (ERR_UNSUPPORTED_NAMED_ENTITY_SUBJECT × 2 — "administrator" attribution) | 1 |
| `draft_hist_6c_q7-negativity-principle`          | REQUIRES_HUMAN_VERIFICATION | REQUIRES_HUMAN_REVIEW | 0 | 2 |
| `draft_hist_6c_q8-parking-policy`                | REQUIRES_HUMAN_VERIFICATION | REQUIRES_HUMAN_REVIEW | 0 | 1 |

**Verdict totals:**
- REQUIRES_HUMAN_VERIFICATION: 5
- REJECTED: 3

**State totals (on staging):**
- REQUIRES_HUMAN_REVIEW: 5
- REJECTED: 3

### Rejected-candidate invariance

The three REJECTED candidates (Q2, Q3, Q6) remain in state
`REJECTED` on staging and **cannot be approved**:

1. The persisted-review UI renders every mutation control as
   `disabled` by construction
   ([src/components/ai-training/PersistedReviewWorkspace.tsx](../../../src/components/ai-training/PersistedReviewWorkspace.tsx)).
2. No mutation API routes exist on the deployed surface — only GET.
3. No lifecycle transition exists from `REJECTED` to any approved
   state unless the user holds `hr:training:ai:remediate-rejected`,
   which is SUPER_ADMIN-only.
4. Even if an approval attempt were made, the approval guard
   ([src/lib/hr/training/ai-review/approval-guard.ts](../../../src/lib/hr/training/ai-review/approval-guard.ts))
   rejects approval unless the most-recent validation verdict is
   `GROUNDED` AND state is `REQUIRES_HUMAN_REVIEW` — neither is
   true for any REJECTED row.

---

## 4. Source evidence references

The source video (`d1ddb823...efee29`) is the Silver Springs staff
orientation recording held in Coulee Ridge's development tenant.
The resolved transcript (build id `d138a72b...1a2237`) was
produced during EP-TRAIN-6C-8 and has been immutable since. Every
grounding passage on every imported draft cites one of the
20 transcript segments (excluding segments 16 + 17).

| Candidate | sourceSegmentIds cited | sourceWindow (sec) |
|---|---|---|
| Q1 | [5, 8] | 24.84 – 55.08 |
| Q2 | [12, 13, 14, 15] | 55.08 – 88.12 |
| Q3 | [19] | 132.3 – 155.0 |
| Q4 | [0] | 0 – 4.58 |
| Q5 | [1, 2] | 4.58 – 16.28 |
| Q6 | [3, 4] | 16.78 – 24.84 |
| Q7 | [10] | 53.2 – 54.78 |
| Q8 | [18] | 118.9 – 131.4 |

No segment 16 or 17 appears in any imported row.

---

## 5. Staging screenshots (deployed persisted-review surface)

All screenshots captured via
[tests/e2e/ep-train-6d4h-staging-acceptance.staging.spec.ts](../../../tests/e2e/ep-train-6d4h-staging-acceptance.staging.spec.ts)
on the deployed staging application (Fly v1094 /
`sha-12e18ff76074`) using the founder's CLUB_ADMIN session.

| # | Viewport | Subject | Artifact |
|---|---|---|---|
| 1 | Desktop 1440 × 900 | Candidate queue (all 8 rows) with Q1 selected | `test-results/ep-train-6d4h/01-candidate-queue-with-q1-selected-1440x900.png` |
| 2 | Desktop 1440 × 900 | REQUIRES_HUMAN_REVIEW detail — Q8 parking (rubric 96/100) | `test-results/ep-train-6d4h/02-detail-requires-human-review-q8-1440x900.png` |
| 3 | Desktop 1440 × 900 | REJECTED detail — Q3 with 3 hard errors (OSHA + regulatory-body + insurance) + 2 advisories | `test-results/ep-train-6d4h/03-detail-rejected-q3-with-hard-errors-1440x900.png` |
| 4 | Desktop 1440 × 900 | Q4 detail — SOURCE_ORG_MISMATCH + unsupported-words advisory | `test-results/ep-train-6d4h/04-detail-source-org-mismatch-q4-1440x900.png` |
| 5 | Desktop 1440 × 900 | Queue filtered to REJECTED only (3 rows) — Q6 selected showing "administrator" attribution hard errors | `test-results/ep-train-6d4h/05-queue-filtered-rejected-only-1440x900.png` |
| 6 | Mobile 390 × 844 | Q1 detail on mobile | `test-results/ep-train-6d4h/06-detail-q1-390x844.png` |

### What the screenshots show

- **Review Queue header reports 8 candidates** (reduces to 3 under
  `?state=REJECTED`) — accurate reflection of the imported set.
- **Mode notice banner** on every screen: "You are inspecting
  persisted records. Every mutation (approve, edit, reject,
  revalidate, regenerate, publish) is disabled by design. Only a
  separately authorised slice will enable review mutations."
- **Source evidence panel** shows real course version
  `cmvzs3w05000456qcgfgps7gy`, video SHA `d1ddb823437c7847…`,
  transcript build `d138a72b1c3eee73…`, grounding
  `fixture-q<N>…`, with cited segment chips (`seg 5`, `seg 8`,
  `seg 19`, etc.).
- **Hard errors panel** renders real validator outputs, e.g. for
  Q3: `ERR_CITATION_SEGMENT_UNAUTHORIZED` ("proposal introduces
  policy term 'osha' not present in any cited passage"),
  `ERR_UNSUPPORTED_REGULATORY_BODY` ("proposal references
  regulatory body 'osha' not present in any cited passage"),
  `ERR_UNSUPPORTED_INSURANCE_REFERENCE` ("proposal references
  insurance concept 'insurance company' not present in any cited
  passage").
- **Advisory flags panel** renders `SOURCE_ORG_MISMATCH`
  (Silver Springs) and `FLAG_UNSUPPORTED_ANSWER_WORDS` where the
  validator produced them.
- **Read-only.** The Playwright spec programmatically asserts
  that zero enabled buttons matching "Approve", "Edit", "Reject",
  "Revalidate", or "Request regeneration" exist on any of these
  screens. PASS.
- **Silver Springs visible verbatim** on Q3 question text
  ("…the primary goal of the health and safety committee at
  Silver Springs according to the administrator's instructions
  on staff orientation…") — source-org mismatch is preserved on
  the user-visible surface, not hidden.

---

## 6. Tenant isolation verification

| Check | Result |
|---|---|
| Rows with `id STARTS WITH "draft_hist_6c_"` on tenants OTHER than Coulee Ridge | **0** |
| Rows with `id STARTS WITH "draft_hist_6c_"` on Coulee Ridge | 8 |
| Drafts referencing "Silver Springs" in `draftJson` | 8 (all 8 imported) |
| Total AI drafts across all tenants (pre-import) | 0 |
| Total AI drafts across all tenants (post-import) | 8 |
| Published `TrainingQuestion` rows on target course version | **0 — unchanged** |

The import added exactly 8 drafts, exactly 8 validations, and
exactly 2 generation runs — all on Coulee Ridge — with no
cross-tenant drift and no modification to any published training
question.

Additionally verified read-side: an unauthenticated
`GET /api/admin/ai-training/drafts` returns 401 (6D-4G guard
remains intact). A CLUB_ADMIN session on a tenant other than
Coulee Ridge would see 0 rows (the tenant-scoped service filter
in [src/lib/hr/training/ai-review/read-service.ts](../../../src/lib/hr/training/ai-review/read-service.ts)
enforces `WHERE clubId = principal.activeClubId` on every query).

---

## 7. Rollback / cleanup procedure

**Rollback script:** `scratchpad/ep-train-6d4h/rollback-historical.mjs`
(gitignored; preserved on the author's workstation).

Steps:

```powershell
# Upload rollback script to the Fly container (uses MSYS_NO_PATHCONV
# on Git Bash to avoid Windows path translation).
MSYS_NO_PATHCONV=1 flyctl ssh sftp put `
  scratchpad/ep-train-6d4h/rollback-historical.mjs `
  /app/rollback.mjs --app spectre-staging

# Execute rollback.
MSYS_NO_PATHCONV=1 flyctl ssh console --app spectre-staging `
  -C "sh -c `"node /app/rollback.mjs && rm -f /app/rollback.mjs`""
```

The script:
- Verifies every matched row has `clubId = cmrvdeny7000144372ktmmg9c`
  before deleting (aborts on any cross-tenant drift).
- Deletes in dependency order: state transitions → operation keys
  → reviews → validations → drafts → generation runs.
- Reports pre/post counts + a `parityCheck` field (PASS when
  `preCount - matchedRows === postCount`).
- Preserves every published training question, training
  assignment, training completion, and training course row.

Idempotent: a second rollback run produces zero deletions.

---

## 8. Founder visual-review checklist

Open `https://staging.spectreautomation.com` as
`cturcato@spectreautomation.com` (CLUB_ADMIN on Coulee Ridge).

- [ ] Navigate to `/app/admin/ai-training/review/persisted`.
- [ ] Review queue header reads **"8 candidates in queue"**.
- [ ] Top row is `q1-criticism-must-offer-solution`
      (SINGLE_CHOICE, REQUIRES_HUMAN_REVIEW).
- [ ] Open Q3 (`q3-safety-near-miss-reporting`). Verify the
      REJECTED badge is visible and the "HARD ERRORS (3)" panel
      lists OSHA / regulatory-body / insurance.
- [ ] Open Q6 (`q6-phone-call-discretion-back-room`). Verify
      REJECTED + 2 hard errors about the "administrator"
      attribution.
- [ ] Open Q4 (`q4-member-experience-framing`). Verify the
      SOURCE_ORG_MISMATCH advisory flag is visible — this is
      the Silver Springs vs. Coulee Ridge call-out.
- [ ] Filter the queue to `?state=REJECTED`. Verify header reads
      "3 candidates in queue" and only Q2, Q3, Q6 appear.
- [ ] Filter to `?state=REQUIRES_HUMAN_REVIEW`. Verify header
      reads "5 candidates in queue" and Q1/Q4/Q5/Q7/Q8 appear.
- [ ] On every detail screen, confirm no Approve / Edit / Reject /
      Revalidate / Request-regeneration button is enabled.
- [ ] Open a candidate on a phone (≤ 390 px wide). Verify the
      PERSISTED REVIEW badge + MODE NOTICE banner remain visible.

If every line reads true, the manager review interface meets
the EP-TRAIN-6D-4H acceptance standard: authentic historical
AI-generated candidates with trustworthy provenance, rendered in
the read-only surface without introducing any consequential
workflow.

---

## 9. Scripts + artifacts

| Artifact | Path |
|---|---|
| Validator computation (local) | `scratchpad/ep-train-6d4h/compute-validations.ts` (gitignored) |
| Historical payload (local) | `scratchpad/ep-train-6d4h/historical-candidates.json` (gitignored) |
| Import script | `scratchpad/ep-train-6d4h/import-historical.mjs` (gitignored) |
| Rollback script | `scratchpad/ep-train-6d4h/rollback-historical.mjs` (gitignored) |
| Playwright spec | [tests/e2e/ep-train-6d4h-staging-acceptance.staging.spec.ts](../../../tests/e2e/ep-train-6d4h-staging-acceptance.staging.spec.ts) |
| Six screenshots | `test-results/ep-train-6d4h/01…06-*.png` |
| Fixture source of truth | [src/components/ai-training/fixtures.ts](../../../src/components/ai-training/fixtures.ts) |
| Validator | [src/lib/training/ai-generation/pipeline.ts](../../../src/lib/training/ai-generation/pipeline.ts) |
| Deployed baseline (unchanged) | web Fly v1094 / `sha-12e18ff76074`, worker v330 / `sha-12e18ff76074` |

No new Fly deployment was required for this slice — the import
runs entirely in the existing release image via SSH.

---

## 10. Scope boundaries honoured

- No new AI questions generated (0 Modal / Qwen invocations).
- No live inference activated.
- No publication of any training course version.
- No employee training obligation created.
- No `TrainingQuestion`, `TrainingAssignment`, `TrainingCompletion`,
  `TrainingObligation`, `TrainingCourse`, or `TrainingCourseVersion`
  row modified.
- No production touched.
- No modification of any RBAC grant (6D-4G's CLUB_ADMIN →
  `hr:training:ai:read` grant remains the only AI permission in
  CLUB_ADMIN's catalogue).
- No fabrication of validation evidence — all verdicts come from
  the real `validateTrainingQuestion` pipeline run against the
  authentic fixture inputs.

---

## 11. STOP

Per the directive's "Mandatory STOP":

- Do not activate Modal or Qwen — done.
- Do not generate new questions — done.
- Do not enable editing, approval, rejection or publication — done.
- Do not modify production — done.
- Do not begin the next functional development slice — awaiting
  founder review.

Rollback is available via `scratchpad/ep-train-6d4h/rollback-historical.mjs`
(see §7 above) and leaves the AI-review tables empty on Coulee
Ridge once executed.
