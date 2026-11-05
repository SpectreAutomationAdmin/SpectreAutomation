// EP-TRAIN-6D-4L (2026-11-05) — Transcription evidence ingestion
// services barrel. Callers should import from this module root rather
// than reaching into `./ingest` directly.

export {
  persistTranscriptBuild,
  persistTranscriptSegments,
  persistGroundingProjection,
  EXCLUDED_SEGMENT_INDICES,
} from "./ingest";

export type {
  PersistTranscriptBuildInput,
  PersistTranscriptBuildResult,
  PersistTranscriptSegmentInput,
  PersistTranscriptSegmentsInput,
  PersistTranscriptSegmentsResult,
  PersistGroundingProjectionPassageInput,
  PersistGroundingProjectionExcludedPassageInput,
  PersistGroundingProjectionInput,
  PersistGroundingProjectionResult,
} from "./ingest";
