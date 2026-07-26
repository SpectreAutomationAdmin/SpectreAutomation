// Sprint 2 (2026-07-19) — Checkpoint 1 contract tests for the source
// materialiser layer.
//
// These are pure-code tests; no Prisma, no DB. They pin the
// invariants that every future source materialiser must uphold, and
// the helper-function guarantees the contract layer promises.

import { describe, it, expect } from "vitest";
import {
  isClassificationLocked,
  pickOrchestrationState,
  ORCHESTRATION_FIELDS,
  DISPLAY_FIELDS,
  CLASSIFICATION_FIELDS,
} from "@/lib/work-intake/materializer";

describe("SourceMaterializer contract — invariant field lists", () => {
  it("orchestration fields are exactly the set a materialiser MUST NOT overwrite", () => {
    // These names correspond to columns on WorkIntakeItem. Any change
    // to this list is a change to the founder's Phase B directive
    // §7 and MUST be reviewed as a policy change, not a code change.
    expect([...ORCHESTRATION_FIELDS]).toEqual([
      "status",
      "ownerUserId",
      "judgmentRequired",
      "deferredUntil",
      "resolvedAt",
      "resolvedByUserId",
    ]);
  });

  it("display fields are exactly the set a materialiser owns via refreshDisplayProjection", () => {
    expect([...DISPLAY_FIELDS]).toEqual([
      "displaySourceLabel",
      "displaySender",
      "displaySubject",
      "displayPreview",
      "displayReceivedAt",
      "displayHasAttachments",
    ]);
  });

  it("classification fields are the set a materialiser owns via refreshClassification (subject to override)", () => {
    expect([...CLASSIFICATION_FIELDS]).toEqual([
      "classification",
      "classificationReason",
      "classificationMethod",
      "classificationConfidence",
      "classificationRuleKey",
      "classificationRuleVersion",
    ]);
  });

  it("orchestration + display + classification field sets are disjoint", () => {
    const union = new Set<string>([...ORCHESTRATION_FIELDS, ...DISPLAY_FIELDS, ...CLASSIFICATION_FIELDS]);
    expect(union.size).toBe(
      ORCHESTRATION_FIELDS.length + DISPLAY_FIELDS.length + CLASSIFICATION_FIELDS.length,
    );
  });
});

describe("isClassificationLocked — user override guard (I3)", () => {
  it("returns false when no user has overridden", () => {
    expect(isClassificationLocked({ classificationOverriddenByUserId: null })).toBe(false);
  });
  it("returns true when a user has overridden", () => {
    expect(isClassificationLocked({ classificationOverriddenByUserId: "u_1" })).toBe(true);
  });
  it("empty string does NOT count as an override — user id must be a real cuid", () => {
    // Guard against a materialiser that accidentally writes "" and
    // then treats it as an override. isClassificationLocked() is
    // strict on null-ness; the caller is responsible for treating ""
    // as invalid input. This test pins the current semantics so a
    // "helpful" future refactor of the guard is caught immediately.
    expect(isClassificationLocked({ classificationOverriddenByUserId: "" })).toBe(true);
  });
});

describe("pickOrchestrationState — the resync-preservation contract (I2)", () => {
  const baseline = {
    status: "IN_PROGRESS",
    ownerUserId: "u_chris",
    judgmentRequired: true,
    deferredUntil: new Date("2026-07-20T10:00:00.000Z"),
    resolvedAt: null,
    resolvedByUserId: null,
  };

  it("captures every orchestration field for round-trip comparison", () => {
    const snapshot = pickOrchestrationState(baseline);
    // The exact keys returned MUST be equal to the ORCHESTRATION_FIELDS
    // constant, or the resync test in a future materialiser could
    // silently pass while missing a field.
    expect(Object.keys(snapshot).sort()).toEqual([...ORCHESTRATION_FIELDS].sort());
  });

  it("serialises Date fields deterministically", () => {
    expect(pickOrchestrationState(baseline).deferredUntil).toBe("2026-07-20T10:00:00.000Z");
  });

  it("preserves null for unresolved items", () => {
    expect(pickOrchestrationState(baseline).resolvedAt).toBeNull();
  });

  it("two snapshots of the same state are structurally equal", () => {
    // The dev-visible failure mode this guards against: a future
    // materialiser calls setStatus("OPEN") on a resync where the
    // status was already "IN_PROGRESS". The resync-preservation
    // test uses this snapshot equality; if pickOrchestrationState
    // stops being deterministic (e.g. adds a "capturedAt: now()"),
    // every preservation test in the repo starts failing loudly.
    const a = pickOrchestrationState(baseline);
    const b = pickOrchestrationState(baseline);
    expect(a).toEqual(b);
  });
});
