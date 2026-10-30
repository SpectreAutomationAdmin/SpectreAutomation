-- EP-TRAIN-3 Slice 3C (2026-10-30) -- SQLite (dev) mirror.  Additive;
-- rollback does NOT drop the column.
ALTER TABLE "TrainingQuestionResponse" ADD COLUMN "selectedOptionIdsJson" TEXT;
