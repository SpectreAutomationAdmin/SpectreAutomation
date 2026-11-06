# EP-TRAIN-6D-4T — Approved AI Question → Course-Authoring Bridge — Design

Status: **IMPLEMENTATION COMPLETE OFFLINE.** The founder authorized
Option B on 2026-11-06 with eight conditions; all conditions are
honoured in the implementation below. Not pushed; not deployed.

Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4t/promotion-bridge`. See
`PHASE-D-4T-ACCEPTANCE.md` for the evidence table.

## 1. Preflight finding

The existing Prisma schema does NOT support an immutable, idempotent
link between an approved `TrainingQuestionAiDraft` and the resulting
`TrainingQuestion`. Evidence (inspected 2026-11-06):

| Entity                   | Relevant columns                                               | Link to AI draft? |
| ------------------------ | -------------------------------------------------------------- | :---------------: |
| `TrainingQuestion`       | `id`, `courseVersionId`, `prompt`, `displayOrder`, `active`, `checkpointId?`, `questionType` | **NONE** |
| `TrainingAnswerOption`   | `id`, `questionId`, `text`, `isCorrect`, `displayOrder`         | **NONE** |
| `TrainingCheckpoint`     | `id`, `courseVersionId`, `atSecond`, `label`, `requiredToProceed`, `maxRetries` | **NONE** |
| `TrainingQuestionAiDraft`| `id`, `state`, `recordVersion`, `contentHash`, `courseVersionId`, `clubId`, `groundingProjectionId`, ... | — |
| `TrainingQuestionAiReview` | `id`, `draftId`, `disposition`, `reviewedByUserId`, `reviewedAt` | — |

- `TrainingQuestion` has **no `sourceAiDraftId`** column.
- `TrainingQuestion` has **no `clubId`** column — tenant is derived
  via `courseVersion → course.clubId`.
- There is **no sidecar table** mapping approved drafts to resulting
  TrainingQuestions.
- Prompts can be duplicated within a version — no uniqueness on
  `prompt`.

Idempotency option without schema change: match by `prompt + checkpointId`
substring. **Rejected** — a legitimate reviewer edit to the prompt
would break deduplication; two drafts with identical prompts but
different options could not coexist; the link is behavioural not
structural.

Therefore a minimal additive schema change is **required**.

## 2. Two minimal additive designs

### Option A — Add one column to `TrainingQuestion`

```prisma
model TrainingQuestion {
  // … existing fields …
  sourceAiDraftId  String?  @unique
  sourceAiDraft    TrainingQuestionAiDraft? @relation(fields: [sourceAiDraftId], references: [id], onDelete: Restrict)
}
model TrainingQuestionAiDraft {
  // … existing fields …
  promotedQuestion TrainingQuestion?
}
```

- Touches ONE existing production entity.
- `@unique` prevents two questions from claiming the same draft.
- `onDelete: Restrict` means an approved draft cannot be silently
  deleted while a question refers to it.
- Simple query: `SELECT * FROM TrainingQuestion WHERE sourceAiDraftId = ?`.
- Downside: adds a nullable column to an entity that had no AI-side
  concerns before; every `TrainingQuestion.create()` writer across
  the codebase now implicitly receives a null column. Low risk, but
  it's an edit to a well-established production model.

### Option B — Add a dedicated sidecar table (RECOMMENDED)

```prisma
model TrainingQuestionAiDraftPromotion {
  id                       String   @id @default(cuid())

  // Tenant scope for direct filtering + audit queries.
  clubId                   String
  club                     Club     @relation(fields: [clubId], references: [id])

  // The AI side (1-1 — a given approved draft can produce at most
  // one promoted question).
  draftId                  String   @unique
  draft                    TrainingQuestionAiDraft @relation(fields: [draftId], references: [id], onDelete: Restrict)

  // The authoring side (1-1 — a given authored question can be
  // linked to at most one AI draft).
  questionId               String   @unique
  question                 TrainingQuestion @relation(fields: [questionId], references: [id], onDelete: Restrict)

  // Destination the promotion chose: CHECKPOINT or FINAL_ASSESSMENT.
  // Captured verbatim so a subsequent reviewer edit that moves the
  // question between buckets is still traceable to the original
  // promotion intent.
  destination              String   // "CHECKPOINT" | "FINAL_ASSESSMENT"

  // Immutable approval bindings — the exact draft content hash +
  // validation row + reviewer the promotion was derived from.  A
  // later reviewer edit that bumps draft.recordVersion or draft.contentHash
  // leaves these columns unchanged; they are the forensic record.
  approvedDraftContentHash String
  approvedValidationId     String
  approvedByUserId         String

  // Authored-side bookkeeping.
  promotedByUserId         String
  promotedAt               DateTime @default(now())

  createdAt                DateTime @default(now())

  @@index([clubId, draftId])
  @@index([clubId, questionId])
}

// Back-relations (additive-only on existing entities):
model Club {
  // … existing …
  trainingQuestionAiDraftPromotions TrainingQuestionAiDraftPromotion[]
}
model TrainingQuestionAiDraft {
  // … existing …
  promotion                         TrainingQuestionAiDraftPromotion?
}
model TrainingQuestion {
  // … existing …
  aiPromotion                       TrainingQuestionAiDraftPromotion?
}
```

- Touches ZERO existing production columns (the three back-relations
  are Prisma-side only — they don't add columns).
- `@unique` on both `draftId` and `questionId` enforces 1-1 symmetry.
- `clubId` on the row allows `tenantWhere`-shaped queries without
  joining through the course.
- `onDelete: Restrict` on both FKs means neither side can be silently
  deleted while the promotion row exists.
- Carries immutable approval bindings (`approvedDraftContentHash +
  approvedValidationId + approvedByUserId`) → the slice §7 audit
  requirement is satisfied by the schema itself, not by trusting the
  reviewer's at-write state.
- Follows the EP-TRAIN-6D-4B sidecar-table pattern (6 AI-review
  tables + 3 4K transcript tables) — same architectural style the
  founder has already reviewed.
- A future "approved draft that intentionally wasn't promoted" row
  (nothing promoted) is simply the ABSENCE of a promotion row — no
  "orphan" state.

### Why Option B is recommended

1. **Zero mutation of existing production entities.** `TrainingQuestion`
   is an authoritative, well-tested entity with many writers; adding
   a column is a bigger blast radius than adding a sibling table.
2. **Stronger provenance.** Option B captures the APPROVAL bindings
   that made the promotion legal, not just the draft id. A later
   reviewer edit (if 4D/4N ever permits one) that bumps the draft's
   content hash does not erase the record that promotion X was based
   on a specific earlier content hash.
3. **Follows an existing pattern.** The 4B six-table family already
   models AI-side concerns as sibling tables. Option B extends that
   pattern consistently.
4. **Cleaner teardown semantics.** In a staging teardown, the
   promotion row can be deleted first (`DELETE FROM
   TrainingQuestionAiDraftPromotion WHERE draftId IN …`) without
   touching either `TrainingQuestion` or `TrainingQuestionAiDraft`
   — important for the eventual 4T staging acceptance window.

## 3. Proposed migration SQL (preview only — NOT yet authored)

If Option B is approved, the migration adds:

- One new table `TrainingQuestionAiDraftPromotion` (SQLite + Postgres
  mirror, same convention as 4K).
- Two unique indexes (`draftId`, `questionId`) + two normal indexes.
- Zero `DROP` / `ALTER…DROP` / `TRUNCATE`.
- Rollback = drop that one table.
- Prisma migration will auto-apply via `prisma migrate deploy`.

I will author the migration file + Postgres mirror only after the
founder authorizes Option B (or re-directs to Option A / something
else).

## 4. Promotion service contract (same under either option)

```ts
export interface PromoteApprovedDraftInput {
  readonly draftId: string;
  readonly destination:
    | { readonly kind: "CHECKPOINT"; readonly checkpointId: string }
    | { readonly kind: "FINAL_ASSESSMENT" };
  readonly expectedDraftContentHash: string;    // defence in depth
  readonly expectedValidationId: string;        // defence in depth
}

export interface PromoteApprovedDraftResult {
  readonly ok: true;
  readonly questionId: string;
  readonly destinationKind: "CHECKPOINT" | "FINAL_ASSESSMENT";
  readonly replay: boolean;                     // true on idempotent replay
}

export type PromoteApprovedDraftRejectionCode =
  | "DRAFT_NOT_APPROVED"
  | "DRAFT_NOT_FOUND"                 // cross-tenant → 404
  | "CHECKPOINT_NOT_FOUND"
  | "CHECKPOINT_CROSS_COURSE"
  | "COURSE_VERSION_NOT_DRAFT"
  | "CONTENT_HASH_MISMATCH"
  | "VALIDATION_MISMATCH"
  | "VERIFIED_ANSWER_MISSING"
  | "VERIFIED_ANSWER_INTEGRITY_FAIL"
  | "QUESTION_TYPE_UNSUPPORTED"       // MULTI_ANSWER refused (per 4N precedent)
  | "EVIDENCE_HISTORICAL_UNAVAILABLE"
  | "EVIDENCE_INTEGRITY_FAILURE"
  | "ALREADY_PROMOTED_SAME_DESTINATION" // idempotent replay returns 200
  | "ALREADY_PROMOTED_DIFFERENT_DESTINATION"; // conflicting → refusal
```

Behaviour:

- **Authorized principal**: `hr:training:write` on the target club
  (existing permission; no new grant needed).
- **Tenant isolation**: draft.clubId MUST equal
  course.clubId MUST equal checkpoint.clubId (if present).
- **Lifecycle refusal**: draft.state !== APPROVED_DRAFT → refuse.
- **Approval guard re-verification**: expectedContentHash +
  expectedValidationId MUST match the draft's current row AND match
  the `verifiedCorrectAnswerSnapshotJson` on the validation row.
- **Reader path**: load through the authoritative 4M evidence-reader
  + 4N verified-answer-reader; refuse on any `integrity-warning` /
  `historical-unavailable` / `evidence-integrity-failure`.
- **Destination refusal**: the target course version must be DRAFT
  AND belong to the same clubId as the draft. If destination is
  CHECKPOINT, the checkpoint MUST belong to that same course version.
- **Idempotency**: Option B's `@@unique([draftId])` makes a second
  promotion attempt raise P2002, which the service maps to either:
  - `replay: true` (same destination + same resulting question row
    already exists) — returns the cached result.
  - `ALREADY_PROMOTED_DIFFERENT_DESTINATION` (409) — refuses silently
    converting the earlier promotion.
- **Atomicity**: single Prisma `$transaction` writes
  `TrainingQuestion` + `TrainingAnswerOption[]` + the sidecar
  `TrainingQuestionAiDraftPromotion` row. `audit()` fires
  post-commit (non-blocking per CLAUDE.md pattern).

## 5. Data transformation rules

### 5.1 Question text

`TrainingQuestion.prompt = draft.draftJson.questionText` (verbatim,
no truncation).

### 5.2 Answer options

Each `draftJson.options[i]` produces one `TrainingAnswerOption`:

```ts
{
  text: opt.text,
  isCorrect: /* see §5.3 */,
  displayOrder: i,
}
```

### 5.3 Correct answer — HUMAN-VERIFIED (per directive §6)

The AUTHORITATIVE correct answer is the one at
`verifiedCorrectAnswerSnapshotJson.optionIndex`, NOT the model's
`isCorrect: true` flag in `draftJson.options[i].isCorrect`.

This is directive §6 explicit: "Do not use the model-selected answer
as the authoritative answer."

Implementation: iterate `draftJson.options` and set `isCorrect = (i
=== verifiedSnapshot.optionIndex)` for SINGLE_CHOICE / TRUE_FALSE.
MULTI_ANSWER is refused per 4N precedent until a separate slice
extends the contract.

### 5.4 Question type

`TrainingQuestion.questionType = draft.draftJson.questionType`,
guarded against `TRAINING_QUESTION_TYPES` whitelist.

- `SINGLE_CHOICE` → allowed, standard validation.
- `TRUE_FALSE` → allowed, standard validation.
- `MULTI_ANSWER` → **refused** with `QUESTION_TYPE_UNSUPPORTED`.

### 5.5 Explanation

`TrainingQuestion` has no `explanation` column. The draft's
`explanation` is **lost** on promotion. Options:

- **(a)** Accept the loss; the explanation remains on the
  `TrainingQuestionAiDraft` row for audit/review but the published
  question does not show it to employees.
- **(b)** Add a nullable `explanation` column to `TrainingQuestion`
  in this slice.

Recommended: **(a)** for 4T to keep the slice minimal; 4T §8 follow-
on documents the extension point.

### 5.6 Supporting provenance

- `aiPromotion.draftId` + `approvedDraftContentHash` +
  `approvedValidationId` + `approvedByUserId` record the trail.
- No new column on `TrainingQuestion` needed.

### 5.7 Destination

`TrainingQuestion.checkpointId` is the destination's ID (or null
for FINAL_ASSESSMENT).

### 5.8 Course version

`TrainingQuestion.courseVersionId = draft.courseVersionId`. The
service refuses if the version is not DRAFT.

### 5.9 Display order

Set to `max(existing displayOrder in bucket) + 1`, identical to
`createQuestion`'s semantics.

## 6. Publication governance (directive §8)

- Promotion does NOT publish the course. It only creates a
  `TrainingQuestion` in DRAFT state.
- The existing `publishDraft` still runs `checkPublishReadiness`
  which validates: title + video + duration + per-question option
  integrity + checkpoint position bounds + 1-s spacing + final-
  assessment count.
- A promoted question is INDISTINGUISHABLE from a manually-authored
  question for the publish gate — this is the correct property; the
  publish gate must see a well-formed question regardless of origin.
- Documented limitation: the publish gate does **NOT** today refuse
  publication of a question whose `aiPromotion` points at a draft
  in any state other than APPROVED_DRAFT. The 4T sidecar guarantees
  at PROMOTION time that the draft was APPROVED, but a subsequent
  reviewer action that un-approves the draft (if such action is
  ever introduced in a future slice) would leave orphaned "published
  from an un-approved draft" rows.

### 6.1 Follow-on: strict-publication gate (future slice)

Add to `checkPublishReadiness`:

```ts
// Future slice (not in 4T):
const promoted = await prisma.trainingQuestionAiDraftPromotion.findMany({
  where: { question: { courseVersionId: versionId } },
  include: { draft: { select: { state: true, contentHash: true } } },
});
for (const p of promoted) {
  if (p.draft.state !== "APPROVED_DRAFT") {
    reasons.push(`Question originated from an AI draft that is no longer approved.`);
  }
  if (p.draft.contentHash !== p.approvedDraftContentHash) {
    reasons.push(`Question's source AI draft has been edited since promotion.`);
  }
}
```

This is a separately-authorised slice. 4T lays the groundwork; 4T
does not ship this gate.

## 7. Duplicate prevention (directive §9)

- **Deterministic by draftId**: the Option B
  `@@unique([draftId])` is the enforcement point.
- **Course-wide semantic deduplication**: explicitly OUT OF SCOPE
  for 4T. The slice documents the extension point (§8 below).
- **Prompt collision**: not enforced. Two distinct drafts with the
  same `questionText` can both be approved + promoted, producing
  two separate `TrainingQuestion` rows. The course author can
  decide whether to delete one.

## 8. Extension point for 4X semantic duplicate registry

Future 4X adds:

- `TrainingQuestionAiDraftPromotion.embeddingSha256 String?` (nullable
  until 4X computes).
- `TrainingQuestionAiDraftPromotion.embeddingSourceModel String?`.
- A sibling table `TrainingQuestionAiSemanticNeighbour` recording
  pairs discovered above a similarity threshold.
- A promotion-time check that refuses with
  `SEMANTIC_DUPLICATE_WITH_EXISTING` + the neighbour id.

4T does not implement any of this. 4T's sidecar schema simply leaves
room for it to be added later without re-writing the promotion
service's contract.

## 9. Non-regression invariants

- The 8 historical EP-TRAIN-6D-4H candidates remain byte-identical.
- Every existing `createQuestion` call continues to work (the new
  schema column is a nullable back-relation on `TrainingQuestion` if
  Option A, or a separate table + back-relation if Option B).
- The 4N approval service is unchanged.
- The publish gate `checkPublishReadiness` is unchanged.
- No new RBAC permission. `hr:training:write` is sufficient (per
  existing `createQuestion` parity).
- No new API route. The admin UI button added by 4T calls the new
  service via an internal action; no public HTTP surface exposed.

## 10. Request for founder authorization

Before implementation proceeds, I need:

- **(A)** Approval of Option B schema (recommended) OR
- **(A')** Approval of Option A schema OR
- **(A'')** A different additive design the founder prefers.

Once authorized, the next slice step is:

1. Author the migration (SQLite + Postgres mirror).
2. Implement `src/lib/hr/training/ai-review/promotion-service.ts`
   with the contract in §4 + §5.
3. Admin UI: add an "Add to draft version" action to the persisted
   review workspace (directive §4 "The caller must explicitly choose
   the destination" → the UI presents a destination picker:
   dropdown of existing checkpoints + "Final assessment").
4. Tests: 18 scenarios enumerated in directive §10, split across
   vitest contract (SQLite) + jsdom (UI) + disposable-PG16
   (integration + race).
5. Scoped typecheck + nav audit + 4B–4P regression suites.
6. Commit on this branch. No push, no staging deploy.
7. `PHASE-D-4T-ACCEPTANCE.md` with the full evidence.

## 11. STOP compliance (directive §12)

| Boundary                                 | Status   |
| ---------------------------------------- | -------- |
| No staging or production deployment      | HONOURED |
| No shared database migration             | HONOURED — no migration authored yet |
| No Modal/Qwen inference                  | HONOURED |
| No transcription worker activation       | HONOURED |
| No historical candidate modification     | HONOURED |
| No course publication                    | HONOURED |
| No employee assignments                  | HONOURED |
| No unrelated UI changes                  | HONOURED |
| No permanent role grants                 | HONOURED |
| 126 unrelated WIP files preserved        | HONOURED — stashed at entry |
| STOP for schema-change authorization     | **TRIGGERED — this is the correct STOP cause** |
