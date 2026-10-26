// SIGNUP-2 M1 (2026-10-26) -- Fixture isolation.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE = readFileSync(
  join(process.cwd(), "scripts/signup-2-phase-2b-staging-fixture.mjs"),
  "utf8",
);

describe("M1 · fixture surface", () => {
  it("declares M1_FIXTURE_PREFIX", () => {
    expect(FIXTURE).toMatch(/const M1_FIXTURE_PREFIX = "signup-2-m1-fixture-"/);
  });
  it("exposes m1-seed / m1-teardown / m1-inspect / m1-persist-webhook-event", () => {
    for (const cmd of ["m1-seed", "m1-teardown", "m1-inspect", "m1-persist-webhook-event"]) {
      expect(FIXTURE).toContain(`"${cmd}"`);
    }
  });
  it("fixture Club carries stagingDataMode=SYNTHETIC_DEMO", () => {
    const body = FIXTURE.slice(FIXTURE.indexOf("async function m1Seed"));
    const end = body.indexOf("\nasync function m1TeardownScenario");
    const seed = end === -1 ? body : body.slice(0, end);
    expect(seed).toMatch(/stagingDataMode: "SYNTHETIC_DEMO"/);
  });
  it("teardown deletes TenantLifecycleTransition + BillingCycle + ClubSubscription + Club + webhook events", () => {
    const body = FIXTURE.slice(FIXTURE.indexOf("async function m1TeardownScenario"));
    const end = body.indexOf("\nasync function m1TeardownAll");
    const td = end === -1 ? body : body.slice(0, end);
    expect(td).toMatch(/prisma\.tenantLifecycleTransition\.deleteMany/);
    expect(td).toMatch(/prisma\.billingCycle\.deleteMany/);
    expect(td).toMatch(/prisma\.clubSubscription\.deleteMany/);
    expect(td).toMatch(/prisma\.club\.deleteMany/);
    expect(td).toMatch(/prisma\.stripeWebhookEvent\.deleteMany/);
  });
});
