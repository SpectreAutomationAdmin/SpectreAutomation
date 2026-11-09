// EP-TRAIN-4Y-AA §5 — destination resolver unit tests.
//
// Uses the shortfallReasonJson shape actually persisted on staging
// by run cmw9rrl1g000rj41xaoxvzqbb (5 cg-* dedup entries, 0 final).

import { describe, expect, it } from "vitest";
import {
  annotateDraftsWithDestination,
  destinationKindForGroup,
  parseShortfallGroupMap,
} from "@/lib/hr/training/generation/destination-resolver";

describe("destinationKindForGroup", () => {
  it("maps 'final' to FINAL_ASSESSMENT", () => {
    expect(destinationKindForGroup("final")).toBe("FINAL_ASSESSMENT");
  });
  it("maps cg-* to CHECKPOINT", () => {
    expect(destinationKindForGroup("cg-1")).toBe("CHECKPOINT");
    expect(destinationKindForGroup("cg-42")).toBe("CHECKPOINT");
  });
  it("maps any other non-'final' group id to CHECKPOINT", () => {
    expect(destinationKindForGroup("ck-cuidxyz")).toBe("CHECKPOINT");
  });
  it("maps null / undefined / '' to UNKNOWN", () => {
    expect(destinationKindForGroup(null)).toBe("UNKNOWN");
    expect(destinationKindForGroup(undefined)).toBe("UNKNOWN");
    expect(destinationKindForGroup("")).toBe("UNKNOWN");
  });
});

describe("parseShortfallGroupMap", () => {
  it("returns empty on null / undefined / invalid JSON", () => {
    expect(parseShortfallGroupMap(null).size).toBe(0);
    expect(parseShortfallGroupMap(undefined).size).toBe(0);
    expect(parseShortfallGroupMap("{broken-json").size).toBe(0);
    expect(parseShortfallGroupMap("null").size).toBe(0);
    expect(parseShortfallGroupMap('"string"').size).toBe(0);
  });

  it("returns empty when dedupDecisions is absent / not an array", () => {
    expect(parseShortfallGroupMap("{}").size).toBe(0);
    expect(
      parseShortfallGroupMap(JSON.stringify({ dedupDecisions: "nope" })).size,
    ).toBe(0);
  });

  it("only keeps kept:true entries", () => {
    const sfj = JSON.stringify({
      schemaVersion: "shortfall-v1",
      dedupDecisions: [
        { group: "cg-1", candidateContentHash: "aaa", kept: true },
        { group: "cg-2", candidateContentHash: "bbb", kept: false },
        { group: "final", candidateContentHash: "ccc", kept: true },
      ],
    });
    const m = parseShortfallGroupMap(sfj);
    expect(m.size).toBe(2);
    expect(m.get("aaa")).toBe("cg-1");
    expect(m.get("ccc")).toBe("final");
    expect(m.get("bbb")).toBeUndefined();
  });

  it("skips rows with non-string group / non-string candidateContentHash", () => {
    const sfj = JSON.stringify({
      dedupDecisions: [
        { group: null, candidateContentHash: "x", kept: true },
        { group: "cg-1", candidateContentHash: 42, kept: true },
        { group: "cg-2", candidateContentHash: "y", kept: true },
      ],
    });
    const m = parseShortfallGroupMap(sfj);
    expect(m.size).toBe(1);
    expect(m.get("y")).toBe("cg-2");
  });
});

describe("annotateDraftsWithDestination", () => {
  // Reproduces the 4Y-Z pilot's live shape: 5 checkpoint drafts
  // (cg-1..cg-5, each kept) and zero final entries.
  const PILOT_SHORTFALL = JSON.stringify({
    schemaVersion: "shortfall-v1",
    targetCount: 15,
    generatedCount: 5,
    shortfall: 10,
    dedupRulesVersion: "dedup-v2",
    dedupDecisions: [
      { group: "cg-1", candidateContentHash: "4b8ac1b6b83d7be876b92b879e8795216e1958363fd19c79565bced34bbcb9e4", kept: true, decision: { verdict: "DISTINCT" } },
      { group: "cg-2", candidateContentHash: "098c9334a5b771f93e4e6fd630e2cc2645a7afcbe8ed69f8bfce3e4023b64835", kept: true, decision: { verdict: "DISTINCT" } },
      { group: "cg-3", candidateContentHash: "a93d8f16394ebb8e240c2076b75e078f3d424238b5087e8d70aef948b86b96d1", kept: true, decision: { verdict: "DISTINCT" } },
      { group: "cg-4", candidateContentHash: "849c616cd71ad083c2c597e63dd6e6ce1eead541f2b67432b0fc997766db916c", kept: true, decision: { verdict: "DISTINCT" } },
      { group: "cg-5", candidateContentHash: "f6aef0168adcb669c625fcc73cde9eeac6a422690011b0a42be7362de1cda414", kept: true, decision: { verdict: "DISTINCT" } },
    ],
    reason: "model returned fewer grounded candidates than target",
  });

  it("classifies all 5 pilot drafts as CHECKPOINT from the real shortfall JSON", () => {
    const drafts = [
      { id: "d1", contentHash: "4b8ac1b6b83d7be876b92b879e8795216e1958363fd19c79565bced34bbcb9e4" },
      { id: "d2", contentHash: "098c9334a5b771f93e4e6fd630e2cc2645a7afcbe8ed69f8bfce3e4023b64835" },
      { id: "d3", contentHash: "a93d8f16394ebb8e240c2076b75e078f3d424238b5087e8d70aef948b86b96d1" },
      { id: "d4", contentHash: "849c616cd71ad083c2c597e63dd6e6ce1eead541f2b67432b0fc997766db916c" },
      { id: "d5", contentHash: "f6aef0168adcb669c625fcc73cde9eeac6a422690011b0a42be7362de1cda414" },
    ];
    const annotated = annotateDraftsWithDestination({
      drafts,
      shortfallReasonJson: PILOT_SHORTFALL,
    });
    expect(annotated).toHaveLength(5);
    const kinds = annotated.map((a) => a.destination);
    expect(kinds.every((k) => k === "CHECKPOINT")).toBe(true);
    const groups = annotated.map((a) => a.planGroupKey);
    expect(groups).toEqual(["cg-1", "cg-2", "cg-3", "cg-4", "cg-5"]);
  });

  it("classifies a draft matching 'final' as FINAL_ASSESSMENT", () => {
    const sfj = JSON.stringify({
      dedupDecisions: [
        { group: "final", candidateContentHash: "aaa", kept: true },
      ],
    });
    const annotated = annotateDraftsWithDestination({
      drafts: [{ id: "d1", contentHash: "aaa" }],
      shortfallReasonJson: sfj,
    });
    expect(annotated[0].destination).toBe("FINAL_ASSESSMENT");
    expect(annotated[0].planGroupKey).toBe("final");
  });

  it("marks drafts without a dedup entry as UNKNOWN", () => {
    const annotated = annotateDraftsWithDestination({
      drafts: [
        { id: "d1", contentHash: "orphan-hash-1" },
      ],
      shortfallReasonJson: PILOT_SHORTFALL,
    });
    expect(annotated[0].destination).toBe("UNKNOWN");
    expect(annotated[0].planGroupKey).toBeNull();
  });

  it("returns every draft as UNKNOWN when shortfallReasonJson is null", () => {
    const annotated = annotateDraftsWithDestination({
      drafts: [{ id: "d1", contentHash: "x" }],
      shortfallReasonJson: null,
    });
    expect(annotated[0].destination).toBe("UNKNOWN");
  });

  it("filters correctly when consumer slices by destination", () => {
    const sfj = JSON.stringify({
      dedupDecisions: [
        { group: "cg-1", candidateContentHash: "cp1", kept: true },
        { group: "cg-2", candidateContentHash: "cp2", kept: true },
        { group: "final", candidateContentHash: "fa1", kept: true },
        { group: "final", candidateContentHash: "fa2", kept: true },
      ],
    });
    const drafts = [
      { id: "d1", contentHash: "cp1" },
      { id: "d2", contentHash: "fa1" },
      { id: "d3", contentHash: "cp2" },
      { id: "d4", contentHash: "fa2" },
    ];
    const annotated = annotateDraftsWithDestination({ drafts, shortfallReasonJson: sfj });
    const cps = annotated.filter((a) => a.destination === "CHECKPOINT");
    const fas = annotated.filter((a) => a.destination === "FINAL_ASSESSMENT");
    expect(cps.map((a) => a.draft.id)).toEqual(["d1", "d3"]);
    expect(fas.map((a) => a.draft.id)).toEqual(["d2", "d4"]);
  });
});
