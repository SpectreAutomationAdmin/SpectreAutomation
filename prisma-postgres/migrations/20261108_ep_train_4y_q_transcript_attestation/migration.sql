-- EP-TRAIN-4Y-Q §5 (2026-11-08) — Transcript-segment reviewer attestation (Postgres).
-- Mirror of prisma/migrations/20261108_ep_train_4y_q_transcript_attestation.
--
-- Additive-only. Nullable columns + one additional index.
-- No existing data changes; no rows touched.

ALTER TABLE "TrainingTranscriptSegment"
  ADD COLUMN "reviewerAttestedAt" TIMESTAMP(3),
  ADD COLUMN "reviewerAttestedByUserId" TEXT,
  ADD COLUMN "reviewerAttestationNote" TEXT;

CREATE INDEX "TrainingTranscriptSegment_attested_idx"
  ON "TrainingTranscriptSegment" ("clubId", "reviewerAttestedAt");
