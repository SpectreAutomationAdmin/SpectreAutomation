-- EP-TRAIN-4Y-V §4 (2026-11-09) — AI-authored metadata attribution (Postgres).
-- Mirror of prisma/migrations/20261109_ep_train_4y_v_metadata_attribution.
--
-- Additive-only. Four nullable columns on TrainingCourse. No existing
-- data touched. Durable "SYSTEM authored, manager hasn't edited yet"
-- signal, superseding the title/code string-compare heuristic used by
-- 4Y-U fix3.

ALTER TABLE "TrainingCourse" ADD COLUMN "aiMetadataAttributionAt" TIMESTAMP(3);
ALTER TABLE "TrainingCourse" ADD COLUMN "aiMetadataAttributionRunId" TEXT;
ALTER TABLE "TrainingCourse" ADD COLUMN "aiMetadataAttributionSource" TEXT;
ALTER TABLE "TrainingCourse" ADD COLUMN "aiMetadataAttributedTitle" TEXT;
