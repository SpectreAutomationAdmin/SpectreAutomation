-- EP-TRAIN-4Y-V §4 (2026-11-09) — AI-authored metadata attribution on TrainingCourse.
--
-- Spectre writes title / description / code on TrainingCourse when
-- the deterministic or Qwen metadata generator produces a result on
-- a still-provisional course. The 4Y-U route detected "provisional"
-- by string-comparing title against "Untitled training course" and
-- code against the "AUTO-DRAFT" prefix, which:
--   (a) silently drifts if a manager edits ONE of the two markers
--       and not the other (bug fix in 4Y-U fix3 switched to OR
--       semantics), and
--   (b) cannot survive the generator overwriting the markers
--       themselves — after metadata is written once, the markers
--       are gone and any legitimate retry has no way to know
--       whether it's the SYSTEM or a MANAGER sitting at the title.
--
-- This slice adds a durable attribution record on the course row:
--
--   - aiMetadataAttributionAt      — timestamp of the system write
--   - aiMetadataAttributionRunId   — for Qwen-sourced metadata,
--                                    the generation run id; null
--                                    for deterministic path
--   - aiMetadataAttributionSource  — "deterministic" | "ai"
--   - aiMetadataAttributedTitle    — the exact title the system
--                                    wrote (snapshot). A manager
--                                    edit makes current title ≠ the
--                                    attributed snapshot, which is
--                                    the authoritative "manager
--                                    finalised" signal.
--
-- The /generate-metadata route uses attribution + snapshot equality
-- as its idempotency guard. The admin course-identity edit path
-- clears attribution when the manager explicitly edits.

ALTER TABLE "TrainingCourse" ADD COLUMN "aiMetadataAttributionAt" DATETIME;
ALTER TABLE "TrainingCourse" ADD COLUMN "aiMetadataAttributionRunId" TEXT;
ALTER TABLE "TrainingCourse" ADD COLUMN "aiMetadataAttributionSource" TEXT;
ALTER TABLE "TrainingCourse" ADD COLUMN "aiMetadataAttributedTitle" TEXT;
