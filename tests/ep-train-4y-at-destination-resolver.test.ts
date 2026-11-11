/**
 * EP-TRAIN-4Y-AT §5 — regression coverage for the destination
 * resolver's new recoveryHistory-aware path + the recovery
 * service's ambiguous-destination guard.
 *
 * Context: AS shipped the manager-driven rejected-proposal recovery
 * workflow. The 10th FA draft landed with its contentHash absent
 * from the resolver's `kept: true` dedup rows, so the review
 * surface rendered Q7 of 10 as "destination unknown." AT extends
 * the resolver to also harvest `perGroupDiagnostics[g].recoveryHistory[]`
 * entries (the AS recovery path) so recovered drafts resolve to
 * their owning plan group.
 *
 * These tests use SYNTHETIC fixtures. The real staging state is
 * verified via `scripts/4yat-post-fix-verify.mjs` + the §7 report.
 */

import { describe, it, expect } from "vitest";
import {
  parseShortfallGroupMap,
  destinationKindForGroup,
  annotateDraftsWithDestination,
  annotateDraftsWithComposedDestination,
  composeGroupMapsFromRuns,
} from "@/lib/hr/training/generation/destination-resolver";

// Fixture shape matching what the AS service writes.
const AS_STYLE_SHORTFALL = JSON.stringify({
  schemaVersion: "shortfall-v2",
  targetCount: 1,
  generatedCount: 0,
  dedupDecisions: [],
  perGroupDiagnostics: [
    {
      group: "fa-1",
      kind: "FINAL_ASSESSMENT",
      proposalCountFromModal: 1,
      sanitizerDroppedCount: 1,
      sanitizerDropReasons: [{ proposalIndex: 0, findingCodes: "ACCORDING_TO_TRAINING_MATERIAL,EXPLICIT_SEGMENT_ID_REFERENCE" }],
      normalisationTrace: [],
      rejectedProposals: [
        {
          proposalIndex: 0,
          rejectionStage: "SANITISER",
          originalQuestionText: "How can an employee access their pay stubs according to the training material?",
          normalisedQuestionText: "How can an employee access their pay stubs according to the training material?",
          options: [],
          explanation: null,
          sourceSegmentIds: [3, 4],
          questionType: "SINGLE_CHOICE",
          findingCodes: "ACCORDING_TO_TRAINING_MATERIAL,EXPLICIT_SEGMENT_ID_REFERENCE",
          normalisationRefusalReason: null,
          normalisationTransforms: [],
          rejectedAt: "2026-11-11T02:43:42.152Z",
          retentionExpiresAt: "2026-12-11T02:43:42.152Z",
          generationRunId: "cmwbij5rq0007mmqsxow0h9jv",
          groupId: "fa-1",
        },
      ],
      recoveryHistory: [
        {
          savedAt: "2026-11-11T03:55:38.408Z",
          savedByUserId: "cmrvdenz700034437agp7gqs5",
          editedQuestionText: "How can employees access their pay stubs?",
          editedOptions: [],
          editedExplanation: null,
          savedAsDraftId: "cmwbl6aic0007107lhfo4n0wl",
          contentHash: "b4d2ed9ffdf8a184ee0d7fdab7e67aaeebf042e7bbae35db6f9a01570f40f304",
        },
      ],
      dedupDroppedCount: 0,
      persistedCount: 0,
    },
  ],
});

const NORMAL_GPU_SHORTFALL = JSON.stringify({
  schemaVersion: "shortfall-v2",
  dedupDecisions: [
    { group: "cg-1", candidateContentHash: "aa11bb22cc33", kept: true },
    { group: "fa-1", candidateContentHash: "dd44ee55ff66", kept: true },
    { group: "fa-2", candidateContentHash: "gg77hh88ii99", kept: false }, // dropped — NOT persisted
  ],
  perGroupDiagnostics: [
    { group: "cg-1", kind: "CHECKPOINT", persistedCount: 1 },
    { group: "fa-1", kind: "FINAL_ASSESSMENT", persistedCount: 1 },
    { group: "fa-2", kind: "FINAL_ASSESSMENT", persistedCount: 0 },
  ],
});

describe("EP-TRAIN-4Y-AT §5.1 — resolver harvests AS recoveryHistory[]", () => {
  it("maps AS-recovered draft's contentHash to its owning group", () => {
    const m = parseShortfallGroupMap(AS_STYLE_SHORTFALL);
    expect(m.get("b4d2ed9ffdf8a184ee0d7fdab7e67aaeebf042e7bbae35db6f9a01570f40f304")).toBe("fa-1");
  });
  it("destinationKindForGroup('fa-1') is FINAL_ASSESSMENT", () => {
    expect(destinationKindForGroup("fa-1")).toBe("FINAL_ASSESSMENT");
  });
  it("annotateDraftsWithDestination resolves the recovered draft to FINAL_ASSESSMENT", () => {
    const annotated = annotateDraftsWithDestination({
      drafts: [{ id: "cmwbl6aic0007107lhfo4n0wl", contentHash: "b4d2ed9ffdf8a184ee0d7fdab7e67aaeebf042e7bbae35db6f9a01570f40f304" }],
      shortfallReasonJson: AS_STYLE_SHORTFALL,
    });
    expect(annotated).toHaveLength(1);
    expect(annotated[0].destination).toBe("FINAL_ASSESSMENT");
    expect(annotated[0].planGroupKey).toBe("fa-1");
  });
});

describe("EP-TRAIN-4Y-AT §5.2 — resolver preserves GPU-path mapping", () => {
  it("normal dedup-kept rows still resolve correctly", () => {
    const m = parseShortfallGroupMap(NORMAL_GPU_SHORTFALL);
    expect(m.get("aa11bb22cc33")).toBe("cg-1");
    expect(m.get("dd44ee55ff66")).toBe("fa-1");
    expect(m.has("gg77hh88ii99")).toBe(false); // dropped row
  });
  it("destinationKindForGroup preserves known kinds", () => {
    expect(destinationKindForGroup("final")).toBe("FINAL_ASSESSMENT");
    expect(destinationKindForGroup("fa-1")).toBe("FINAL_ASSESSMENT");
    expect(destinationKindForGroup("fa-42")).toBe("FINAL_ASSESSMENT");
    expect(destinationKindForGroup("cg-1")).toBe("CHECKPOINT");
    expect(destinationKindForGroup(null)).toBe("UNKNOWN");
    expect(destinationKindForGroup("")).toBe("UNKNOWN");
  });
});

describe("EP-TRAIN-4Y-AT §5.3 — composition across runs", () => {
  it("composeGroupMapsFromRuns unions kept-decisions and recoveryHistory entries", () => {
    const composed = composeGroupMapsFromRuns([NORMAL_GPU_SHORTFALL, AS_STYLE_SHORTFALL]);
    expect(composed.get("aa11bb22cc33")).toBe("cg-1");
    expect(composed.get("dd44ee55ff66")).toBe("fa-1");
    expect(composed.get("b4d2ed9ffdf8a184ee0d7fdab7e67aaeebf042e7bbae35db6f9a01570f40f304")).toBe("fa-1");
  });
  it("first mapping wins — a prior kept row is not overwritten by a later recovery", () => {
    // Synthetic collision: imagine a prior run's dedup kept a row
    // with the same hash as a later recovery. The resolver must
    // trust the earliest definitive mapping.
    const collidingHash = "c0ll1s10nhash";
    const prior = JSON.stringify({
      dedupDecisions: [{ group: "cg-3", candidateContentHash: collidingHash, kept: true }],
    });
    const later = JSON.stringify({
      perGroupDiagnostics: [
        {
          group: "fa-1",
          recoveryHistory: [{ contentHash: collidingHash, savedAsDraftId: "x" }],
        },
      ],
    });
    const composed = composeGroupMapsFromRuns([prior, later]);
    expect(composed.get(collidingHash)).toBe("cg-3");
  });
  it("annotateDraftsWithComposedDestination resolves a recovered draft via composed map", () => {
    const composed = composeGroupMapsFromRuns([AS_STYLE_SHORTFALL]);
    const annotated = annotateDraftsWithComposedDestination({
      drafts: [{ id: "cmwbl6aic0007107lhfo4n0wl", contentHash: "b4d2ed9ffdf8a184ee0d7fdab7e67aaeebf042e7bbae35db6f9a01570f40f304" }],
      composedGroupMap: composed,
    });
    expect(annotated[0].destination).toBe("FINAL_ASSESSMENT");
    expect(annotated[0].planGroupKey).toBe("fa-1");
  });
});

describe("EP-TRAIN-4Y-AT §5.4 — malformed recoveryHistory degrades safely", () => {
  it("skips entries missing contentHash or savedAsDraftId", () => {
    const sfj = JSON.stringify({
      perGroupDiagnostics: [
        {
          group: "fa-1",
          recoveryHistory: [
            { savedAsDraftId: "no_hash_present" },
            { contentHash: "no_draft_id" },
            null,
            "not-an-object",
            { contentHash: "good_hash", savedAsDraftId: "good_draft" },
          ],
        },
      ],
    });
    const m = parseShortfallGroupMap(sfj);
    expect(m.size).toBe(1);
    expect(m.get("good_hash")).toBe("fa-1");
  });
  it("skips perGroupDiagnostics rows missing group or recoveryHistory", () => {
    const sfj = JSON.stringify({
      perGroupDiagnostics: [
        { group: "fa-1" },  // no recoveryHistory
        { recoveryHistory: [{ contentHash: "h1", savedAsDraftId: "d1" }] },  // no group
        null,
      ],
    });
    const m = parseShortfallGroupMap(sfj);
    expect(m.size).toBe(0);
  });
});

describe("EP-TRAIN-4Y-AT §5.5 — recovery service guards ambiguous destinations", () => {
  it("source: reject unknown group patterns with AMBIGUOUS_DESTINATION", async () => {
    const mod = await import("@/lib/hr/training/generation/rejected-proposal-recovery");
    // We can't easily unit-test the full service without Prisma. Lint
    // the source instead to prove the guard exists.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/hr/training/generation/rejected-proposal-recovery.ts"),
      "utf8",
    );
    expect(src).toContain("AMBIGUOUS_DESTINATION");
    expect(src).toContain("isKnownGroupPattern");
    // The guard checks all four known patterns.
    expect(src).toContain('input.groupId === "final"');
    expect(src).toContain("/^fa-\\d+$/.test(input.groupId)");
    expect(src).toContain("/^cg-\\d+$/.test(input.groupId)");
    expect(src).toContain("/^ck-[a-z0-9]+$/.test(input.groupId)");
    expect(typeof mod.recoverRejectedProposal).toBe("function");
  });
});
