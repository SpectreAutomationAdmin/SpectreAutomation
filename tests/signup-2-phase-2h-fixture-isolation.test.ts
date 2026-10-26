// SIGNUP-2 Phase 2H (2026-10-26) -- Fixture harness isolation.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE = readFileSync(
  join(process.cwd(), "scripts/signup-2-phase-2b-staging-fixture.mjs"),
  "utf8",
);

describe("SIGNUP-2 Phase 2H · fixture harness surface", () => {
  it("declares PHASE_2H_FIXTURE_PREFIX", () => {
    expect(FIXTURE).toMatch(/const PHASE_2H_FIXTURE_PREFIX = "signup-2h-fixture-"/);
  });
  it("declares three scenarios: active, legacy, suspended-pending", () => {
    for (const s of ["active", "legacy", "suspended-pending"]) {
      expect(FIXTURE).toContain(`"${s}":`);
    }
  });
  it("exposes commands: phase2h-seed, phase2h-teardown, phase2h-inspect, phase2h-mark-reversal, phase2h-admin-fixture-setup/teardown", () => {
    for (const cmd of [
      "phase2h-seed",
      "phase2h-teardown",
      "phase2h-inspect",
      "phase2h-mark-reversal",
      "phase2h-admin-fixture-setup",
      "phase2h-admin-fixture-teardown",
    ]) {
      expect(FIXTURE).toContain(`"${cmd}"`);
    }
  });
  it("fixture Clubs carry stagingDataMode = SYNTHETIC_DEMO", () => {
    const body = FIXTURE.slice(FIXTURE.indexOf("async function phase2hSeed"));
    const end = body.indexOf("\nasync function phase2hTeardownScenario");
    const seed = end === -1 ? body : body.slice(0, end);
    expect(seed).toMatch(/stagingDataMode: "SYNTHETIC_DEMO"/);
  });
  it("fixture Clubs use the PHASE_2H_FIXTURE_PREFIX slug derivation", () => {
    const body = FIXTURE.slice(FIXTURE.indexOf("async function phase2hSeed"));
    const end = body.indexOf("\nasync function phase2hTeardownScenario");
    const seed = end === -1 ? body : body.slice(0, end);
    expect(seed).toMatch(/\$\{PHASE_2H_FIXTURE_PREFIX\}/);
  });
  it("teardown deletes TenantLifecycleTransition + ClubSubscription + Club in order", () => {
    const body = FIXTURE.slice(FIXTURE.indexOf("async function phase2hTeardownScenario"));
    const endIdx = body.indexOf("\nasync function phase2hTeardownAll");
    const td = endIdx === -1 ? body : body.slice(0, endIdx);
    expect(td).toMatch(/prisma\.tenantLifecycleTransition\.deleteMany/);
    expect(td).toMatch(/prisma\.clubSubscription\.deleteMany/);
    expect(td).toMatch(/prisma\.club\.deleteMany/);
  });
  it("admin fixture pair uses signup-2h-fixture-* emails", () => {
    // The two email constants are built from the PHASE_2H_FIXTURE_PREFIX
    // template string literal: `${PREFIX}operator@spectre.test` /
    // `${PREFIX}authoriser@spectre.test`.  Match on the suffix.
    expect(FIXTURE).toMatch(/\$\{PHASE_2H_FIXTURE_PREFIX\}operator@spectre\.test/);
    expect(FIXTURE).toMatch(/\$\{PHASE_2H_FIXTURE_PREFIX\}authoriser@spectre\.test/);
  });
  it("admin fixture teardown asserts zero remaining phase2h fixture users", () => {
    const body = FIXTURE.slice(FIXTURE.indexOf("async function phase2hAdminFixtureTeardown"));
    expect(body).toMatch(/remainingPhase2hFixtureUsers/);
  });
});
