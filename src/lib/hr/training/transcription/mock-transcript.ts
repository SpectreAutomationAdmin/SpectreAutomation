// EP-TRAIN-4Y-BF — deterministic simulated transcript for NON-BILLABLE
// (test-identity) versions.
//
// It lets an automated test exercise the whole preparation pipeline —
// upload → queue → transcription worker → ingest → hand-off to question
// generation — without a transcription provider call. It proves the
// orchestration; it does NOT prove that real transcription works.
//
// The text is obviously synthetic (it opens with "Simulated narration")
// and is only ever produced for a version the server has resolved as
// non-billable, in an environment that explicitly allows simulation.
//
// Shape constraints (what the rest of the pipeline needs from it):
//   - segments tile the whole video, so coverage checks pass;
//   - no digits and none of the phrases the employee-facing text
//     sanitiser rejects, so simulated questions built from it are valid;
//   - neighbouring segments share almost no words, so they are not
//     flagged as repetition and simulated questions are not duplicates.

export const MOCK_TRANSCRIPT_MODEL_VARIANT = "mock-transcript-v1" as const;

const SEGMENT_SECONDS = 5;
const MIN_SEGMENTS = 24;
const MAX_SEGMENTS = 400;

const ADJECTIVES = [
  "amber", "brisk", "calm", "damp", "eager", "firm", "gentle", "humble", "ivory", "jolly",
  "keen", "lively", "mellow", "narrow", "open", "patient", "quiet", "rustic", "steady", "tidy",
  "upper", "vivid", "warm", "young", "zesty", "bold", "crisp", "dusty", "early", "fresh",
  "golden",
] as const;
const NOUNS = [
  "anchor", "basket", "candle", "doorway", "engine", "fountain", "garden", "harbor", "island", "jacket",
  "kettle", "ladder", "meadow", "napkin", "orchard", "pantry", "quarry", "railing", "saddle", "table",
  "umbrella", "valley", "window", "yard", "zipper", "apron", "bench", "counter", "drawer", "entrance",
  "fairway", "gate", "hallway", "inlet", "junction", "kitchen", "locker", "mirror", "notebook", "oven",
  "patio",
] as const;
const VERBS = [
  "arranges", "balances", "carries", "delivers", "examines", "folds", "gathers", "handles", "inspects", "joins",
  "keeps", "lifts", "measures", "notices", "offers", "polishes", "questions", "returns", "stacks", "trims",
  "unpacks", "visits", "washes", "yields", "adjusts", "brushes", "cleans", "dries", "empties", "fastens",
  "greets", "holds", "invites", "labels", "moves", "opens", "places",
] as const;
const ADVERBS = [
  "always", "briefly", "carefully", "daily", "evenly", "firmly", "gladly", "happily", "inside", "jointly",
  "kindly", "lightly", "mainly", "neatly", "often", "promptly", "quickly", "rarely", "safely", "together",
  "usually", "warmly", "yearly", "above", "below", "closely", "directly", "early", "fully",
] as const;

function pick<T>(pool: readonly T[], index: number, stride: number, offset: number): T {
  return pool[(index * stride + offset) % pool.length];
}

/** One synthetic sentence of thirteen words for segment `i`. Strides are
 *  coprime with each pool length, so a word recurs in the same slot only
 *  once per full pool cycle. */
function sentenceFor(i: number): string {
  const words = [
    pick(ADJECTIVES, i, 7, 0),
    pick(NOUNS, i, 9, 3),
    pick(VERBS, i, 5, 1),
    pick(ADVERBS, i, 4, 2),
    pick(ADJECTIVES, i, 11, 13),
    pick(NOUNS, i, 16, 20),
    pick(VERBS, i, 8, 17),
    pick(ADVERBS, i, 9, 11),
    pick(ADJECTIVES, i, 3, 22),
    pick(NOUNS, i, 5, 31),
    pick(VERBS, i, 11, 29),
    pick(ADVERBS, i, 13, 19),
    pick(NOUNS, i, 23, 9),
  ];
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".";
}

export interface MockTranscriptSegment {
  readonly id: number;
  readonly text: string;
  readonly startSec: number;
  readonly endSec: number;
}

/** Deterministic: the same duration always yields the same transcript. */
export function buildMockTranscriptSegments(videoDurationSec: number | null): MockTranscriptSegment[] {
  const duration =
    typeof videoDurationSec === "number" && Number.isFinite(videoDurationSec) && videoDurationSec > 0
      ? videoDurationSec
      : MIN_SEGMENTS * SEGMENT_SECONDS;
  const count = Math.max(MIN_SEGMENTS, Math.min(MAX_SEGMENTS, Math.floor(duration / SEGMENT_SECONDS)));
  const step = duration / count;
  const segments: MockTranscriptSegment[] = [];
  for (let i = 0; i < count; i++) {
    const startSec = Math.round(i * step * 100) / 100;
    const endSec = i === count - 1 ? Math.round(duration * 100) / 100 : Math.round((i + 1) * step * 100) / 100;
    segments.push({
      id: i,
      text: i === 0 ? `Simulated narration for automated testing. ${sentenceFor(i)}` : sentenceFor(i),
      startSec,
      endSec,
    });
  }
  return segments;
}
