// EP-TRAIN-4Y-S §9 — round-trip contract: materialiser's canonical
// body + sha256 must equal the evidence-reader's recompute from the
// stored projection fields. Freezes the fix behind a fast unit test
// so the mismatch can never silently reappear.

import { describe, it, expect } from "vitest";
import {
  buildCanonicalProjectionBody,
  normaliseCanonicalPassage,
  projectionSha256,
} from "../src/lib/hr/training/ai-review/grounding-canonical";

const SAMPLE_INPUT = {
  tenantId: "cmrvdeny7000144372ktmmg9c",
  courseVersionId: "cmvzs3w05000456qcgfgps7gy",
  sourceVideoSha256: "d1ddb823437c78478c5f2388b5daa42c957a8706afcce871bd6a522801efee29",
  resolvedTranscriptBuildId: "a".repeat(64),
  passages: [
    {
      passageId: 4,
      sourceSegmentIds: [4] as const,
      sourceStartSec: 20.5,
      sourceEndSec: 28.75,
      text: "Pay stubs are accessed via the SIN last-four portal.",
      citationHandle: "seg-4",
      flags: {
        pendingReview: [] as string[],
        sourceOrgMismatch: [] as string[],
        uncertaintyWarning: null as string | null,
      },
    },
  ],
  excludedPassages: [] as Array<{
    passageId: number;
    sourceSegmentIds: readonly number[];
    reason?: unknown;
  }>,
};

describe("EP-TRAIN-4Y-S §9 canonical projection body round-trip", () => {
  it("writer sha256 == reader sha256 for a representative passage", () => {
    const body = buildCanonicalProjectionBody(SAMPLE_INPUT);
    const writerSha = projectionSha256(body);

    // Simulate the reader's path: stored passages come back as parsed
    // JSON (lossy with respect to `flags` defaults). The reader
    // normalises on read via the same helper and must land on the
    // same sha256.
    const stored = JSON.parse(JSON.stringify(body.passages));
    const readerBody = buildCanonicalProjectionBody({
      ...SAMPLE_INPUT,
      passages: stored,
    });
    const readerSha = projectionSha256(readerBody);

    expect(readerSha).toBe(writerSha);
  });

  it("flags defaults applied on read match writer-emitted defaults", () => {
    // Passage stored WITHOUT flags at all (legacy historical row) —
    // the reader's normalisation fills them in. Must match a passage
    // the writer emits with the explicit default.
    const withExplicitDefaults = normaliseCanonicalPassage({
      passageId: 1,
      sourceSegmentIds: [1],
      sourceStartSec: 0,
      sourceEndSec: 1,
      text: "x",
      citationHandle: "seg-1",
      flags: { pendingReview: [], sourceOrgMismatch: [], uncertaintyWarning: null },
    });
    const withoutFlags = normaliseCanonicalPassage({
      passageId: 1,
      sourceSegmentIds: [1],
      sourceStartSec: 0,
      sourceEndSec: 1,
      text: "x",
      citationHandle: "seg-1",
    });
    expect(JSON.stringify(withExplicitDefaults)).toBe(JSON.stringify(withoutFlags));
  });

  it("sha256 is stable across key-order changes in the input object", () => {
    const body1 = buildCanonicalProjectionBody({
      tenantId: "t",
      courseVersionId: "v",
      sourceVideoSha256: "sv",
      resolvedTranscriptBuildId: "rb",
      passages: [],
      excludedPassages: [],
    });
    // Reconstruct with a different key-insertion order on the input
    // object; the canonical body's key order is fixed by the helper,
    // so the sha256 is identical.
    const body2 = buildCanonicalProjectionBody({
      excludedPassages: [],
      passages: [],
      resolvedTranscriptBuildId: "rb",
      sourceVideoSha256: "sv",
      courseVersionId: "v",
      tenantId: "t",
    });
    expect(projectionSha256(body1)).toBe(projectionSha256(body2));
  });

  it("any field change in the canonical body changes the sha256", () => {
    const base = buildCanonicalProjectionBody({
      tenantId: "t",
      courseVersionId: "v",
      sourceVideoSha256: "sv",
      resolvedTranscriptBuildId: "rb",
      passages: [],
      excludedPassages: [],
    });
    const altered = buildCanonicalProjectionBody({
      tenantId: "t",
      courseVersionId: "DIFFERENT",
      sourceVideoSha256: "sv",
      resolvedTranscriptBuildId: "rb",
      passages: [],
      excludedPassages: [],
    });
    expect(projectionSha256(altered)).not.toBe(projectionSha256(base));
  });
});
