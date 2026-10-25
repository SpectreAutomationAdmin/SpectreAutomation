// SIGNUP-2 Phase 2A (2026-10-25) -- Durable tenant-provisioning
// workflow contract tests.

import { describe, it, expect } from "vitest";
import {
  PROVISIONING_STATES,
  FORWARD_SEQUENCE,
  PROVISIONING_TERMINAL_STATES,
  isProvisioningStepPermitted,
  nextRetryDelayMs,
  hasExhaustedRetries,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
  type ProvisioningState,
} from "@/lib/billing/tenant-provisioning-workflow";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "src/lib/billing/tenant-provisioning-workflow.ts"), "utf8");
const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

describe("SIGNUP-2 · provisioning states enumerated", () => {
  it("defines exactly the eleven documented states (9 forward + 2 terminal)", () => {
    expect(PROVISIONING_STATES).toEqual([
      "CREATED",
      "USER_CREATED",
      "CLUB_CREATED",
      "ROLES_ASSIGNED",
      "COA_COMMITTED",
      "OPENING_BALANCE_COMMITTED",
      "BRANDING_COMMITTED",
      "INVITATIONS_DELIVERED",
      "WELCOME_EMAIL_SENT",
      "COMPLETED",
      "FAILED",
    ]);
  });

  it("FORWARD_SEQUENCE excludes FAILED and ends at COMPLETED", () => {
    expect(FORWARD_SEQUENCE[FORWARD_SEQUENCE.length - 1]).toBe("COMPLETED");
    expect(FORWARD_SEQUENCE).not.toContain("FAILED");
  });

  it("COMPLETED and FAILED are terminal", () => {
    expect(PROVISIONING_TERMINAL_STATES.has("COMPLETED")).toBe(true);
    expect(PROVISIONING_TERMINAL_STATES.has("FAILED")).toBe(true);
    expect(PROVISIONING_TERMINAL_STATES.has("CREATED")).toBe(false);
  });
});

describe("SIGNUP-2 · provisioning step transitions", () => {
  it("CREATED -> USER_CREATED permitted", () => {
    expect(isProvisioningStepPermitted("CREATED", "USER_CREATED")).toBe(true);
  });

  it("USER_CREATED -> CLUB_CREATED permitted", () => {
    expect(isProvisioningStepPermitted("USER_CREATED", "CLUB_CREATED")).toBe(true);
  });

  it("WELCOME_EMAIL_SENT -> COMPLETED permitted", () => {
    expect(isProvisioningStepPermitted("WELCOME_EMAIL_SENT", "COMPLETED")).toBe(true);
  });

  it("any non-terminal -> FAILED permitted (error path)", () => {
    expect(isProvisioningStepPermitted("CREATED", "FAILED")).toBe(true);
    expect(isProvisioningStepPermitted("CLUB_CREATED", "FAILED")).toBe(true);
    expect(isProvisioningStepPermitted("WELCOME_EMAIL_SENT", "FAILED")).toBe(true);
  });

  it("skipping steps is forbidden (CREATED -> CLUB_CREATED not allowed)", () => {
    expect(isProvisioningStepPermitted("CREATED", "CLUB_CREATED")).toBe(false);
    expect(isProvisioningStepPermitted("CREATED", "COMPLETED")).toBe(false);
    expect(isProvisioningStepPermitted("USER_CREATED", "COA_COMMITTED")).toBe(false);
  });

  it("regressing is forbidden", () => {
    expect(isProvisioningStepPermitted("CLUB_CREATED", "CREATED")).toBe(false);
    expect(isProvisioningStepPermitted("COMPLETED", "WELCOME_EMAIL_SENT")).toBe(false);
  });

  it("transitions out of terminal states are forbidden by this predicate (operator path uses recoverFromFailure)", () => {
    for (const next of PROVISIONING_STATES) {
      if (next === "COMPLETED") continue;
      expect(isProvisioningStepPermitted("COMPLETED", next as ProvisioningState)).toBe(false);
    }
    for (const next of PROVISIONING_STATES) {
      if (next === "FAILED") continue;
      // FAILED has no normal forward transition; recovery is explicit.
      expect(isProvisioningStepPermitted("FAILED", next as ProvisioningState)).toBe(false);
    }
  });

  it("self-transitions are forbidden", () => {
    for (const s of PROVISIONING_STATES) {
      expect(isProvisioningStepPermitted(s as ProvisioningState, s as ProvisioningState)).toBe(false);
    }
  });
});

describe("SIGNUP-2 · retry policy", () => {
  it("base delay is 30 s; max is 1 h; max attempts is 10", () => {
    expect(RETRY_BASE_DELAY_MS).toBe(30_000);
    expect(RETRY_MAX_DELAY_MS).toBe(3_600_000);
    expect(RETRY_MAX_ATTEMPTS).toBe(10);
  });

  it("delay doubles with attempt count (exponential backoff)", () => {
    expect(nextRetryDelayMs(1)).toBe(30_000);          // 30 s
    expect(nextRetryDelayMs(2)).toBe(60_000);          // 1 min
    expect(nextRetryDelayMs(3)).toBe(120_000);         // 2 min
    expect(nextRetryDelayMs(4)).toBe(240_000);         // 4 min
  });

  it("delay caps at RETRY_MAX_DELAY_MS", () => {
    expect(nextRetryDelayMs(100)).toBe(RETRY_MAX_DELAY_MS);
    expect(nextRetryDelayMs(9)).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
  });

  it("hasExhaustedRetries is true at RETRY_MAX_ATTEMPTS", () => {
    expect(hasExhaustedRetries(0)).toBe(false);
    expect(hasExhaustedRetries(RETRY_MAX_ATTEMPTS - 1)).toBe(false);
    expect(hasExhaustedRetries(RETRY_MAX_ATTEMPTS)).toBe(true);
    expect(hasExhaustedRetries(RETRY_MAX_ATTEMPTS + 1)).toBe(true);
  });
});

describe("SIGNUP-2 · provisioning source-contract", () => {
  it("createProvisioningJob is idempotent on billingCycleId", () => {
    expect(src).toMatch(/prisma\.tenantProvisioningJob\.findUnique\(\s*{\s*where:\s*{\s*billingCycleId:/);
    expect(src).toMatch(/if \(existing\) return \{ id: existing\.id, createdNew: false \}/);
  });

  it("advanceOneStep uses increment: 1 for attempts (not raw +1)", () => {
    expect(src).toMatch(/attempts:\s*{\s*increment:\s*1\s*}/);
  });

  it("retry path writes nextAttemptAt via exponential backoff; non-retriable writes state=FAILED", () => {
    expect(src).toMatch(/nextAttemptAt:\s*new Date\(Date\.now\(\)\s*\+\s*nextRetryDelayMs/);
    expect(src).toMatch(/state:\s*"FAILED"/);
  });

  it("step handler must return an idempotencyAnchor hashmap", () => {
    expect(src).toMatch(/idempotencyAnchor:\s*Record<string, string \| null>/);
    expect(src).toMatch(/\.\.\.result\.idempotencyAnchor/);
  });

  it("recoverFromFailure reads idempotency anchors to resume from the last-completed step", () => {
    expect(src).toMatch(/if \(job\.provisionedUserId\) resumeState = "USER_CREATED"/);
    expect(src).toMatch(/if \(job\.provisionedClubId\) resumeState = "CLUB_CREATED"/);
    expect(src).toMatch(/if \(job\.welcomeEmailProviderMessageId\) resumeState = "WELCOME_EMAIL_SENT"/);
  });

  it("recoverFromFailure refuses to operate on jobs that are not FAILED", () => {
    expect(src).toMatch(/SIGNUP_2_PROVISIONING_RECOVERY_NOT_FAILED/);
    expect(src).toMatch(/if \(job\.state !== "FAILED"\)/);
  });
});

describe("SIGNUP-2 · provisioning job schema (Prisma)", () => {
  it("TenantProvisioningJob model exists with the eight idempotency anchors", () => {
    expect(schema).toMatch(/model TenantProvisioningJob \{/);
    expect(schema).toMatch(/provisionedUserId\s+String\?/);
    expect(schema).toMatch(/provisionedClubId\s+String\?/);
    expect(schema).toMatch(/rolesAssignedBatchKey\s+String\?/);
    expect(schema).toMatch(/committedCoaBatchKey\s+String\?/);
    expect(schema).toMatch(/committedOpeningBalanceBatchKey\s+String\?/);
    expect(schema).toMatch(/committedBrandingBatchKey\s+String\?/);
    expect(schema).toMatch(/invitationsDeliveredBatchKey\s+String\?/);
    expect(schema).toMatch(/welcomeEmailProviderMessageId\s+String\?/);
  });

  it("job is uniquely keyed by billingCycleId", () => {
    const jobBlock = schema.match(/model TenantProvisioningJob \{[\s\S]+?@@index/)?.[0] ?? "";
    expect(jobBlock).toMatch(/billingCycleId\s+String\s+@unique/);
  });
});
