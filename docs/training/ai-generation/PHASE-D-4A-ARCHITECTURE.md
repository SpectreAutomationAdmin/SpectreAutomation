# EP-TRAIN-6D-4A — AI Training Review Backend Architecture

**Status:** DESIGN-ONLY. No code changes. No Prisma changes. No API
implementation. No merges. No deployment.
**Branch:** `ep-train-6d-4a/review-backend-architecture`
**Parent commit:** `36a784f` (6D-3 review-UI prerequisites)
**Scope:** persistent, tenant-isolated, auditable backend design for the
AI question-review workflow. Grounded in Spectre's existing training
infrastructure — reuses patterns, does not invent parallel systems.

---

## 1. Existing architecture inventory (directive §3)

Every claim below cites an actual file + line range.

### 1.1 Training data model (`prisma/schema.prisma`)

| Model | Role | Key fields |
|-------|------|-----------|
| `TrainingCourse` | Per-club course catalogue entry. `clubId`-scoped. | `clubId`, `code`, `category` |
| `TrainingCourseVersion` *(~line 13030)* | **Immutable** content snapshot per version. "Every material edit publishes a new version rather than rewriting an existing one, so previously certified employees remain certified against the exact content they were tested on." | `courseId`, `version`, `state` (`DRAFT`/`PUBLISHED`/`RETIRED`), `videoStorageKey`, `videoMimeType`, `videoSizeBytes`, `videoSha256`, `videoDurationSec`, `videoThumbnailStorageKey`, `publishedAt`, `publishedByUserId`, `retiredAt` |
| `TrainingQuestion` *(~line 13083)* | Per-version question. `checkpointId=null` → final-assessment. | `courseVersionId`, `prompt`, `displayOrder`, `active`, `checkpointId?`, `questionType` (default `SINGLE_CHOICE`) |
| `TrainingAnswerOption` *(~line 13115)* | Per-question option. **"Exactly ONE row per question must have `isCorrect = true` at publish time — enforced in the service layer via publish validation."** `isCorrect` is NEVER in the employee-facing payload. | `questionId`, `text`, `isCorrect`, `displayOrder` |
| `TrainingCheckpoint` *(~line 13136)* | Interactive knowledge-check anchored to `atSecond` within a video. **Immutable once the parent version is PUBLISHED.** | `courseVersionId`, `atSecond`, `label?`, `requiredToProceed`, `maxRetries` |
| `TrainingAssignment` | Explicit per-employee assignment. | `clubId`, `employeeId`, `courseId` |
| `TrainingProgress` / `TrainingAttempt` / `TrainingQuestionResponse` / `TrainingCompletion` / `TrainingObligation` | Downstream delivery + proof surfaces; unchanged by this slice. | — |

### 1.2 Service layer (`src/lib/hr/training/`)

```
applicability.ts              — "which courses apply to this employee"
assignments.ts                — explicit per-employee assignments
attempts.ts                   — attempt + response + grading
checkpoints.ts                — knowledge-check CRUD
compliance.ts / -resolver.ts  — compliance rollups
courses.ts                    — listClubCourses, publishDraft (line 333)
employee-read.ts              — portal-facing course payload
employee-recommendations.ts   — engagement nudges
obligations.ts                — per-obligation lifecycle
questions.ts                  — DRAFT question + option CRUD
revisions.ts                  — publishDraftWithPolicy (line 246)
training-session.ts           — portal session state
video-probe.ts                — ffprobe metadata extraction
video-remux.ts                — server-side remux
video-stream.ts               — streaming + byte-range + auth check
video-thumbnail.ts            — representative-frame extraction
video.ts                      — uploadTrainingVideo (admin mutation)
```

### 1.3 RBAC + permissions (`src/lib/permissions.ts`)

Existing training permissions (naming convention `hr:training:<verb>`):

| Key | Purpose |
|-----|---------|
| `hr:training:read` | Read admin catalogue |
| `hr:training:write` | Create / edit DRAFT training courses |
| `hr:training:publish` | Publish / retire training course versions |
| `hr:training:assign` | Explicitly assign a training course to an employee |
| `hr:training:compliance:read` | Read employee training compliance status |

Call site example:

```ts
// src/app/api/hr/training/versions/[id]/video/route.ts:115
if (!hasPermission(principal, clubId, "hr:training:write")) return NOT_FOUND();
```

### 1.4 Tenant isolation (`src/lib/services/tenant.ts`)

```ts
export function tenantScope(principal): { clubId?: ... }
export function tenantWhere(principal, clubId): { clubId: string }
export function assertTenantOwned<T extends { clubId }>(record, principal): asserts record
```

Active-club resolution: `src/lib/active-club.ts::getActiveClubId`.

### 1.5 Audit (`src/lib/audit.ts`)

```ts
export async function audit(actor, input: {
  action: string;        // dotted e.g. "training.enable"
  entityType: string;
  entityId?: string | null;
  clubId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
})
```

**Never throws.** Writes to `AuditLog` with `ip` + `userAgent` from
request context. Service-layer functions are responsible for calling
it on every sensitive write.

Existing `training.*` actions already in use: `training.enable`,
`training.disable`, `training.scenarios.reset`.

### 1.6 Video evidence delivery

`src/app/api/hr/training/versions/[id]/video/route.ts` — the
**authenticated proxy** pattern Spectre uses for training media:

- Looks up the version → finds its `clubId` → runs one of two auth paths:
  - Admin: `hasPermission(admin, clubId, "hr:training:read")`
  - Employee portal: `getEmployeePortalPrincipal()` matches `clubId` AND version `PUBLISHED` AND applicable via `resolveApplicableCourses`
- Same-shape 404 for every deny — "no cross-tenant enumeration signal".
- **R2 URLs are never exposed publicly** — media flows through this
  authenticated route via `streamTrainingVideo` in `video-stream.ts`.

### 1.7 Pipeline + validator (already landed in prior slices)

- `src/lib/training/ai-generation/types.ts` — `TrainingQuestionDraftLiteV1`, `TrainingQuestionProposalV1`, `GroundingProjection`, `PilotAuthorizationV1`, shared validator error / flag / warning types.
- `src/lib/training/ai-generation/grounding-validator.ts` — hardened `validateProposal({proposal, grounding, authorization})`. `VALIDATOR_ERRORS`, `VALIDATOR_FLAGS`, `KNOWN_SOURCE_ORG_NAMES`, `KNOWN_TENANT_ORG_NAMES`, `REGULATORY_BODIES`, `INSURANCE_TERMS`.
- `src/lib/training/ai-generation/convert-draft-to-proposal.ts` — `convertDraftToProposal({draft, grounding, authorization, placement?})`.
- `src/lib/training/ai-generation/pipeline.ts` — `validateTrainingQuestion(input): PipelineResult` (the single authoritative entry point).
- `src/lib/training/ai-generation/index.ts` — public barrel.
- `src/components/ai-training/approval-guard.ts` — `evaluateApproval({latestValidation, validationStatus})` (6D-3; this is the UI guard that the server-side guard must mirror).

### 1.8 What is DELIBERATELY not reused

- `TrainingQuestion` / `TrainingAnswerOption` are **final content**. AI-generated drafts are candidates for future inclusion in a new `TrainingCourseVersion` DRAFT; they are NOT inserted into these tables until a human has explicitly `includeDraftInVersion` in a separately-authorised slice (6D-5 or 6D-6 territory).
- `TrainingAssignment` etc. remain untouched by this workflow.

---

## 2. Proposed data model (directive §4, §5)

Four new Prisma models + one extension of an existing column set. All
additive; no existing-column renames; no behaviour change to
`TrainingQuestion` et al.

### 2.1 `TrainingQuestionAiDraft`

The raw model output + its immutable content-hash binding.

```prisma
model TrainingQuestionAiDraft {
  id                 String @id @default(cuid())

  // Tenant scope + course binding
  clubId             String
  club               Club                 @relation(fields: [clubId], references: [id])
  courseId           String
  course             TrainingCourse       @relation(fields: [courseId], references: [id])
  courseVersionId    String
  courseVersion      TrainingCourseVersion @relation(fields: [courseVersionId], references: [id])

  // Content version binding (per directive §5)
  draftJson          String   // canonical-JSON TrainingQuestionDraftLiteV1
  contentHash        String   // sha256 of canonicalise(draftJson); UNIQUE within (clubId, courseVersionId)
  sourceVideoSha256  String   // matches TrainingCourseVersion.videoSha256
  resolvedTranscriptBuildId String
  groundingProjectionSha256 String
  pilotAuthorizationId      String
  pilotAuthorizationFingerprint String

  // Lifecycle
  state              String   // GENERATED | VALIDATION_PENDING | REQUIRES_HUMAN_REVIEW | APPROVED_DRAFT | REJECTED | EDITED_VALIDATION_STALE | VALIDATION_FAILED | ARCHIVED
  stateChangedAt     DateTime @default(now())
  stateChangedByUserId String?

  // Optimistic concurrency
  recordVersion      Int      @default(0) // incremented on every write

  // Audit anchors
  generatedAt        DateTime
  generatedByUserId  String?               // null when system-initiated

  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  validations    TrainingQuestionAiValidation[]
  reviews        TrainingQuestionAiReview[]
  stateHistory   TrainingQuestionAiStateTransition[]

  @@unique([clubId, courseVersionId, contentHash])
  @@index([clubId, courseVersionId, state])
  @@index([clubId, state, generatedAt(sort: Desc)])
}
```

**Why `contentHash` + `@@unique`:** prevents the same model output
from being double-persisted and makes content-version binding
trivially provable. When the UI commits a reviewer edit, a NEW
`TrainingQuestionAiDraft` row is created with a NEW hash — the
previous row remains for audit.

### 2.2 `TrainingQuestionAiValidation`

Append-only. Every validator run against a draft produces one row.

```prisma
model TrainingQuestionAiValidation {
  id                 String @id @default(cuid())

  draftId            String
  draft              TrainingQuestionAiDraft @relation(fields: [draftId], references: [id], onDelete: Cascade)

  // The hash that was VALIDATED. Approval is only possible when a
  // Review row references a Validation whose draftContentHash exactly
  // matches the current TrainingQuestionAiDraft.contentHash.
  draftContentHash   String

  // Validator version binding
  validatorVersion   String   // e.g. "6c-10c" — tracked in the pipeline module
  validatorSource    String   // "integrated-pipeline" | "fixture" (only "integrated-pipeline" is approvable in prod)

  // Result snapshot (JSON of PipelineResult)
  verdict            String   // GROUNDED | REQUIRES_HUMAN_VERIFICATION | REJECTED
  stage              String   // CONVERT | VALIDATE | EXCEPTION
  errorsJson         String   // JSON of errors[]
  warningsJson       String   // JSON of warnings[]
  flagsJson          String   // JSON of flags[]
  proposalJson       String?  // canonical-JSON TrainingQuestionProposalV1 on success; null on CONVERT/EXCEPTION

  runAt              DateTime @default(now())
  runByUserId        String?  // null when system-initiated
  runByJobId         String?  // optional — links to a background-job row when added

  createdAt          DateTime @default(now())

  @@index([draftId, runAt(sort: Desc)])
  @@index([draftContentHash])
}
```

### 2.3 `TrainingQuestionAiReview`

The reviewer decision + the exact validation it references.

```prisma
model TrainingQuestionAiReview {
  id                 String @id @default(cuid())

  draftId            String
  draft              TrainingQuestionAiDraft @relation(fields: [draftId], references: [id])

  // Immutable binding to the exact content version + validation row
  draftContentHash   String   // matches draft.contentHash at the moment of review
  validationId       String?  // non-null for approve/reject; references the validation that drove the decision
  validation         TrainingQuestionAiValidation? @relation(fields: [validationId], references: [id])

  disposition        String   // APPROVED | REJECTED | REVALIDATION_REQUESTED | REGENERATION_REQUESTED (regen is a request only; see §2.5)
  reviewerNote       String?

  reviewedAt         DateTime @default(now())
  reviewedByUserId   String
  reviewedByClubId   String   // for tenant-isolation proofs

  createdAt          DateTime @default(now())

  @@index([draftId, reviewedAt(sort: Desc)])
  @@index([reviewedByClubId, reviewedAt(sort: Desc)])
}
```

### 2.4 `TrainingQuestionAiStateTransition`

Append-only state-machine audit. Separate from `AuditLog` so the
review-service has a dense, queryable transition history.

```prisma
model TrainingQuestionAiStateTransition {
  id                 String @id @default(cuid())
  draftId            String
  draft              TrainingQuestionAiDraft @relation(fields: [draftId], references: [id], onDelete: Cascade)
  fromState          String?  // null on GENERATED entry
  toState            String
  reasonCode         String   // e.g. VERDICT_REJECTED, REVIEWER_APPROVED, EDIT_SAVED, REVALIDATION_FAILED
  reasonDetail       String?  // optional human-readable context
  byUserId           String?
  recordVersionBefore Int
  recordVersionAfter  Int
  occurredAt         DateTime @default(now())

  @@index([draftId, occurredAt(sort: Desc)])
}
```

### 2.5 Column extension on `TrainingQuestion` (CONDITIONAL, future slice)

**Not in this slice.** When 6D-6 (publication) lands, it will add
`sourceAiDraftId` + `sourceAiReviewId` to `TrainingQuestion` so an
auditor can trace a published question back to the AI draft + approval.
Deferred because `TrainingQuestion` is a shared surface and the addition
needs its own review.

---

## 3. Lifecycle state machine (directive §4)

```
                                   ┌───────────────┐
                                   │  (external)   │
                                   │  generation   │
                                   │  request      │
                                   └───────┬───────┘
                                           ▼
                             ┌────────────────────────────┐
                             │       GENERATED            │
                             │  draft persisted, pending  │
                             │  validation                │
                             └──────────────┬─────────────┘
                                            │ enqueue
                                            ▼
                             ┌────────────────────────────┐
                             │     VALIDATION_PENDING     │
                             │  pipeline running on a     │
                             │  worker; approval blocked  │
                             └──────┬─────────────┬───────┘
                                    │             │
                        pipeline    │             │ pipeline threw
                        completed   ▼             ▼
                   ┌──────────────┐  ┌──────────────────────┐
                   │ REQUIRES_    │  │  VALIDATION_FAILED   │
                   │ HUMAN_REVIEW │  │  retry allowed; no   │
                   │ (verdict:    │  │  approval path       │
                   │  RHV or      │  └────────┬─────────────┘
                   │  GROUNDED)   │           │ retry succeeds
                   └──┬──────┬────┘           ▼
                      │      │        ┌──────────────┐
         reviewer     │      │ edit   │  back to     │
         approves     │      │ saved  │  VALIDATION_ │
                      │      ▼        │  PENDING     │
                      │  ┌──────────────────────────┐
                      │  │ EDITED_VALIDATION_STALE  │
                      │  │ previous validation      │
                      │  │ preserved; approval      │
                      │  │ blocked                  │
                      │  └──────────┬───────────────┘
                      │             │ revalidation requested
                      │             ▼
                      │   (back to VALIDATION_PENDING,
                      │    then REQUIRES_HUMAN_REVIEW
                      │    with a new validation row
                      │    bound to new contentHash)
                      │
                      │ verdict = REJECTED
                      │ OR reviewer rejects
                      │
                      ▼
            ┌────────────────────┐          (reviewer archives
            │     REJECTED       │  ──────▶  intentionally after
            │  terminal unless   │           retention policy)
            │  explicit remedia- │
            │  tion workflow     │                 │
            └────────────────────┘                 ▼
                                             ┌──────────┐
                                             │ ARCHIVED │
                                             │ terminal │
                                             └──────────┘

   ┌──────────────┐  reviewer approves    ┌───────────────────┐
   │ REQUIRES_    │  (guard allows)       │  APPROVED_DRAFT   │
   │ HUMAN_REVIEW │──────────────────────▶│  unpublished;     │
   └──────────────┘                       │  candidate for    │
                                          │  inclusion in a   │
                                          │  future           │
                                          │  TrainingCourse-  │
                                          │  Version DRAFT    │
                                          └───────────────────┘
```

### 3.1 Allowed transitions + responsible permission

| From | To | Trigger | Permission | Notes |
|------|-----|---------|------------|-------|
| `(none)` | `GENERATED` | Generation job writes draft row | `hr:training:ai:generate` *(new; see §5)* | System or operator; records `generatedByUserId` |
| `GENERATED` | `VALIDATION_PENDING` | Enqueue validation | system | Transition is atomic with job enqueue |
| `VALIDATION_PENDING` | `REQUIRES_HUMAN_REVIEW` | Pipeline completes with `verdict = GROUNDED` or `REQUIRES_HUMAN_VERIFICATION` | system | Writes a `TrainingQuestionAiValidation` row with matching `draftContentHash` |
| `VALIDATION_PENDING` | `REJECTED` | Pipeline completes with `verdict = REJECTED` | system | Writes validation row with `errors[] ≠ []` |
| `VALIDATION_PENDING` | `VALIDATION_FAILED` | Pipeline throws / times out | system | Writes validation row with `stage = EXCEPTION` |
| `VALIDATION_FAILED` | `VALIDATION_PENDING` | Operator retries | `hr:training:ai:revalidate` *(new)* | |
| `REQUIRES_HUMAN_REVIEW` | `APPROVED_DRAFT` | Reviewer approves + server-side guard passes | `hr:training:ai:approve` *(new)* | Guard-fail → NO transition, 409 to caller |
| `REQUIRES_HUMAN_REVIEW` | `REJECTED` | Reviewer rejects | `hr:training:ai:review` *(new)* | Records reviewer note |
| `REQUIRES_HUMAN_REVIEW` | `EDITED_VALIDATION_STALE` | Reviewer saves an edit | `hr:training:ai:edit` *(new)* | Writes a NEW `TrainingQuestionAiDraft` row (new content hash); the previous draft transitions to `ARCHIVED` |
| `EDITED_VALIDATION_STALE` | `VALIDATION_PENDING` | Reviewer requests revalidation | `hr:training:ai:revalidate` | |
| `REJECTED` | `APPROVED_DRAFT` | **PROHIBITED** — directive §4: "A rejected question must never become approved without a documented remediation and successful revalidation path." Any such transition must go through `REJECTED → REQUIRES_HUMAN_REVIEW` (requires a new validation whose verdict is not REJECTED, bound to a new content hash) | `hr:training:ai:approve` + `hr:training:ai:remediate-rejected` *(new — intentionally scoped tight)* | Server refuses direct transition; must observe remediation chain |
| `REJECTED` | `ARCHIVED` | Operator archives after retention window | `hr:training:ai:archive` *(new)* | |
| `APPROVED_DRAFT` | (none — stays approved) | — | — | Publication is a SEPARATE slice; approval does not publish |
| any | `ARCHIVED` | Operator archives | `hr:training:ai:archive` | Terminal |

### 3.2 Why `EDITED_VALIDATION_STALE` creates a NEW draft row

Edits change the content hash. Keeping the previous row preserves
historical evidence (directive §9 "Original model output",
"Reviewer-edited content"). The newest row's `contentHash` becomes the
candidate; the previous row transitions to `ARCHIVED` with
`reasonCode = SUPERSEDED_BY_EDIT`. All validations remain intact and
attached to their original draft rows.

---

## 4. Immutable content-version binding (directive §5)

### 4.1 What binds to what

```
┌───────────────────────────────────────┐
│         TrainingQuestionAiDraft       │
│  clubId                               │────────────────────┐
│  courseId, courseVersionId            │                    │  tenant
│  draftJson                            │                    │  isolation
│  contentHash (sha256 canonical)       │────────────┐       │
│  sourceVideoSha256                    │            │       │
│  resolvedTranscriptBuildId            │            │       │
│  groundingProjectionSha256            │            │       │
│  pilotAuthorizationId / fingerprint   │            │       │
│  recordVersion (optimistic concur.)   │            │       │
└────────────┬──────────────────────────┘            │       │
             │                                       │       │
             │  draftId                              │       │
             ▼                                       │       │
┌───────────────────────────────────┐                │       │
│   TrainingQuestionAiValidation    │                │       │
│  draftContentHash                 │────────────────┘       │
│  validatorVersion                 │                        │
│  validatorSource                  │                        │
│  verdict + errors + flags + proposalJson                   │
└────────────┬──────────────────────┘                        │
             │ validationId (must match draftContentHash)    │
             ▼                                               │
┌───────────────────────────────────┐                        │
│      TrainingQuestionAiReview     │                        │
│  disposition                      │                        │
│  reviewedByClubId ◀───────────────┘                        │
│  reviewedByUserId (checked for tenant membership)          │
└───────────────────────────────────┘                        │
                                                             │
Every query: WHERE clubId = tenantWhere(principal, activeClubId).clubId
```

### 4.2 Content-hash algorithm

```ts
// canonical JSON (byte-identical to pipeline canonicaliser; same used
// by EP-TRAIN-6C-4 convert-draft-to-proposal.ts)
function canonicalise(v: unknown): string { /* sorted keys recursively */ }

function contentHash(draft: TrainingQuestionDraftLiteV1): string {
  return sha256Hex(canonicalise(draft));
}
```

### 4.3 Changes that invalidate approval eligibility

Any mutation to:

- `questionText`
- `options[].text`
- `options[].isCorrect`
- `explanation`
- `sourceSegmentIds`
- `questionType`

produces a new canonical JSON → new content hash → new draft row →
all previous validations and reviews become bound to the OLD hash.
The server-side guard (§5 below) refuses approval unless a validation
exists with a matching current `contentHash`.

### 4.4 Optimistic concurrency

Every write to `TrainingQuestionAiDraft` must include a conditional
`WHERE recordVersion = <value loaded>` clause. Prisma `update()` with
a compound `WHERE` + Prisma's `count === 0` detection pattern. On
conflict, return `409 Conflict` with code `STALE_RECORD_VERSION`.

```ts
const updated = await prisma.trainingQuestionAiDraft.updateMany({
  where: { id: draftId, recordVersion: expectedVersion },
  data:  { recordVersion: expectedVersion + 1, state: nextState, ... },
});
if (updated.count === 0) throw new ConflictError("STALE_RECORD_VERSION");
```

Reviews and validations are append-only; concurrency protection only
applies to the draft state machine.

---

## 5. Server-side approval guard (directive §6)

The UI's `evaluateApproval` (6D-3,
`src/components/ai-training/approval-guard.ts`) is NOT the authority.
A near-identical pure function lives server-side at
`src/lib/hr/training/ai-review/approval-guard.ts` and is the only
code path that may transition a draft to `APPROVED_DRAFT`.

### 5.1 Guard contract

```ts
export type ServerApprovalBlockReason =
  | "CANDIDATE_REJECTED"
  | "UNRESOLVED_HARD_ERRORS"
  | "VALIDATION_MISSING"
  | "VALIDATION_STALE"               // latest validation's draftContentHash !== draft.contentHash
  | "VALIDATION_SOURCE_INVALID"      // validatorSource !== "integrated-pipeline"
  | "CONTENT_HASH_MISMATCH"          // review request hash !== server draft hash
  | "SOURCE_VERSION_CHANGED"         // draft.sourceVideoSha256 !== current TrainingCourseVersion.videoSha256
  | "REVIEWER_LACKS_PERMISSION"      // hr:training:ai:approve missing
  | "CROSS_TENANT"                   // reviewedByClubId !== draft.clubId
  | "CONCURRENT_MODIFICATION"        // recordVersion mismatch
  | "VALIDATION_SERVICE_UNAVAILABLE" // health check failed
  | "DRAFT_NOT_FOUND";

export interface ServerApprovalDecision {
  readonly allowed: boolean;
  readonly reasons: readonly ServerApprovalBlockReason[];
  readonly httpStatus: number;        // 200 allowed, 409 stale/hash, 403 permission/tenant, 404 missing, 503 unavailable
  readonly message: string;
  readonly auditMeta: Record<string, unknown>;
}

export async function evaluateServerApproval(args: {
  principal: Principal;
  clubId: string;                    // active club
  draftId: string;
  submittedContentHash: string;      // from request body
  submittedRecordVersion: number;    // from request body
}): Promise<ServerApprovalDecision>
```

### 5.2 Guard call order (short-circuit on first failure group)

1. **`hr:training:ai:approve` on `clubId`** → if false, `REVIEWER_LACKS_PERMISSION` (403).
2. **Load draft** `WHERE id = draftId AND clubId = clubId` (tenant-scoped); null → `DRAFT_NOT_FOUND` (404) with same-shape 404 so cross-tenant enumeration returns the same response.
3. **`reviewedByClubId === draft.clubId`** → if false, `CROSS_TENANT` (403).
4. **`submittedContentHash === draft.contentHash`** → if false, `CONTENT_HASH_MISMATCH` (409).
5. **`submittedRecordVersion === draft.recordVersion`** → if false, `CONCURRENT_MODIFICATION` (409).
6. **Load latest validation** for this draft `WHERE draftContentHash = draft.contentHash`; null → `VALIDATION_MISSING` (409).
7. **`validation.validatorSource === "integrated-pipeline"`** → else `VALIDATION_SOURCE_INVALID` (409). *(Fixture validations are never approvable in production.)*
8. **`validation.verdict !== "REJECTED"`** → else `CANDIDATE_REJECTED` (409).
9. **`validation.errorsJson` parses to empty array** → else `UNRESOLVED_HARD_ERRORS` (409).
10. **`draft.sourceVideoSha256 === courseVersion.videoSha256`** (re-read from DB) → else `SOURCE_VERSION_CHANGED` (409). Guards against the video being swapped under the draft.
11. **`draft.state === "REQUIRES_HUMAN_REVIEW"`** → else `VALIDATION_STALE` (`EDITED_VALIDATION_STALE` state) or invalid-transition (depending on state).
12. All checks passed → `{ allowed: true }`.

### 5.3 Failure responses + audit

- Every guard failure returns a same-shape JSON `{ error: "approval_blocked", code, reasons }`.
- Every guard failure writes an audit row with
  `action: "training.ai.review.approve-blocked"`, the blocking reason
  codes in `meta.reasons`, `meta.contentHashSubmitted`,
  `meta.contentHashCurrent`, `meta.recordVersionSubmitted`,
  `meta.recordVersionCurrent`, `meta.validatorSource`, +
  `meta.validatorVersion`.
- Successful approval writes `action: "training.ai.review.approved"`
  with the validation id + content hash.

### 5.4 Browser never authoritative

- All approval mutations go through `POST /api/admin/ai-training/drafts/[id]/review` with body `{ disposition: "APPROVED", submittedContentHash, submittedRecordVersion, reviewerNote? }`.
- The UI's `evaluateApproval` function is advisory only — it disables the Approve button. The server guard is the authority.
- A DOM-tampered or curl-crafted request STILL fails the server guard with 409 and writes an audit row.

---

## 6. Tenant isolation + permissions (directive §7)

### 6.1 Proposed permission additions

Scoped tight per directive §7 "least privilege":

| Key | Purpose |
|-----|---------|
| `hr:training:ai:generate` | Initiate generation of new AI-drafted training questions against an authorised pilot |
| `hr:training:ai:review` | View the AI review queue + evidence; reject a draft |
| `hr:training:ai:edit` | Save reviewer edits to an AI-drafted question (creates a new draft + stale validation) |
| `hr:training:ai:revalidate` | Request revalidation of an edited draft or retry after `VALIDATION_FAILED` |
| `hr:training:ai:approve` | Promote a RHV draft to `APPROVED_DRAFT` |
| `hr:training:ai:remediate-rejected` | **Rare** — authorise a REJECTED-draft remediation chain. Scoped tight because it loosens the "rejected is terminal" guarantee |
| `hr:training:ai:archive` | Archive terminal drafts after retention |

**Not added:** a dedicated `hr:training:ai:publish` key. Publication
remains `hr:training:publish` on `TrainingCourseVersion` — an approved
AI draft becomes a candidate for inclusion in a future version's DRAFT
state, but the publish verb stays on the version, not the draft.

### 6.2 Permission bundling

- Existing `OPERATIONS_ADMIN` / `HR_MANAGER` / `TRAINING_AUTHOR` roles:
  grant `hr:training:ai:review` + `hr:training:ai:edit` + `hr:training:ai:revalidate`.
- `hr:training:ai:approve` + `hr:training:ai:remediate-rejected` +
  `hr:training:ai:archive`: restricted to a narrower role
  (e.g., existing `TRAINING_PUBLISHER` or a new
  `TRAINING_AI_APPROVER` — founder decides).
- `hr:training:ai:generate`: restricted to a service account + operators,
  not normal managers.

### 6.3 Tenant-scoped queries

Every query against `TrainingQuestionAiDraft`, `TrainingQuestionAiValidation`,
`TrainingQuestionAiReview`, `TrainingQuestionAiStateTransition` MUST use
`tenantWhere(principal, clubId)` or an explicit `clubId` filter
sourced from `getActiveClubId`. Drafts carry `clubId` directly;
validations + reviews join through `draftId` + check `clubId` on the
parent. `assertTenantOwned()` after any `findUnique` that returns a
draft.

### 6.4 Cross-tenant negative-test shape

The acceptance plan §4 (below) requires:

- Reviewer A at club X cannot see draft owned by club Y: API returns 404 (same-shape as "not found").
- Reviewer A cannot approve a draft owned by club Y: API returns 404 BEFORE the approval guard runs (short-circuit on the tenant query).
- Edits attempted from a session whose `activeClubId` differs from the draft's `clubId`: 404.
- Audit entries for the attempt still record `userId` + `ip` + `userAgent` so cross-tenant probing is detectable.

---

## 7. API contracts (directive §8)

Proposed minimum surface. Five routes, not six — the previous
estimate was heuristic; a single `POST .../review` covers approve +
reject + revalidation-request + regeneration-request via a
discriminated-union body (closer to Spectre's existing admin-action
patterns in `src/app/app/admin/people/safety-training/_actions.ts`).

### 7.1 Route inventory

| Method + Path | Purpose | Permission | Idempotency |
|---------------|---------|------------|:-----------:|
| `GET  /api/admin/ai-training/drafts` | List review-queue candidates for the active club, filterable by state | `hr:training:ai:review` | Idempotent |
| `GET  /api/admin/ai-training/drafts/[id]` | Load one draft + its latest validation + state history + the authorised grounding window | `hr:training:ai:review` | Idempotent |
| `POST /api/admin/ai-training/drafts/[id]/review` | Discriminated body: `APPROVE` / `REJECT` / `REQUEST_REVALIDATION` / `REQUEST_REGENERATION` | per action (see §7.2) | Request-key-based (§7.4) |
| `POST /api/admin/ai-training/drafts/[id]/edit` | Save an edit → NEW draft row (new hash) + old row archived | `hr:training:ai:edit` | Request-key-based |
| `GET  /api/admin/ai-training/drafts/[id]/history` | Full audit history for the draft (state transitions + review events + validation runs) | `hr:training:ai:review` | Idempotent |

### 7.2 Body schemas (discriminated unions)

```ts
// POST .../review request body
type ReviewRequest =
  | { action: "APPROVE";               submittedContentHash: string; submittedRecordVersion: number; reviewerNote?: string; requestKey: string; }
  | { action: "REJECT";                submittedContentHash: string; submittedRecordVersion: number; reviewerNote?: string; requestKey: string; }
  | { action: "REQUEST_REVALIDATION";  submittedContentHash: string; submittedRecordVersion: number;                       requestKey: string; }
  | { action: "REQUEST_REGENERATION";  submittedContentHash: string; submittedRecordVersion: number; reviewerNote?: string; requestKey: string; };

// POST .../edit request body
type EditRequest = {
  submittedContentHash: string;      // hash of the EXISTING draft the reviewer is editing on top of
  submittedRecordVersion: number;
  updates: {
    questionText?: string;
    options?: Array<{ text: string; isCorrect: boolean }>;
    explanation?: string;
    sourceSegmentIds?: number[];
    questionType?: "SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE";
  };
  requestKey: string;
};
```

### 7.3 Per-action permission matrix

| Action | Permission check | Guard call? |
|--------|------------------|:----------:|
| `APPROVE` | `hr:training:ai:approve` | **Yes** (full §5 guard) |
| `REJECT` | `hr:training:ai:review` | Light guard — no stale/hash check beyond tenant |
| `REQUEST_REVALIDATION` | `hr:training:ai:revalidate` | Light guard |
| `REQUEST_REGENERATION` | `hr:training:ai:review` | **No approval guard, but ALWAYS returns 501** in this slice — the live generation workflow is separately authorised (6D-5) |

### 7.4 Idempotency

`requestKey`: client-generated UUID v4. Server records the key +
response hash in a short-lived table (`RequestIdempotencyKey`) keyed
by `(route, key, reviewerId, draftId)`. Duplicate submissions within
60 s return the cached response.

**Reuses Spectre's existing pattern:** most admin `_actions.ts` write
paths today use `recordVersion` + user-driven retries; the idempotency
key tier is additive for safety when the UI retries after transient
network failure.

### 7.5 Concurrency behaviour

- All mutation routes use optimistic concurrency via the draft's
  `recordVersion` (§4.4).
- On `STALE_RECORD_VERSION`, response: `409` + `{ error: "stale", currentRecordVersion: N, currentContentHash: H }` so the UI can refresh and retry.

### 7.6 Error codes

| HTTP | Code | Meaning |
|-----:|------|---------|
| 200 | — | Success |
| 400 | `invalid_body` | Schema violation on request body |
| 400 | `invalid_action` | Discriminated-union action not recognised |
| 403 | `forbidden` | Permission missing |
| 403 | `cross_tenant` | Active-club mismatch (rare — tenant filter usually makes this a 404) |
| 404 | `not_found` | Draft not found or not in principal's tenant |
| 409 | `approval_blocked` | One of the server-side guard reasons |
| 409 | `stale` | Optimistic concurrency failure |
| 409 | `invalid_transition` | State machine refuses the requested change |
| 501 | `not_implemented` | `REQUEST_REGENERATION` in this slice |
| 503 | `validation_service_unavailable` | Pipeline health probe failed |

### 7.7 What is DELIBERATELY not an API in this slice

- No publication route — publication stays with `TrainingCourseVersion`.
- No "include this approved draft in the next version DRAFT" route — that is a later slice; approved drafts are candidates, not auto-included.
- No regeneration start route — gated behind 6D-5 live-inference authorisation.

---

## 8. Audit + evidence requirements (directive §9)

### 8.1 Audit events

All via existing `audit(actor, input)` from `src/lib/audit.ts`.
All `action` strings namespace-prefixed with `training.ai.*`:

| Action | `entityType` | When |
|--------|-------------|------|
| `training.ai.draft.generated` | `TrainingQuestionAiDraft` | Draft row created |
| `training.ai.draft.validation.started` | `TrainingQuestionAiDraft` | Transition to VALIDATION_PENDING |
| `training.ai.draft.validation.completed` | `TrainingQuestionAiValidation` | Validation row written; `meta.verdict`, `meta.errors.length`, `meta.flags.length` |
| `training.ai.draft.validation.failed` | `TrainingQuestionAiValidation` | Pipeline exception |
| `training.ai.draft.edited` | `TrainingQuestionAiDraft` (the NEW row) | Edit creates new draft + archives old. `meta.previousDraftId`, `meta.previousContentHash`, `meta.newContentHash` |
| `training.ai.draft.revalidation.requested` | `TrainingQuestionAiDraft` | — |
| `training.ai.review.approved` | `TrainingQuestionAiReview` | Successful approval; `meta.validationId`, `meta.contentHash` |
| `training.ai.review.approve-blocked` | `TrainingQuestionAiDraft` | Guard refused approval; `meta.reasons` |
| `training.ai.review.rejected` | `TrainingQuestionAiReview` | Reviewer rejected |
| `training.ai.draft.regeneration.requested` | `TrainingQuestionAiDraft` | Request-only (501 in this slice) |
| `training.ai.draft.archived` | `TrainingQuestionAiDraft` | Terminal cleanup |

### 8.2 What is preserved

- **Original model output** — in the ORIGINAL `TrainingQuestionAiDraft` row's `draftJson`, kept forever (until retention policy deletes it).
- **Reviewer-edited content** — new `TrainingQuestionAiDraft` rows per edit; old rows archived but retained.
- **Validation findings** — append-only `TrainingQuestionAiValidation` rows carry full errors / flags / proposal snapshot.
- **Reviewer identity** — every review + state transition carries `reviewedByUserId`.
- **Timestamps** — every row has `createdAt`; transitions have `occurredAt`.
- **Source evidence references** — draft carries `sourceVideoSha256`, `resolvedTranscriptBuildId`, `groundingProjectionSha256`, `pilotAuthorizationFingerprint`.
- **Content hashes** — draft, validation, and review all carry hashes for cryptographic traceability.
- **State transitions** — `TrainingQuestionAiStateTransition` table holds the full graph.

### 8.3 What is NOT stored in audit events

- No credentials (HMAC secrets, Modal proxy keys) — those belong in `AuditLog.meta` only as hashes if at all.
- No full transcript text in audit `meta` — the draft already carries `resolvedTranscriptBuildId` and `groundingProjectionSha256` so any auditor can re-hydrate the exact transcript used; duplicating the text bloats `AuditLog`.
- No raw Modal response bytes — those remain in scratchpad; audit records the `validationId` only.

---

## 9. Video + citation evidence contract (directive §10)

Reuses the existing authenticated proxy pattern. **No new R2 route.**

### 9.1 Resolution chain

```
Candidate citation {segmentId, startSec, endSec}
       │
       ▼
Lookup authorised grounding projection for draft.courseVersionId
       │
       ▼
Verify segmentId ∈ grounding.passages AND NOT ∈ excluded
       │
       ▼
Return { videoRouteUrl: `/api/hr/training/versions/${courseVersionId}/video`,
         startSec, endSec, passageText, citationHandle }
```

### 9.2 Playback through the existing route

- Browser requests `GET /api/hr/training/versions/[id]/video` (existing route in §1.6).
- Auth path: `hr:training:ai:review` grants `hr:training:read`-equivalent on this specific version via a permission-bridge (see §9.3). The existing `callerCanReadVersion` check already accepts admin-with-training-read; we extend it so `hr:training:ai:review` on the same `clubId` also returns `{ ok: true, clubId }`.
- Client seeks via `videoElement.currentTime = startSec`; `pause()` at `endSec` is advisory.

### 9.3 Permission bridge

Add to `callerCanReadVersion` in `src/app/api/hr/training/versions/[id]/video/route.ts`:

```ts
// After the existing hr:training:read admin check:
if (admin && hasPermission(admin, clubId, "hr:training:ai:review")) return { ok: true, clubId };
```

Reason: the AI review surface IS an admin-training surface; granting
`hr:training:ai:review` implies read-access to the version's video
for citation-seek purposes. No separate media permission.

### 9.4 Correct source-video + course-version binding

- Citation resolver validates `draft.sourceVideoSha256 === currentVersion.videoSha256`. Mismatch → `409 source_version_mismatch`.
- The returned `videoRouteUrl` always carries the specific `courseVersionId`; a reviewer cannot re-point an approved draft at a different version by URL manipulation because every API call re-fetches `draft.courseVersionId`.

### 9.5 Tenant protection on media access

Unchanged from today — `callerCanReadVersion` already matches on
`clubId` and returns a same-shape 404 for cross-tenant requests.

### 9.6 What is DELIBERATELY not in this slice

- No new R2 signed-URL helper (none exists in the repo today; Spectre's current pattern IS the authenticated proxy).
- No implementation of citation-seek wiring in the UI (that's the 6D-4C / 6D-5 slice territory).
- No video transcoding, no CDN, no HTTP Range-based optimisation beyond what `video-stream.ts` already does.

---

## 10. Proposed implementation sequence (directive §11)

Seven ordered sub-slices. None is auto-authorised.

| # | Slice | Scope | Combinable? | Staging acceptance required? |
|:-:|-------|-------|:-:|:-:|
| 1 | **6D-4B** Persistence + governance | Prisma migration adding the 4 new models + the permission constants. **No API routes.** Unit tests for the server-side guard pure function. | No — foundational; isolate so migration can be reviewed alone | Yes — migration dry-run on staging DB snapshot |
| 2 | **6D-4C** Read-only candidate retrieval | `GET /drafts` + `GET /drafts/[id]` + `GET /drafts/[id]/history`. No mutations. Replaces the UI's fixture import with API calls. | Combinable with 6D-4B if the slice stays under ~500 lines | Yes |
| 3 | **6D-4D** Editing + server-side revalidation | `POST /drafts/[id]/edit` + `POST /drafts/[id]/review` (REQUEST_REVALIDATION only). Fixture revalidation outcomes become server-stored predetermined outcomes until live inference lands. | **Not** combinable with 6D-4C; adds mutation surface + auditing | Yes |
| 4 | **6D-4E** Server-authoritative approval + rejection | `POST /drafts/[id]/review` (APPROVE + REJECT). Full server guard implementation. Integration tests covering every §5.2 guard branch + cross-tenant negative tests. | **Not** combinable | Yes — critical safety gate |
| 5 | **6D-4F** Video evidence integration | Permission bridge on the existing `GET /api/hr/training/versions/[id]/video` route + citation-seek wiring in the UI. | Combinable with 6D-4E only if the UI changes are kept trivial | Yes |
| 6 | **6D-5** Live inference + regeneration | `REQUEST_REGENERATION` flips from 501 to a real Modal-backed job. Requires reactivation of the 6C-11-era pilot authorisation flow. | **Not** combinable | Yes — separate founder authorisation for Modal spend |
| 7 | **6D-6** Publication + employee assignment | `TrainingQuestion.sourceAiDraftId` column; "include approved draft in next DRAFT version" workflow; `hr:training:publish` continues to govern publication. | **Not** combinable | Yes — separate founder authorisation for employee-visible content |

### 10.1 Sequencing commentary

- **6D-4B must land first.** Nothing after it is testable without the data model.
- **6D-4C is low-risk** because it adds no mutation. Could land with 6D-4B behind a feature flag.
- **6D-4E is the safety-critical slice** — the server guard is where directive §6 and the founder acceptance standard are actually enforced.
- **6D-5 and 6D-6 are each gated on separate founder authorisations** that go beyond this 6D-4A design.

---

## 11. Open decisions requiring founder approval (directive §13)

Each item needs an explicit yes/no before 6D-4B begins:

1. **Permission-key naming.** The design uses `hr:training:ai:<verb>` to mirror the existing `hr:training:<verb>` convention. Alternatives: `hr:training:review:<verb>`, or a flat `training-ai:<verb>`. Founder preference?

2. **Role bundling for `hr:training:ai:approve`.** Should this grant map onto the existing `HR_MANAGER` role, a narrower `TRAINING_PUBLISHER`, or a brand-new `TRAINING_AI_APPROVER` role? The design assumes the founder will pick narrowly.

3. **`hr:training:ai:remediate-rejected` existence.** This is the scoped-tight escape hatch for the REJECTED → remediation → APPROVED path. Alternatives:
   - Keep it (design position — explicit remediation audit trail).
   - Drop it + make REJECTED fully terminal (safer but means legitimate reviewer corrections require archiving and re-generating).

4. **Content retention policy.** Archived drafts + validations + reviews stay forever by default. Does the founder want a retention cap (e.g., 7 years) with an automated archive-cleanup job?

5. **Request-idempotency-key TTL.** 60 s matches the "transient network retry" use case. Longer TTLs (minutes) protect against slower manual retries but widen the collision window. Founder preference?

6. **Media permission bridge.** §9.3 bridges `hr:training:ai:review` → read-access on the version's video. Alternative: add a dedicated `hr:training:ai:evidence:read`. The bridge is simpler; the dedicated permission is tighter.

7. **Fixture validator outputs in production DB.** The current UI uses fixture-mode revalidation outcomes. Should the production DB EVER hold `validatorSource = "fixture"` rows (e.g., for demos)? The design says no (production only accepts `integrated-pipeline`), but a staging-only exception would ease operator demos.

8. **Where does generation metadata (pilot authorization, modal cost, backend proof) persist?** Three options:
   - On `TrainingQuestionAiDraft` directly (chosen in this design — `pilotAuthorizationId`, `pilotAuthorizationFingerprint` fields).
   - In a separate `TrainingQuestionAiGenerationRun` table joined via `generationRunId`. Cleaner if multiple drafts share one run.
   - In both (duplicate, slight extra storage). Founder call.

9. **The 6D-4C / 6D-4B combinability call.** If combined, the first staging deploy is bigger. If split, two migrations land back-to-back. Either defensible.

---

## 12. Mandatory STOP (directive §14)

- Architecture design complete. ✓
- Acceptance test matrix in a sibling document. ✓
- **STOPPING design slice.**
- No Prisma change. No API code. No merge. No deploy. No Modal. No publication.
- 6D-4B / 6D-4C / 6D-4D / 6D-4E / 6D-4F / 6D-5 / 6D-6 — none is authorised to begin.

**Founder acceptance standard** (directive closing paragraph):

> *"Produce a concrete, repository-grounded design for a secure,
> tenant-isolated and auditable AI question-review backend, with
> immutable validation-to-content binding and server-enforced
> approval governance, before any persistent implementation begins."*

Status: **met**. Every design element above cites a real existing
Spectre pattern (file paths included). The 4 new Prisma models, 5
routes, 7 new permissions, 11 audit actions, and 7-slice sequencing
sit on top of Spectre's existing training + RBAC + audit + tenant
infrastructure rather than replacing it.
