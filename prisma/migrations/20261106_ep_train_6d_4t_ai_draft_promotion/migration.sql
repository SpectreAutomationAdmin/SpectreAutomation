-- EP-TRAIN-6D-4T (2026-11-06) — Approved AI draft → TrainingQuestion
-- promotion sidecar.
--
-- Additive-only. ONE new table + four indexes. Zero changes to any
-- existing production entity. Rollback: DROP TABLE on this one table.
--
-- Founder-authorised with eight conditions on 2026-11-06. See
-- docs/training/ai-generation/PHASE-D-4T-PROMOTION-DESIGN.md.

CREATE TABLE "TrainingQuestionAiDraftPromotion" (
    "id"                                TEXT NOT NULL PRIMARY KEY,
    "clubId"                            TEXT NOT NULL,

    -- 1-1 symmetry: each approved draft can produce at most ONE
    -- promoted question, and each promoted question can be linked
    -- to at most ONE approved draft.
    "draftId"                           TEXT NOT NULL,
    "questionId"                        TEXT NOT NULL,

    -- Destination the promotion chose. Immutable after insert.
    -- Values: "CHECKPOINT" | "FINAL_ASSESSMENT".
    "destination"                       TEXT NOT NULL,

    -- The checkpoint id on CHECKPOINT destinations, null on
    -- FINAL_ASSESSMENT. Kept redundantly with TrainingQuestion.checkpointId
    -- so the promotion row is self-contained for forensic audits even
    -- if the TrainingQuestion row is later edited to change checkpointId.
    "checkpointId"                      TEXT,

    -- IMMUTABLE APPROVAL PROVENANCE (founder condition 2).
    -- Snapshotted from the TrainingQuestionAiDraft at promotion-time.
    -- A subsequent reviewer edit that bumps the draft's recordVersion
    -- or contentHash leaves these columns byte-identical; they are
    -- the forensic record of exactly what was approved when the
    -- promotion happened.
    "approvedDraftContentHash"          TEXT NOT NULL,
    "approvedValidationId"              TEXT NOT NULL,
    "verifiedAnswerOptionIndex"         INTEGER NOT NULL,
    "verifiedAnswerSnapshotHash"        TEXT NOT NULL,
    "approvedReviewId"                  TEXT NOT NULL,
    "approvedByUserId"                  TEXT NOT NULL,

    -- CONTENT-DIVERGENCE DETECTION (founder condition 5).
    -- Hash of the TrainingQuestion + options AT THE MOMENT OF PROMOTION.
    -- The 4T-extended publish gate recomputes this hash against the
    -- current question/options content and refuses publication on
    -- divergence (requires reapproval via a follow-on slice).
    "promotedQuestionContentHash"       TEXT NOT NULL,

    -- Promotion-side bookkeeping.
    "promotedByUserId"                  TEXT NOT NULL,
    "promotedAt"                        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    "createdAt"                         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingQuestionAiDraftPromotion_clubId_fkey"
        FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingQuestionAiDraftPromotion_draftId_fkey"
        FOREIGN KEY ("draftId") REFERENCES "TrainingQuestionAiDraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TrainingQuestionAiDraftPromotion_questionId_fkey"
        FOREIGN KEY ("questionId") REFERENCES "TrainingQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TrainingQuestionAiDraftPromotion_draftId_key"
    ON "TrainingQuestionAiDraftPromotion" ("draftId");

CREATE UNIQUE INDEX "TrainingQuestionAiDraftPromotion_questionId_key"
    ON "TrainingQuestionAiDraftPromotion" ("questionId");

CREATE INDEX "TrainingQuestionAiDraftPromotion_clubId_draftId_idx"
    ON "TrainingQuestionAiDraftPromotion" ("clubId", "draftId");

CREATE INDEX "TrainingQuestionAiDraftPromotion_clubId_questionId_idx"
    ON "TrainingQuestionAiDraftPromotion" ("clubId", "questionId");
