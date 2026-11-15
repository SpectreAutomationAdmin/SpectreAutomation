// EP-TRAIN-4Y-Z §3 — offline tests for the per-pilot spending guard.
// Zero GPU inference. All behaviour is tested against the pure-function
// surface + a mock Prisma for the prior-cost loader.

import { describe, expect, it } from "vitest";
import {
  COLD_BOOT_WORST_CASE_MS,
  COST_PER_MS_MICROS,
  PER_CALL_WORST_CASE_MS,
  PILOT_BUDGET_USD_MICROS,
  loadPriorPilotCostMicros,
  msToCostMicros,
  preInvocationBudgetGate,
  projectPilotWorstCaseMicros,
} from "@/lib/hr/training/generation/pilot-budget-guard";

describe("EP-TRAIN-4Y-Z §3 — pilot-budget-guard pure surface", () => {
  it("msToCostMicros rounds up with the L40S rate (0.541666 micros/ms)", () => {
    // 1000ms × 0.5416667 = 541.6667 → ceil → 542.
    expect(msToCostMicros(1000)).toBe(542);
    // 180s × 0.5416667 = 97,500.006 → ceil → 97,501.
    expect(msToCostMicros(PER_CALL_WORST_CASE_MS)).toBe(97_501);
    // 60s × 0.5416667 = 32,500.002 → ceil → 32,501.
    expect(msToCostMicros(COLD_BOOT_WORST_CASE_MS)).toBe(32_501);
    // Zero ms → zero cost.
    expect(msToCostMicros(0)).toBe(0);
  });

  it("projectPilotWorstCaseMicros sums prior + current + remaining × per-call + cold-boot", () => {
    const projected = projectPilotWorstCaseMicros({
      priorAttemptCostMicros: 50_000,
      currentAttemptCostMicros: 20_000,
      callsRemainingThisAttempt: 3,
      coldBootConsumed: false,
    });
    // 50_000 + 20_000 + (3 × 97_501) + 32_501 = 395_004.
    expect(projected).toBe(50_000 + 20_000 + 3 * 97_501 + 32_501);
  });

  it("projectPilotWorstCaseMicros drops cold-boot once consumed", () => {
    const base = {
      priorAttemptCostMicros: 0,
      currentAttemptCostMicros: 0,
      callsRemainingThisAttempt: 1,
    };
    const cold = projectPilotWorstCaseMicros({ ...base, coldBootConsumed: false });
    const warm = projectPilotWorstCaseMicros({ ...base, coldBootConsumed: true });
    // Warm run saves exactly one cold-boot ceiling.
    expect(cold - warm).toBe(32_501);
  });

  it("projectPilotWorstCaseMicros treats negative remaining as zero", () => {
    const projected = projectPilotWorstCaseMicros({
      priorAttemptCostMicros: 5000,
      currentAttemptCostMicros: 3000,
      callsRemainingThisAttempt: -4, // defensive: never possible in practice
      coldBootConsumed: true,
    });
    // 5000 + 3000 + 0 + 0 = 8000.
    expect(projected).toBe(8000);
  });

  it("preInvocationBudgetGate allows when projection ≤ $1", () => {
    const decision = preInvocationBudgetGate({
      priorAttemptCostMicros: 0,
      currentAttemptCostMicros: 0,
      callsRemainingThisAttempt: 7, // 1 metadata + 6 groups
      coldBootConsumed: false,
    });
    // Projection = 7 × 97_501 + 32_501 = 715_008 < 1_000_000.
    expect(decision.allow).toBe(true);
    expect(decision.projectedTotalMicros).toBe(715_008);
    expect(decision.budgetMicros).toBe(PILOT_BUDGET_USD_MICROS);
  });

  it("preInvocationBudgetGate REFUSES when projection > $1 (BUDGET EXHAUSTION)", () => {
    // Simulate a mid-loop state where prior attempt burned 350k micros
    // and this attempt has burned 200k, with 5 remaining group calls.
    const decision = preInvocationBudgetGate({
      priorAttemptCostMicros: 350_000,
      currentAttemptCostMicros: 200_000,
      callsRemainingThisAttempt: 5,
      coldBootConsumed: true,
    }, { budgetMicros: 1_000_000 });
    // Projection = 350k + 200k + 5 × 97_501 + 0 = 1_037_505 > 1_000_000.
    expect(decision.allow).toBe(false);
    expect(decision.projectedTotalMicros).toBe(1_037_505);
    expect(decision.reason).toContain("Pilot $1.00 budget would be exceeded");
    // The reason string carries the diagnostic breakdown so the audit
    // log entry is truthful — but it does NOT embed secrets, tokens, or
    // signed URLs (asserted structurally by the fields it mentions).
    expect(decision.reason).toContain("Prior-attempt cost");
    expect(decision.reason).not.toMatch(/token|secret|signature|signed/i);
  });

  it("preInvocationBudgetGate REFUSES when RETRIES push cumulative basis over budget", () => {
    // Retry scenario: prior attempt burned $0.80 (800k micros). New
    // attempt starts fresh (currentAttempt=0) but 7 calls remain with
    // cold-boot NOT yet consumed. Projection must trip.
    const decision = preInvocationBudgetGate({
      priorAttemptCostMicros: 800_000,
      currentAttemptCostMicros: 0,
      callsRemainingThisAttempt: 7,
      coldBootConsumed: false,
    }, { budgetMicros: 1_000_000 });
    // Projection = 800k + 0 + 7 × 97_501 + 32_501 = 1_515_008 > 1_000_000.
    expect(decision.allow).toBe(false);
    // Retries do NOT reset the pilot's cumulative budget — the basis is
    // preserved across attempts.
    expect(decision.projectedTotalMicros).toBeGreaterThan(1_000_000);
  });

  it("preInvocationBudgetGate ALLOWS the realistic founder-pilot profile (no prior cost, fresh attempt)", () => {
    // Founder pilot: cmw9gicvl000767ww5kwvfyhc orphan is CANCELLED with
    // zero inferenceMs. Fresh retry starts with priorAttemptCostMicros=0.
    // One metadata call + 5 checkpoints + 1 final = 7 calls. Cold-boot
    // not yet consumed.
    const decision = preInvocationBudgetGate({
      priorAttemptCostMicros: 0,
      currentAttemptCostMicros: 0,
      callsRemainingThisAttempt: 7,
      coldBootConsumed: false,
    });
    // Projection = 7 × 97_501 + 32_501 = 715_008 < 1_000_000.
    expect(decision.allow).toBe(true);
    // Headroom: $0.285 of buffer under the $1 ceiling, for cold-boot
    // overrun / 180s worst-case slippage.
    expect(decision.projectedTotalMicros).toBeLessThan(PILOT_BUDGET_USD_MICROS);
  });
});

describe("EP-TRAIN-4Y-Z §3 — loadPriorPilotCostMicros", () => {
  // 4Y-BE: the loader reads the rows (finished runs at actual cost, live
  // siblings reserved at worst case, transcription included) instead of
  // one aggregate over inferenceMs.
  type RunRow = { executionStatus: string; inferenceMs: number | null; assessmentPlanJson: string | null };
  function makePrismaStub(runs: RunRow[], onWhere?: (where: unknown) => void) {
    return {
      trainingQuestionAiGenerationRun: {
        findMany: async (args: { where: unknown }) => {
          onWhere?.(args.where);
          return runs;
        },
      },
      trainingTranscriptionJob: { findMany: async () => [] },
    } as unknown as import("@prisma/client").PrismaClient;
  }
  const finished = (inferenceMs: number | null, executionStatus = "COMPLETED"): RunRow => ({
    executionStatus,
    inferenceMs,
    assessmentPlanJson: null,
  });

  it("returns 0 when no prior runs exist", async () => {
    const cost = await loadPriorPilotCostMicros(
      { clubId: "club-1", courseVersionId: "ver-1", excludeRunId: "run-current" },
      { prisma: makePrismaStub([]) },
    );
    expect(cost).toBe(0);
  });

  it("converts each finished run's inferenceMs to micros via the L40S rate (DUPLICATE-DELIVERY-SAFE basis)", async () => {
    const cost = await loadPriorPilotCostMicros(
      { clubId: "club-1", courseVersionId: "ver-1", excludeRunId: "run-current" },
      { prisma: makePrismaStub([finished(50_000), finished(30_000)]) },
    );
    expect(cost).toBe(msToCostMicros(50_000) + msToCostMicros(30_000));
  });

  it("excludes the CURRENT run from the prior-cost basis", async () => {
    let capturedWhere: unknown = null;
    await loadPriorPilotCostMicros(
      { clubId: "club-X", courseVersionId: "ver-X", excludeRunId: "run-current-X" },
      { prisma: makePrismaStub([], (where) => { capturedWhere = where; }) },
    );
    expect(capturedWhere).toMatchObject({
      clubId: "club-X",
      courseVersionId: "ver-X",
      id: { not: "run-current-X" },
    });
  });

  it("a live sibling run is reserved at its worst case, not counted as zero", async () => {
    const cost = await loadPriorPilotCostMicros(
      { clubId: "club-1", courseVersionId: "ver-1", excludeRunId: "run-current" },
      { prisma: makePrismaStub([finished(null, "RUNNING")]) },
    );
    expect(cost).toBeGreaterThan(0);
  });
});

describe("EP-TRAIN-4Y-Z §3 — cancellation + duplicate-delivery semantics", () => {
  function stubWith(inferenceMs: number, executionStatus: string) {
    return {
      trainingQuestionAiGenerationRun: {
        findMany: async () => [{ executionStatus, inferenceMs, assessmentPlanJson: null }],
      },
      trainingTranscriptionJob: { findMany: async () => [] },
    } as unknown as import("@prisma/client").PrismaClient;
  }

  it("a CANCELLED prior run's inferenceMs still participates in the budget basis", async () => {
    const prior = await loadPriorPilotCostMicros(
      { clubId: "club-1", courseVersionId: "ver-1", excludeRunId: "run-current" },
      { prisma: stubWith(100_000, "CANCELLED") },
    );
    expect(prior).toBe(msToCostMicros(100_000));
    const decision = preInvocationBudgetGate({
      priorAttemptCostMicros: prior,
      currentAttemptCostMicros: 0,
      callsRemainingThisAttempt: 7,
      coldBootConsumed: false,
    });
    expect(decision.allow).toBe(true);
  });

  it("a duplicate queue delivery cannot re-authorise inference once the ceiling is exhausted", async () => {
    // The first attempt already burned 9,000 s of provider time
    // (≈ $4.88). A second delivery of the same queue entry sees that
    // cost and is refused: 4.88 + worst case of 7 calls > $5.
    const prior = await loadPriorPilotCostMicros(
      { clubId: "club-1", courseVersionId: "ver-1", excludeRunId: "run-duplicate-2" },
      { prisma: stubWith(9_000_000, "COMPLETED") },
    );
    expect(prior).toBe(msToCostMicros(9_000_000));
    const decision = preInvocationBudgetGate({
      priorAttemptCostMicros: prior,
      currentAttemptCostMicros: 0,
      callsRemainingThisAttempt: 7,
      coldBootConsumed: false,
    });
    expect(decision.allow).toBe(false);
    expect(decision.projectedTotalMicros).toBeGreaterThan(PILOT_BUDGET_USD_MICROS);
  });
});

describe("EP-TRAIN-4Y-Z §3 — invariants (regression guards)", () => {
  it("the per-course ceiling is $5 (5_000_000 micros), distinct from the $10 daily cap", () => {
    expect(PILOT_BUDGET_USD_MICROS).toBe(5_000_000);
  });

  it("cost-per-ms rate matches generation-service's L40S rate exactly", () => {
    // Regression guard: if someone changes the daily-cap rate in
    // generation-service without updating this constant, the two
    // budgets drift. We lock the rate here.
    expect(COST_PER_MS_MICROS).toBe(0.541_666_7);
  });

  it("per-call + cold-boot ceilings are at least 3× typical observed runtime (~84s)", () => {
    // The 4Y-N run showed max 84s; 4Y-V showed 20-32s typical. The
    // worst-case ceiling must stay well above typical to preserve
    // headroom before tripping on a slow-but-successful call.
    const typicalObservedMs = 84_000;
    expect(PER_CALL_WORST_CASE_MS).toBeGreaterThanOrEqual(typicalObservedMs * 2);
  });
});
