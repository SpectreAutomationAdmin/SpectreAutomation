# EP-TRAIN-6D-4P — Interactive AI Training Reviewer UX — Design

Status: offline implementation complete; staging deployment / visual
acceptance deferred. 4N remains the server authority — this slice
adds presentation + interaction on top of it, nothing else.

## 1. Baseline

- Parent: EP-TRAIN-6D-4N (`dcc26122`) on
  `ep-train-6d-4n/human-verification-approval`.
- Server contract: `POST /api/admin/ai-training/drafts/[id]/approve`
  defined by 4N. Request contract + 17 rejection rules unchanged.
- Permission gate: existing `hr:training:ai:approve` grant. CLUB_ADMIN
  retains `hr:training:ai:read` ONLY. No new RBAC permission. No new
  role grants. No schema change.
- No new API endpoint. 4P is a browser + jsdom + disposable-PG16 slice.
- Historical EP-TRAIN-6D-4H candidates remain read-only + unapproved.

## 2. Objective

Give an authorized reviewer an inspectable, deliberate approval
experience that:

1. presents the exact immutable question + options the server stored;
2. requires an independent human answer selection (no preselection of
   the model prediction);
3. requires a conscious evidence-verification attestation;
4. submits a fully-formed 4N request contract against the already-
   accepted server endpoint;
5. handles every 4N refusal shape visibly, without optimistic UI; and
6. renders the authoritative "Verified correct" chip ONLY after a
   fresh server read confirms the verified-answer snapshot resolves
   via the 4N verified-answer reader (hash + validation + option
   binding + lifecycle integrity all intact).

## 3. Three-column workspace — preserved

4P adds controls to the `PersistedReviewWorkspace`'s middle column
WITHOUT redesigning:

- Spectre's accepted administrative shell + typography.
- The queue panel (left).
- The evidence panel (right).
- The three-column breakpoints.
- The status hierarchy / badges / tones.
- The mobile evidence collapse behavior.
- The 4M "Historical evidence unavailable" + integrity-failure
  treatments.
- The 4N emerald "Verified correct" rendering (the UI STILL only
  renders emerald on `verifiedAnswer.kind === "verified"`).

The only material visual change in this slice is an additional
**Reviewer decision** block beneath the question body. In the
previously-shipped 4M build, that block carried disabled buttons and
a "read-only" notice. 4P promotes the "Approve" control for
`hr:training:ai:approve`-bearing principals, opens an
**Approval dialog**, and preserves the disabled appearance + rationale
for everyone else.

## 4. Server-derived eligibility

The server (`page.tsx`) is the single authority for whether the
Approval dialog may open. It computes a `reviewerEligibility` object
once per request and passes it to the workspace:

```ts
interface ReviewerEligibility {
  readonly canApprove: boolean;         // hr:training:ai:approve on this club
  readonly reviewerUserId: string;      // the signed-in principal's id
  readonly reviewerDisplayName: string; // email or legal name
  readonly selectedDraftEligibility: {
    readonly eligible: boolean;         // overall gate, server-decided
    readonly reasons: readonly EligibilityReason[]; // zero or more
  } | null;                              // null when no draft selected
}

type EligibilityReason =
  | "STATE_NOT_REQUIRES_HUMAN_REVIEW"   // ARCHIVED / REJECTED / APPROVED / etc
  | "QUESTION_TYPE_UNSUPPORTED"         // MULTI_ANSWER refused by 4N
  | "HISTORICAL_EVIDENCE_UNAVAILABLE"   // 6D-4H row
  | "EVIDENCE_INTEGRITY_FAILURE"        // reader fail-closed
  | "VALIDATION_HAS_HARD_ERRORS"        // can't approve a REJECTED candidate
  | "ALREADY_VERIFIED"                  // 4N snapshot resolves "verified"
  | "VALIDATION_ROW_MISSING";
```

The client NEVER recomputes these. It consumes `eligibility.eligible`
as an OPAQUE boolean. The server remains the authority (per directive
§4: "Do not reproduce the 4B/4N governance logic as an independent
client-side authority").

### 4a. Why a client flag is NOT an authorization shortcut

`canApprove === true` only opens the dialog. The dialog's submit
button posts to `/api/admin/ai-training/drafts/[id]/approve`, which
still enforces every 4N gate server-side. An attacker tampering with
`canApprove` in devtools gains no privilege — the route re-checks
`hasPermission(principal, clubId, "hr:training:ai:approve")` on every
request. The client flag is a presentation convenience.

Likewise, `selectedDraftEligibility.eligible === true` only skips the
dialog's eligibility banner. The server still refuses ineligible
drafts with the same 4N `ApprovalRejectedError` codes.

## 5. ApprovalDialog component

### 5.1 Shape

```
┌─────────────────────────────────────────────────────────┐
│  Approve candidate                                  ✕   │
│  AI-assisted training · manager review                  │
├─────────────────────────────────────────────────────────┤
│  ⓘ  Approving a candidate records your verified         │
│     answer selection and promotes this draft to         │
│     APPROVED_DRAFT. This action is auditable and        │
│     cannot be reversed from this screen.                │
├─────────────────────────────────────────────────────────┤
│  Question                                               │
│  <immutable question text, rendered verbatim>           │
│                                                         │
│  Choose the verified correct answer                     │
│  ◯  A. <option>                                         │
│  ◯  B. <option>  ← Model-selected · unverified          │
│  ◯  C. <option>                                         │
│  ◯  D. <option>                                         │
│                                                         │
│  ☐  I have reviewed the source evidence (required)      │
│                                                         │
│  Reviewer note (optional, max 2000 chars)               │
│  [                                                    ] │
│                                                         │
│  ─────────────────────────────────────────────────      │
│  Request fingerprint                                    │
│    draft v{n} · hash {first-8}… · validation {id-8}…    │
│  Idempotency key                                        │
│    {uuid-first-8}…  ↻ regenerate                        │
├─────────────────────────────────────────────────────────┤
│  <error banner — rendered on failure only>              │
├─────────────────────────────────────────────────────────┤
│                        [Cancel]  [Approve candidate]    │
└─────────────────────────────────────────────────────────┘
```

Styling continues Spectre's premium app language: `font-serif`
headers, `bg-white` surface, soft stone borders, amber + rose +
emerald tonal system matching the workspace. No new palette.

### 5.2 Independent human selection (directive §3)

- No answer is preselected on open.
- The dialog EXPLICITLY surfaces which option was the model's
  prediction with a "Model-selected · unverified" chip, but that chip
  is informational — it does NOT translate to the radio's default.
- The approve button stays disabled until the reviewer explicitly
  clicks a radio.

### 5.3 Attestation (directive §3 + §6)

- Required checkbox: "I have reviewed the source evidence."
- Approve button stays disabled until checked.
- `evidenceAttestation: true` is submitted in the body.

### 5.4 Idempotency (directive §7)

- A UUID v4 is generated on dialog open (via
  `crypto.randomUUID()`).
- The same key is reused for retries of an identical payload (409
  `IDEMPOTENCY_CONFLICT` is NOT a reason to generate a new key; the
  server will then replay the cached response).
- The reviewer can regenerate the key via a small "↻ regenerate"
  action, used when they intend a DIFFERENT approval than the one
  that was cached.
- Clicking Approve twice rapidly (duplicate submit) is prevented by
  a `submitting` ref + button `disabled` state. The idempotency key
  still protects the server.

### 5.5 Request payload

```ts
POST /api/admin/ai-training/drafts/{id}/approve
Content-Type: application/json

{
  "expectedRecordVersion":    <detail.recordVersion>,
  "expectedContentHash":      <detail.contentHash>,
  "expectedValidationId":     <detail.latestValidation.id>,
  "verifiedCorrectAnswerIndex": <0-based index>,
  "expectedOptionText":       <server-provided option text> ,
  "evidenceAttestation":      true,
  "idempotencyKey":           <uuid v4>,
  "reviewerNote":             <optional, trimmed>
}
```

`expectedOptionText` is populated from the server-rendered option
array, NOT from a user-editable field. It's a belt-and-braces check
against UI-side rendering drift. Per 4N: if the server-side option
text at `verifiedCorrectAnswerIndex` differs, the server refuses with
`VERIFIED_ANSWER_TEXT_MISMATCH` and NOTHING is persisted.

The dialog NEVER sends a `verifiedAnswerText` or similar
client-authored authoritative field. The server derives authoritative
text from the immutable `draftJson`.

### 5.6 Response handling

| Status                                            | Action                                               |
| ------------------------------------------------- | ---------------------------------------------------- |
| 200 + `ok: true` + `replay: false`                | Close dialog, refresh workspace (soft nav), banner  |
| 200 + `ok: true` + `replay: true`                 | Same as above; banner states "already recorded"      |
| 400 (validation / verified-answer missing)        | Inline error, button remains active, no state change |
| 401 (unauthenticated)                             | Error banner, prompt re-auth (reload)                |
| 404 (cross-tenant OR missing permission)          | Error banner "This candidate cannot be approved."    |
| 409 `APPROVAL_GUARD_BLOCKED` / `TRANSITION_BLOCKED` / `VALIDATION_MISMATCH` | "The candidate is no longer approvable. Refresh and review again." |
| 409 `IDEMPOTENCY_CONFLICT`                        | "Approval for this key already recorded with different payload. Regenerate the key or refresh." |
| 503 (validation service down)                     | "The validation service is unavailable. Try again shortly." |
| Network error / exception                         | "Could not reach the server. Please try again." Retry is manual. |

A failed approval NEVER mutates workspace state. No optimistic
"approved" rendering. The emerald "Verified correct" chip appears
ONLY after a successful 200 + a fresh server read resolves the
verified-answer snapshot via the authoritative 4N reader.

### 5.7 Keyboard / a11y

- Dialog opens via `<button>` with `aria-haspopup="dialog"`.
- When open: `role="dialog"`, `aria-modal="true"`,
  `aria-labelledby` + `aria-describedby` bound to in-dialog ids.
- Focus is trapped inside the dialog while open; initial focus lands
  on the first answer radio.
- Escape closes the dialog without submitting.
- Tab order: radios → attestation checkbox → reviewer note →
  idempotency regenerate → Cancel → Approve.
- All colour distinctions have a non-colour companion (text label,
  icon, or ARIA state) per Spectre a11y baseline.

## 6. Historical + rejected candidates (directive §5)

For `selectedDraftEligibility.eligible === false`:

- The "Approve candidate" button is rendered DISABLED.
- A short, plain-language explanation appears beside the button,
  derived from the `reasons` array:

| Reason                              | Copy                                                           |
| ----------------------------------- | -------------------------------------------------------------- |
| `STATE_NOT_REQUIRES_HUMAN_REVIEW`   | "This candidate is not in a reviewable state."                 |
| `QUESTION_TYPE_UNSUPPORTED`         | "Multi-answer questions are not yet supported for approval."   |
| `HISTORICAL_EVIDENCE_UNAVAILABLE`   | "Approval is unavailable: the pilot-era transcript evidence was not durably persisted for this candidate." |
| `EVIDENCE_INTEGRITY_FAILURE`        | "Approval is unavailable: evidence integrity cannot be confirmed." |
| `VALIDATION_HAS_HARD_ERRORS`        | "This candidate has hard validation errors and cannot be approved." |
| `ALREADY_VERIFIED`                  | "This candidate has already been reviewer-verified."           |
| `VALIDATION_ROW_MISSING`            | "This candidate has no validation to bind an approval to."     |

For historical candidates specifically, the explanation preserves
the 4M "Historical evidence unavailable" banner intact. No evidence
is fabricated. No timestamps are invented. Model explanations remain
labelled "Model explanation" and are NEVER promoted to evidence.

## 7. Verified-answer display (directive §8)

Unchanged from 4N:

- Emerald "Verified correct" chip renders ONLY when
  `verifiedAnswer.kind === "verified"`.
- Reviewer identity renders alongside.
- The original model prediction remains labelled "Model-selected ·
  unverified" on the non-verified option.
- `kind === "integrity-warning"` reverts to neutral styling + the 4N
  amber warning banner.

The dialog does NOT touch this rendering. After a successful
approval, the page is re-read on the server (Next's `router.refresh`)
and the authoritative reader's output is what the workspace
re-renders. No client-side promotion.

## 8. Testing (directive §10)

| Test                                                              | Location                                                    | Approach             |
| ----------------------------------------------------------------- | ----------------------------------------------------------- | -------------------- |
| Server-derived eligibility: canApprove + per-draft gate           | `tests/ep-train-6d4p-eligibility-contract.test.ts`          | vitest (SQLite + jsdom-free) |
| Dialog: no preselection, attestation required, idempotency key    | `tests/ep-train-6d4p-approval-dialog.test.tsx`              | jsdom + testing-library |
| Dialog: duplicate submit prevention                               | same                                                        | same                 |
| Dialog: response shape dispatch (200, 400, 404, 409, 503)         | same                                                        | mocked `fetch`       |
| Dialog: MULTI_ANSWER refusal banner                               | same                                                        | prop-driven          |
| Dialog: historical refusal banner                                 | same                                                        | prop-driven          |
| Workspace: CLUB_ADMIN read-only                                   | `tests/ep-train-6d4p-workspace-rbac.test.tsx`               | same                 |
| Workspace: integrity-failure fallback                             | same                                                        | prop-driven          |
| Approval round-trip through 4N service (authorized)               | `scratchpad/ep-train-6d4p/integration-test.mjs`             | PG16 Docker          |
| Stale-version conflict replay                                     | same                                                        | PG16 Docker          |
| Cross-tenant 404                                                  | same                                                        | PG16 Docker          |
| 4B/4N guard still rejects the identical shapes                    | same                                                        | PG16 Docker          |

## 9. Non-goals / out of scope

- No new /api routes. The only server surface used is the already-
  accepted 4N route.
- No RBAC changes. CLUB_ADMIN remains read-only.
- No publication. Approval → APPROVED_DRAFT is still unpublished.
- No employee assignment. APPROVED_DRAFT does NOT trigger
  `TrainingObligation` rows in this slice.
- No worker / Modal / Qwen activation.
- No transcription ingestion.
- No historical backfill.
- No Prisma migration.
- No staging deployment.

## 10. STOP boundaries (directive §12)

- STOP after offline implementation, tests, commit + acceptance doc.
- Await founder authorization before pushing 4P.
- Await further founder authorization before staging deployment.
- Preserve the 126 unrelated WIP files (stashed; restored at the end
  of this slice).
