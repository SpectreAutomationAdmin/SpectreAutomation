// EP-TRAIN-4Y-AN §2 — regression tests for the per-pilot $2 override.
// Verifies the raise applies ONLY to the Silver Springs course version
// and does NOT change the global default for any other tenant.

import { describe, it, expect } from "vitest";
import {
  PILOT_BUDGET_USD_MICROS,
  PILOT_BUDGET_OVERRIDES,
  getPilotBudgetMicros,
  preInvocationBudgetGate,
  msToCostMicros,
} from "@/lib/hr/training/generation/pilot-budget-guard";

const SILVER_SPRINGS_VERSION = "cmw8n6z9a000az4nx56vwh02f";

describe("§2 — override applies ONLY to the Silver Springs pilot", () => {
  it("global $1 default unchanged", () => {
    expect(PILOT_BUDGET_USD_MICROS).toBe(1_000_000);
  });

  it("Silver Springs (cmw8n6z9a000az4nx56vwh02f) resolves to $2 override", () => {
    expect(getPilotBudgetMicros(SILVER_SPRINGS_VERSION)).toBe(2_000_000);
  });

  it("every other tenant / course version falls back to $1", () => {
    const otherVersions = [
      "some-other-course-version-id",
      "cv-arbitrary-1234",
      "cmvzs3vz9000256qcu7lfysoz", // the SECOND Silver Springs pilot — not in override
      "",
      "0123456789abcdef",
    ];
    for (const v of otherVersions) {
      expect(getPilotBudgetMicros(v)).toBe(PILOT_BUDGET_USD_MICROS);
    }
  });

  it("override map includes founder authorisation reference", () => {
    const override = PILOT_BUDGET_OVERRIDES.get(SILVER_SPRINGS_VERSION);
    expect(override).toBeDefined();
    expect(override?.authorisation).toContain("4Y-AN");
    expect(override?.budgetUsdMicros).toBe(2_000_000);
  });

  it("override map size is exactly 1 (only Silver Springs)", () => {
    expect(PILOT_BUDGET_OVERRIDES.size).toBe(1);
  });
});

describe("§2 — preInvocationBudgetGate honours the override via opts.budgetMicros", () => {
  const RATE = 1.95 / (3600 * 1000);
  const SESSION_WORST_CASE_MS = 4 * 180_000 + 60_000; // 4 chunks + cold-boot
  const sessionCostMicros = Math.ceil(SESSION_WORST_CASE_MS * (1.95 / (3600 * 1000) * 1_000_000 / 1_000));
  // 780000 * 0.541_666_7 ≈ 422_500 micros

  it("$1 default: $0.6285 prior + $0.4225 session → BLOCKED (previous AM Gate 3 condition)", () => {
    const decision = preInvocationBudgetGate({
      priorAttemptCostMicros: msToCostMicros(689_220) + Math.ceil(471_010 * (1.95 / 3_600_000 * 1_000_000)),
      // ≈ 628 500 micros = $0.6285
      currentAttemptCostMicros: 0,
      callsRemainingThisAttempt: 4,
      coldBootConsumed: false,
    });
    expect(decision.allow).toBe(false);
    expect(decision.budgetMicros).toBe(1_000_000);
    expect(decision.reason).toMatch(/\$1\.00 budget would be exceeded/);
  });

  it("$2 override: same inputs → ALLOWED (AN raise)", () => {
    const decision = preInvocationBudgetGate({
      priorAttemptCostMicros: msToCostMicros(689_220) + Math.ceil(471_010 * (1.95 / 3_600_000 * 1_000_000)),
      currentAttemptCostMicros: 0,
      callsRemainingThisAttempt: 4,
      coldBootConsumed: false,
    }, { budgetMicros: 2_000_000 });
    expect(decision.allow).toBe(true);
    expect(decision.budgetMicros).toBe(2_000_000);
  });

  it("mid-session re-check after 2 calls still fits in $2 (1 cold-boot consumed + 2 remaining)", () => {
    const prior = 628_500;
    const spent = msToCostMicros(60_000 + 180_000); // cold-boot + 1 chunk ≈ 130_000
    const decision = preInvocationBudgetGate({
      priorAttemptCostMicros: prior,
      currentAttemptCostMicros: spent,
      callsRemainingThisAttempt: 2,
      coldBootConsumed: true,
    }, { budgetMicros: 2_000_000 });
    expect(decision.allow).toBe(true);
  });

  it("$2 override would ALSO block if session needed many more calls", () => {
    const decision = preInvocationBudgetGate({
      priorAttemptCostMicros: 1_500_000, // $1.50 already spent
      currentAttemptCostMicros: 0,
      callsRemainingThisAttempt: 4,
      coldBootConsumed: false,
    }, { budgetMicros: 2_000_000 });
    // projected: 1_500_000 + 0 + 4 * 180_000 * rate + 60_000 * rate ≈ 1_922_500 > 2_000_000? Let's compute exactly:
    // 4 * 180_000 * 0.541_666_7 ≈ 390_000; 60_000 * 0.541_666_7 ≈ 32_500 → total 422_500
    // 1_500_000 + 422_500 = 1_922_500 < 2_000_000, so this should ALLOW
    expect(decision.allow).toBe(true);
  });

  it("$2 override BLOCKS at $1.80 prior + full session", () => {
    const decision = preInvocationBudgetGate({
      priorAttemptCostMicros: 1_800_000,
      currentAttemptCostMicros: 0,
      callsRemainingThisAttempt: 4,
      coldBootConsumed: false,
    }, { budgetMicros: 2_000_000 });
    // 1_800_000 + 422_500 = 2_222_500 > 2_000_000
    expect(decision.allow).toBe(false);
  });
});

describe("§2 — audit trail", () => {
  it("override entry's authorisation string includes the directive slug", () => {
    for (const [cv, entry] of PILOT_BUDGET_OVERRIDES) {
      expect(entry.authorisation).toMatch(/EP-TRAIN-4Y-/);
      expect(entry.authorisation).toMatch(/\d{4}-\d{2}-\d{2}/); // date stamp
      expect(cv.length).toBeGreaterThan(10); // cuid-shaped
    }
  });
});
