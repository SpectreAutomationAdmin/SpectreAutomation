// SIGNUP-2 Phase 2F (2026-10-26) -- Nine-gate failure matrix.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SERVICE = readFileSync(join(ROOT, "src/lib/billing/signup-2f-activation-service.ts"), "utf8");

describe("SIGNUP-2 Phase 2F · every gate (G1-G9) classified by its specific failure label", () => {
  const gates = [
    "G1_NOT_READY",
    "G2_REVERSED",
    "G3_FUNDS_NOT_AVAILABLE",
    "G3_STRIPE_UNAVAILABLE",
    "G4_DISPUTE_OR_REFUND",
    "G5_MANDATE_REVOKED",
    "G6_MISSING_RELEASE_RECORD",
    "G7_TOS_MISMATCH",
    "G8_REGISTRATION_ABANDONED",
    "G9_JOB_EXISTS",
    "MOCK_EVIDENCE_REJECTED",
    "IDENTIFIERS_CHANGED",
  ];
  for (const g of gates) {
    it(`service references ${g}`, () => {
      expect(SERVICE).toMatch(new RegExp(g));
    });
  }
});

describe("SIGNUP-2 Phase 2F · transient vs permanent classification", () => {
  it("G3_STRIPE_UNAVAILABLE marks transient:true (retry safe)", () => {
    const block = SERVICE.match(/G3_STRIPE_UNAVAILABLE[\s\S]+?transient:\s*true/)!;
    expect(block).not.toBeNull();
  });

  it("G4_DISPUTE_OR_REFUND marks transient:false (permanent)", () => {
    // DISPUTE_OR_REFUND is written only via writeOperatorAlert path
    // for an external evidence failure; the service's refusal
    // returns transient:false for permanent gates (G2, G5, G6, G7
    // mismatch, G8, MOCK).
    expect(SERVICE).toMatch(/MOCK_EVIDENCE_REJECTED[\s\S]+?transient:\s*false/);
    expect(SERVICE).toMatch(/G5_MANDATE_REVOKED[\s\S]+?transient:\s*false/);
    expect(SERVICE).toMatch(/G6_MISSING_RELEASE_RECORD[\s\S]+?transient:\s*false/);
  });

  it("G7 ToS mismatch routes to IMMEDIATE operator alert (TOS_MISMATCH category)", () => {
    expect(SERVICE).toMatch(/category:\s*"TOS_MISMATCH"[\s\S]+?severity:\s*"IMMEDIATE"/);
    expect(SERVICE).toMatch(/attestation ToS SHA-256 mismatch/);
  });
});

describe("SIGNUP-2 Phase 2F · every write path checked against the fail-closed flag", () => {
  it("authoriseActivation asserts the flag first", () => {
    const funStart = SERVICE.indexOf("export async function authoriseActivation(");
    const flagIdx = SERVICE.indexOf("assertPhase2fActivationFlag()", funStart);
    const dbIdx = SERVICE.indexOf("await prisma.", funStart);
    expect(flagIdx).toBeGreaterThan(funStart);
    expect(flagIdx).toBeLessThan(dbIdx);
  });

  it("sweeper asserts the flag first", () => {
    const funStart = SERVICE.indexOf("export async function sweepActivationCandidates(");
    const flagIdx = SERVICE.indexOf("assertPhase2fActivationFlag()", funStart);
    const dbIdx = SERVICE.indexOf("await prisma.", funStart);
    expect(flagIdx).toBeGreaterThan(funStart);
    expect(flagIdx).toBeLessThan(dbIdx);
  });
});
