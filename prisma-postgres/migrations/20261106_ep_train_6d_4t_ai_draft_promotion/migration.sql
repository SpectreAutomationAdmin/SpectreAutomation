-- EP-TRAIN-6D-4T (2026-11-06) — Approved AI draft → TrainingQuestion
-- promotion sidecar. Postgres mirror of the SQLite migration at
-- `prisma/migrations/20261106_ep_train_6d_4t_ai_draft_promotion/migration.sql`.
--
-- Additive-only. Zero changes to any existing production entity.
-- Founder-authorised on 2026-11-06 with eight conditions.
--
-- Not applied to staging or production in this slice (4T is offline
-- / disposable-Postgres only).

CREATE TABLE IF NOT EXISTS "TrainingQuestionAiDraftPromotion" (
    "id"                                TEXT NOT NULL,
    "clubId"                            TEXT NOT NULL,

    "draftId"                           TEXT NOT NULL,
    "questionId"                        TEXT NOT NULL,

    "destination"                       TEXT NOT NULL,
    "checkpointId"                      TEXT,

    "approvedDraftContentHash"          TEXT NOT NULL,
    "approvedValidationId"              TEXT NOT NULL,
    "verifiedAnswerOptionIndex"         INTEGER NOT NULL,
    "verifiedAnswerSnapshotHash"        TEXT NOT NULL,
    "approvedReviewId"                  TEXT NOT NULL,
    "approvedByUserId"                  TEXT NOT NULL,

    "promotedQuestionContentHash"       TEXT NOT NULL,

    "promotedByUserId"                  TEXT NOT NULL,
    "promotedAt"                        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    "createdAt"                         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingQuestionAiDraftPromotion_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TrainingQuestionAiDraftPromotion"
  ADD CONSTRAINT "TrainingQuestionAiDraftPromotion_clubId_fkey"
    FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TrainingQuestionAiDraftPromotion"
  ADD CONSTRAINT "TrainingQuestionAiDraftPromotion_draftId_fkey"
    FOREIGN KEY ("draftId") REFERENCES "TrainingQuestionAiDraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TrainingQuestionAiDraftPromotion"
  ADD CONSTRAINT "TrainingQuestionAiDraftPromotion_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "TrainingQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingQuestionAiDraftPromotion_draftId_key"
    ON "TrainingQuestionAiDraftPromotion" ("draftId");

CREATE UNIQUE INDEX IF NOT EXISTS "TrainingQuestionAiDraftPromotion_questionId_key"
    ON "TrainingQuestionAiDraftPromotion" ("questionId");

CREATE INDEX IF NOT EXISTS "TrainingQuestionAiDraftPromotion_clubId_draftId_idx"
    ON "TrainingQuestionAiDraftPromotion" ("clubId", "draftId");

CREATE INDEX IF NOT EXISTS "TrainingQuestionAiDraftPromotion_clubId_questionId_idx"
    ON "TrainingQuestionAiDraftPromotion" ("clubId", "questionId");
