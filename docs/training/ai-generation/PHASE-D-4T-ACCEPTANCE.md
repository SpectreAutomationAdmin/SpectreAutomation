# EP-TRAIN-6D-4T — Approved AI Question → Course-Authoring Bridge — Acceptance

Status: **PREFLIGHT PAUSED AT §3 SCHEMA AUTHORIZATION GATE.**

Per directive §3: "Determine whether the existing schema supports an
immutable, idempotent link between the approved AI draft and the
resulting course question. If additional schema changes are required,
present the minimal additive design and STOP for founder authorization
before implementation. Do not silently introduce new tables or
columns."

Author: Claude (Opus 4.7). Date: 2026-11-06. Branch:
`ep-train-6d-4t/promotion-bridge` (design doc only; not pushed).

## 1. One-line summary

The existing schema has NO column linking a `TrainingQuestion` back
to its originating `TrainingQuestionAiDraft`. A minimal additive
schema change is required before the promotion service can be built.
Two options were evaluated; Option B (dedicated sidecar table,
following the EP-TRAIN-6D-4B pattern) is recommended. **No code has
been written; no migration authored; no tests run.**

## 2. Preflight findings

| Surface                    | Column that would link to AI draft           | Present today? |
| -------------------------- | --------------------------------------------- | :------------: |
| `TrainingQuestion`         | `sourceAiDraftId` or similar                  | ✗              |
| `TrainingAnswerOption`     | any back-pointer to the AI draft's options    | ✗              |
| `TrainingCheckpoint`       | any back-pointer                              | ✗              |
| sidecar table              | any `(draftId → questionId)` mapping          | ✗              |

The current `createQuestion` service at
[src/lib/hr/training/questions.ts:121](src/lib/hr/training/questions.ts#L121)
is a clean, tenant-scoped, atomic, audited writer — but it has no
AI-side concern.

Idempotency-by-convention paths considered + REJECTED:

- Match on `prompt + checkpointId`: breaks on reviewer edits + legitimate
  prompt collisions.
- Audit-table-only: `AuditLog` has no FK uniqueness; legitimate audit
  rows cannot double as the authoritative promotion ledger.
- Soft hash in `TrainingQuestion.prompt`: forces data corruption into a
  user-facing field.

## 3. Recommended design (summary; full detail in
`PHASE-D-4T-PROMOTION-DESIGN.md`)

Add ONE new sidecar table `TrainingQuestionAiDraftPromotion`:

- `clubId` (FK → Club) for direct tenant filtering.
- `draftId` **UNIQUE** (FK → TrainingQuestionAiDraft, onDelete:
  Restrict).
- `questionId` **UNIQUE** (FK → TrainingQuestion, onDelete: Restrict).
- `destination` enum string (`"CHECKPOINT" | "FINAL_ASSESSMENT"`).
- Immutable approval bindings: `approvedDraftContentHash`,
  `approvedValidationId`, `approvedByUserId`.
- Promotion-side bookkeeping: `promotedByUserId`, `promotedAt`,
  `createdAt`.

Zero changes to existing production columns on `TrainingQuestion`,
`TrainingAnswerOption`, `TrainingCheckpoint`, or
`TrainingQuestionAiDraft`. Prisma-side back-relations are additive
only.

## 4. What this slice would do AFTER authorization (not yet done)

1. Author `20261106_ep_train_6d_4t_ai_draft_promotion/migration.sql`
   (SQLite) + `prisma-postgres/migrations/.../migration.sql` (PG
   mirror), additive only.
2. Add the model + 3 back-relations in both
   `prisma/schema.prisma` + `prisma-postgres/schema.prisma`.
3. Implement
   `src/lib/hr/training/ai-review/promotion-service.ts` with:
   - Full eligibility matrix (directive §5).
   - Atomic + idempotent via P2002-driven dedup.
   - Human-verified answer propagation (directive §6).
   - Refuse MULTI_ANSWER (per 4N precedent).
   - Audit atomicity (directive §7).
4. Add a minimal admin-UI action on the persisted review workspace:
   "Add to draft version" with a destination picker.
5. Tests: directive §10's 18 scenarios split across vitest contract
   + jsdom UI + disposable-PG16 integration.
6. Full 4B–4P + 4T regression on vitest, Prisma validate, scoped
   typecheck, nav audit, placeholder scan.
7. Commit on the current branch. NO push. NO staging deploy.

## 5. What this slice CANNOT ship until authorization

- The migration file itself (would introduce a schema change).
- The promotion service (would depend on the new column/table).
- The UI button (would depend on the service).
- The tests (would depend on the service).

## 6. Awaiting founder response

The founder must EITHER:

- **(A)** Approve Option B schema (recommended) so 4T proceeds to
  §4 implementation. Reply "proceed with Option B" or equivalent.
- **(A')** Approve Option A schema (single `sourceAiDraftId @unique`
  column on `TrainingQuestion`). Reply "proceed with Option A".
- **(B)** Direct a different additive design. Describe it in your
  reply.
- **(C)** Pause 4T entirely and prioritise a different slice (e.g.
  4U narrow role, 4V transcription). Reply accordingly.

Until the founder picks (A), (A'), (B), or (C), 4T remains in this
preflight state. No migration, service, UI, or test will land.

## 7. Directive §11 deliverables — status

| Deliverable                                | Status                                            |
| ------------------------------------------ | ------------------------------------------------- |
| `PHASE-D-4T-PROMOTION-DESIGN.md`           | ✅ this commit                                     |
| `PHASE-D-4T-ACCEPTANCE.md`                 | ✅ this commit                                     |
| Implementation commit                      | ⏸ PAUSED pending schema authorisation              |
| Disposable PostgreSQL evidence              | ⏸ PAUSED (tests depend on the schema)              |
| Clear description of any schema additions  | ✅ Option A + Option B both documented in detail   |
| Explicit follow-on requirements            | ✅ §6, §7, §8 of design doc + §8 of this acceptance |

## 8. STOP compliance (directive §12) — every boundary honoured

| Boundary                                 | Status                            |
| ---------------------------------------- | --------------------------------- |
| No staging or production deployment      | HONOURED                          |
| No shared database migration             | HONOURED                          |
| No Modal/Qwen inference                  | HONOURED                          |
| No transcription worker activation       | HONOURED                          |
| No historical candidate modification     | HONOURED                          |
| No course publication                    | HONOURED                          |
| No employee assignments                  | HONOURED                          |
| No unrelated UI changes                  | HONOURED                          |
| No permanent role grants                 | HONOURED                          |
| 126 unrelated WIP files preserved        | HONOURED — stashed at entry        |
| STOP for schema-change authorization     | **TRIGGERED — correct STOP cause** |
