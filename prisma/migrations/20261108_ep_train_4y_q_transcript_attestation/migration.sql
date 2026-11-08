-- EP-TRAIN-4Y-Q §5 (2026-11-08) — Transcript-segment reviewer attestation.
--
-- The 6C-10B converter correctly refuses to ground questions on
-- TrainingTranscriptSegment rows whose `pendingReviewJson` carries
-- any flag (Whisper confidence / source-org mismatch / uncertainty).
-- In staging the Silver Springs orientation transcript's 163
-- segments carry pendingReview flags, so every 4Y-N and 4Y-M draft
-- rejects at CONVERT with ERR_CONVERT_SEGMENT_PENDING_REVIEW
-- (proven live in 4Y-P §3.5).
--
-- This slice adds the per-segment reviewer-attestation fields the
-- materialiser consults to clear `pendingReview` on the projection
-- it builds. The ORIGINAL Whisper transcript is NEVER rewritten
-- (text / startSec / endSec / pendingReviewJson all remain
-- immutable); the attestation only annotates that a reviewer has
-- independently verified the segment is reliable evidence.

ALTER TABLE "TrainingTranscriptSegment" ADD COLUMN "reviewerAttestedAt" DATETIME;
ALTER TABLE "TrainingTranscriptSegment" ADD COLUMN "reviewerAttestedByUserId" TEXT;
ALTER TABLE "TrainingTranscriptSegment" ADD COLUMN "reviewerAttestationNote" TEXT;

CREATE INDEX "TrainingTranscriptSegment_attested_idx"
  ON "TrainingTranscriptSegment" ("clubId", "reviewerAttestedAt");
