-- EP-TRAIN-3 Slice 3C (2026-10-30) -- preserve full MULTI_ANSWER
-- selection set on TrainingQuestionResponse.  Additive-only; existing
-- rows get NULL (legacy semantics preserved: single-row evidence per
-- (attempt, question), use selectedOptionId).
ALTER TABLE "TrainingQuestionResponse"
  ADD COLUMN "selectedOptionIdsJson" TEXT;
