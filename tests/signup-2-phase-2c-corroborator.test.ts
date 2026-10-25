// SIGNUP-2 Phase 2C (2026-10-25) -- Authority corroborator tests.
//
// Direct unit tests of the pure corroborator function.  The matrix
// pins the founder-amended rule:
//
//   "A PASS_AUTOMATED outcome must require sufficient independently
//    verifiable evidence for BOTH organization standing AND signing
//    authority.  If such evidence is unavailable, use manual review."
//
// Phase 2C baseline: the only Phase 2C signing-authority evidence
// class is OFFICER_MATCH (and the only path to it is a live adapter
// returning officerMatch === "MATCHED").  Because Phase 2C ships NO
// live adapter, PASS_AUTOMATED is unreachable in prod/staging today
// -- only achievable in fixture mode once an operator or future
// slice enables live adapters.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  corroborateAuthority,
  type CorroboratorInputs,
} from "@/lib/signup/authority-corroborator";

const ROOT = process.cwd();
const CORROBORATOR = readFileSync(join(ROOT, "src/lib/signup/authority-corroborator.ts"), "utf8");

function base(): CorroboratorInputs {
  return {
    classifier: "AUTOMATED_PASSED",
    standing: "ACTIVE",
    officerMatch: null,
    standingFromLiveAdapter: false,
    impersonationFlag: false,
  };
}

describe("SIGNUP-2 Phase 2C · corroborator source invariants", () => {
  it("is a pure function -- no imports from prisma / logger / audit", () => {
    expect(CORROBORATOR).not.toMatch(/from "@\/lib\/prisma"/);
    expect(CORROBORATOR).not.toMatch(/from "@\/lib\/audit"/);
    expect(CORROBORATOR).not.toMatch(/from "@\/lib\/observability\/logger"/);
  });

  it("exports the five HoldCategory values the founder named in §2", () => {
    expect(CORROBORATOR).toMatch(/"ENTITY_VERIFICATION"/);
    expect(CORROBORATOR).toMatch(/"SIGNING_AUTHORITY_VERIFICATION"/);
    expect(CORROBORATOR).toMatch(/"CONFLICTING_EVIDENCE"/);
    expect(CORROBORATOR).toMatch(/"INSUFFICIENT_EVIDENCE"/);
    expect(CORROBORATOR).toMatch(/"SUSPECTED_IMPERSONATION"/);
  });

  it("has three documented Verdict outcomes", () => {
    expect(CORROBORATOR).toMatch(/"PASS_AUTOMATED"\s*\|\s*"HOLD_FOR_REVIEW"\s*\|\s*"REJECT"/);
  });

  it("separates the signing-authority dimension explicitly", () => {
    expect(CORROBORATOR).toMatch(/signingAuthoritySignal:\s*SigningAuthoritySignal/);
    expect(CORROBORATOR).toMatch(/"OFFICER_MATCH"/);
    expect(CORROBORATOR).toMatch(/"NONE"/);
  });
});

describe("SIGNUP-2 Phase 2C · REJECT branches", () => {
  it("impersonation flag short-circuits to REJECT regardless of other signals", () => {
    const v = corroborateAuthority({
      ...base(),
      impersonationFlag: true,
      classifier: "AUTOMATED_PASSED",
      standing: "ACTIVE",
      officerMatch: "MATCHED",
      standingFromLiveAdapter: true,
    });
    expect(v.verdict).toBe("REJECT");
    expect(v.holdCategory).toBe("SUSPECTED_IMPERSONATION");
  });

  it("standing NOT_ACTIVE is a hard REJECT", () => {
    const v = corroborateAuthority({ ...base(), standing: "NOT_ACTIVE" });
    expect(v.verdict).toBe("REJECT");
    expect(v.rationale).toContain("not-active");
  });

  it("standing NOT_FOUND is a hard REJECT", () => {
    const v = corroborateAuthority({ ...base(), standing: "NOT_FOUND" });
    expect(v.verdict).toBe("REJECT");
    expect(v.rationale).toContain("not-found");
  });
});

describe("SIGNUP-2 Phase 2C · classifier ESCALATED routes to HOLD", () => {
  it("ESCALATED + any standing → HOLD_FOR_REVIEW:ENTITY_VERIFICATION", () => {
    const v = corroborateAuthority({
      ...base(),
      classifier: "ESCALATED",
      standing: "ACTIVE",
      standingFromLiveAdapter: true,
    });
    expect(v.verdict).toBe("HOLD_FOR_REVIEW");
    expect(v.holdCategory).toBe("ENTITY_VERIFICATION");
  });
});

describe("SIGNUP-2 Phase 2C · non-live standing routes to HOLD even when ACTIVE", () => {
  it("stub/fixture ACTIVE+MATCHED is NOT enough for PASS_AUTOMATED (the §2 amendment)", () => {
    const v = corroborateAuthority({
      ...base(),
      classifier: "AUTOMATED_PASSED",
      standing: "ACTIVE",
      officerMatch: "MATCHED",
      standingFromLiveAdapter: false, // critical: not from a live adapter
    });
    expect(v.verdict).toBe("HOLD_FOR_REVIEW");
    expect(v.holdCategory).toBe("ENTITY_VERIFICATION");
    expect(v.rationale).toContain("standing-not-from-live-adapter");
  });

  it("the signing-authority signal is still recorded even on non-live-adapter HOLD", () => {
    const v = corroborateAuthority({
      ...base(),
      standing: "ACTIVE",
      officerMatch: "MATCHED",
      standingFromLiveAdapter: false,
    });
    expect(v.signingAuthoritySignal).toBe("OFFICER_MATCH");
  });
});

describe("SIGNUP-2 Phase 2C · MANUAL_REVIEW_REQUIRED standing routes to HOLD", () => {
  it("adapter asked for manual review even with isLive=true", () => {
    const v = corroborateAuthority({
      ...base(),
      standing: "MANUAL_REVIEW_REQUIRED",
      standingFromLiveAdapter: true,
    });
    expect(v.verdict).toBe("HOLD_FOR_REVIEW");
    expect(v.holdCategory).toBe("ENTITY_VERIFICATION");
  });
});

describe("SIGNUP-2 Phase 2C · conflicting-evidence branch", () => {
  it("classifier NEEDS_MANUAL_REVIEW + standing ACTIVE from live adapter → CONFLICTING_EVIDENCE", () => {
    const v = corroborateAuthority({
      ...base(),
      classifier: "NEEDS_MANUAL_REVIEW",
      standing: "ACTIVE",
      standingFromLiveAdapter: true,
    });
    expect(v.verdict).toBe("HOLD_FOR_REVIEW");
    expect(v.holdCategory).toBe("CONFLICTING_EVIDENCE");
  });
});

describe("SIGNUP-2 Phase 2C · signing-authority-verification branch", () => {
  it("classifier AUTOMATED_PASSED + standing ACTIVE + live adapter + NO officer match → SIGNING_AUTHORITY_VERIFICATION", () => {
    const v = corroborateAuthority({
      ...base(),
      classifier: "AUTOMATED_PASSED",
      standing: "ACTIVE",
      standingFromLiveAdapter: true,
      officerMatch: null,
    });
    expect(v.verdict).toBe("HOLD_FOR_REVIEW");
    expect(v.holdCategory).toBe("SIGNING_AUTHORITY_VERIFICATION");
    expect(v.signingAuthoritySignal).toBe("NONE");
  });

  it("officer match PARTIAL does NOT count as independent corroboration", () => {
    const v = corroborateAuthority({
      ...base(),
      classifier: "AUTOMATED_PASSED",
      standing: "ACTIVE",
      standingFromLiveAdapter: true,
      officerMatch: "PARTIAL",
    });
    expect(v.verdict).toBe("HOLD_FOR_REVIEW");
    expect(v.holdCategory).toBe("SIGNING_AUTHORITY_VERIFICATION");
  });

  it("officer match NOT_MATCHED does NOT count as independent corroboration", () => {
    const v = corroborateAuthority({
      ...base(),
      classifier: "AUTOMATED_PASSED",
      standing: "ACTIVE",
      standingFromLiveAdapter: true,
      officerMatch: "NOT_MATCHED",
    });
    expect(v.verdict).toBe("HOLD_FOR_REVIEW");
    expect(v.holdCategory).toBe("SIGNING_AUTHORITY_VERIFICATION");
  });
});

describe("SIGNUP-2 Phase 2C · THE ONLY PASS_AUTOMATED PATH", () => {
  it("classifier AUTOMATED_PASSED + standing ACTIVE + live adapter + officer MATCHED → PASS_AUTOMATED", () => {
    const v = corroborateAuthority({
      ...base(),
      classifier: "AUTOMATED_PASSED",
      standing: "ACTIVE",
      standingFromLiveAdapter: true,
      officerMatch: "MATCHED",
    });
    expect(v.verdict).toBe("PASS_AUTOMATED");
    expect(v.holdCategory).toBe(null);
    expect(v.signingAuthoritySignal).toBe("OFFICER_MATCH");
  });

  it("classifier OVERRIDDEN + rest of PASS preconditions → PASS_AUTOMATED (the override reason is captured elsewhere)", () => {
    const v = corroborateAuthority({
      ...base(),
      classifier: "OVERRIDDEN",
      standing: "ACTIVE",
      standingFromLiveAdapter: true,
      officerMatch: "MATCHED",
    });
    expect(v.verdict).toBe("PASS_AUTOMATED");
  });
});

describe("SIGNUP-2 Phase 2C · catch-all defaults to INSUFFICIENT_EVIDENCE hold", () => {
  it("NOT_STARTED classifier → HOLD:INSUFFICIENT_EVIDENCE (never silently pass)", () => {
    const v = corroborateAuthority({
      ...base(),
      classifier: "NOT_STARTED",
      standing: "ACTIVE",
      standingFromLiveAdapter: true,
    });
    expect(v.verdict).toBe("HOLD_FOR_REVIEW");
    expect(v.holdCategory).toBe("INSUFFICIENT_EVIDENCE");
  });
});
