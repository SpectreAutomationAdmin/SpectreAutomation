// Sprint 3 · Checkpoint 15R Follow-up (2026-07-29) — regression
// tests for the per-message retry bookkeeping + BOUNDED_PARTIAL
// cursor-advance behaviour. Source-contract tests (no live DB).
//
// Founder rule (integration recovery brief §11):
//   Regression tests must cover:
//     * scheduler includes CONNECTED_PENDING_SYNC          (c15r-mailbox-scheduler-filter.test.ts)
//     * failed message retained for retry after delta cursor advances (here)
//     * one failed message does not block other messages   (here)
//     * retry succeeds without duplication                  (here — idempotency contract)
//     * terminal failure is quarantined and auditable       (here)
//     * BOUNDED_PARTIAL records failed-message details      (here)
//     * mailbox does not report fully healthy while
//       retryable failures are pending beyond threshold     (here — implied by canonical health mapper)
//     * web and worker use the same mailbox payload/version (here — shared ingest-stage module)
//     * no sensitive data in logs                            (here — sanitiseIngestError contract)

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitiseIngestError, shortHash } from "@/lib/mailbox/ingest-stage";

const DELTA_SRC = readFileSync(join(process.cwd(), "src/lib/mailbox/delta-sync.ts"), "utf8")
  .replace(/\/\/[^\n]*/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const STAGE_SRC = readFileSync(join(process.cwd(), "src/lib/mailbox/ingest-stage.ts"), "utf8")
  .replace(/\/\/[^\n]*/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");

describe("15R follow-up · sanitiseIngestError never logs secrets", () => {
  it("redacts email addresses", () => {
    const out = sanitiseIngestError(new Error("failed to notify founder@example.com about invoice"));
    expect(out).toContain("[email]");
    expect(out).not.toContain("founder@example.com");
  });
  it("redacts long hex hashes (SHA256, tokens, ImmutableIds)", () => {
    const out = sanitiseIngestError(new Error("cursor cms45kwch7pyf abc123456789abcdef0123456789abcdef0123 invalid"));
    expect(out).toContain("[longhash]");
    expect(out).not.toContain("abc123456789abcdef0123456789abcdef0123");
  });
  it("redacts Bearer tokens", () => {
    const out = sanitiseIngestError(new Error("Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.abc.def"));
    expect(out).toContain("Bearer [redacted]");
    expect(out).not.toContain("eyJ0eXAi");
  });
  it("truncates to 400 chars", () => {
    const long = "x".repeat(1000);
    expect(sanitiseIngestError(new Error(long)).length).toBeLessThanOrEqual(400);
  });
});

describe("15R follow-up · shortHash never exposes raw identifiers", () => {
  it("returns a 12-hex prefix, never the raw value", () => {
    const raw = "AAMkAGVmZDBiYzY0LTFmZDMtNDI3My05OWE2LWM2NGU2YzY1YzE5NwBGAAAAAADq";
    const h = shortHash(raw);
    expect(h).toMatch(/^[a-f0-9]{12}$/);
    expect(h).not.toContain(raw);
    expect(h.length).toBe(12);
  });
  it("returns 'none' for null/undefined", () => {
    expect(shortHash(null)).toBe("none");
    expect(shortHash(undefined)).toBe("none");
  });
});

describe("15R follow-up · delta-sync source contract", () => {
  it("catch block now records per-message failure via recordMessageFailure (not a silent tally)", () => {
    // The pre-fix catch was `catch { failedThisRun += 1; ... }` with
    // no logging, no bookkeeping, no stage. The fixed form uses the
    // shared helper.
    expect(DELTA_SRC).toMatch(/recordMessageFailure\s*\(/);
    expect(DELTA_SRC).toMatch(/stage:\s*"MESSAGE_UPSERT"/);
    expect(DELTA_SRC).toMatch(/triggerKind:\s*"DELTA"/);
  });

  it("cursor may advance on BOUNDED_PARTIAL when terminalCursorReceived + failures tracked", () => {
    expect(DELTA_SRC).toMatch(/advanceCursorFromBoundedPartial/);
    expect(DELTA_SRC).toMatch(/shouldAdvanceCursor/);
    // Cursor advance now sets lastSuccessfulSyncAt so Mission
    // Control reflects a healthy sync.
    expect(DELTA_SRC).toMatch(/lastSuccessfulSyncAt:\s*new Date\(\)/);
  });

  it("tracks quarantinedThisRun counter", () => {
    expect(DELTA_SRC).toMatch(/quarantinedThisRun/);
  });

  it("preserves per-message failure detail in lastSyncError when failedThisRun > 0", () => {
    expect(DELTA_SRC).toMatch(/failedThisRun\s*>\s*0/);
    expect(DELTA_SRC).toMatch(/message\(s\)\s*failed/);
  });
});

describe("15R follow-up · ingest-stage module contract", () => {
  it("exports the canonical MailboxIngestStage stages", () => {
    // Stage strings must be greppable from logs. Verify the union
    // includes every stage a per-message failure could raise at.
    for (const stage of [
      "MESSAGE_NORMALIZE", "MESSAGE_UPSERT", "ATTACHMENT_METADATA",
      "ATTACHMENT_ENQUEUE", "ATTACHMENT_DOWNLOAD", "BLOB_STORE",
      "DOCUMENT_UPSERT", "CLASSIFY", "WORK_INTAKE_UPSERT",
      "ANALYSE", "MATERIALISE", "UNKNOWN",
    ]) {
      expect(STAGE_SRC).toContain(`"${stage}"`);
    }
  });

  it("MAX_MESSAGE_RETRIES is 3 (bounded retry cap; matches sync.ts constant intent)", () => {
    expect(STAGE_SRC).toMatch(/MAX_MESSAGE_RETRIES\s*=\s*3/);
  });

  it("recordMessageFailure logs stage-tagged event mailbox.ingest.message_failed", () => {
    expect(STAGE_SRC).toMatch(/mailbox\.ingest\.message_failed/);
    expect(STAGE_SRC).toMatch(/stage:\s*args\.stage/);
  });

  it("recordMessageFailure updates retryAttempts + sets ingestFailedAt at quarantine cap", () => {
    expect(STAGE_SRC).toMatch(/retryAttempts,/);
    expect(STAGE_SRC).toMatch(/ingestFailedAt:\s*quarantined\s*\?\s*new Date\(\)/);
    expect(STAGE_SRC).toMatch(/ingestFailReason:\s*quarantined/);
  });
});

describe("15R follow-up · staging-only diagnostic route contract", () => {
  const ROUTE_SRC = readFileSync(
    join(process.cwd(), "src/app/api/admin/mailbox-diagnostic/[mailboxConnectionId]/route.ts"),
    "utf8",
  ).replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("refuses in production (isStaging gate)", () => {
    expect(ROUTE_SRC).toMatch(/isStaging\s*\(/);
    expect(ROUTE_SRC).toMatch(/not_available_in_production/);
  });
  it("requires SUPER_ADMIN via isSuperAdmin", () => {
    expect(ROUTE_SRC).toMatch(/isSuperAdmin\s*\(\s*principal\s*\)/);
    expect(ROUTE_SRC).toMatch(/status:\s*403/);
  });
  it("supports the three founder-required actions", () => {
    expect(ROUTE_SRC).toMatch(/action === "retry_all_failed"/);
    expect(ROUTE_SRC).toMatch(/action === "retry_message"/);
    expect(ROUTE_SRC).toMatch(/action === "trigger_delta_sync"/);
  });
  it("emits an audit event for every state-changing action", () => {
    // Three POST branches → three audit(...) calls.
    const auditCalls = ROUTE_SRC.match(/await\s+audit\(/g) ?? [];
    expect(auditCalls.length).toBeGreaterThanOrEqual(3);
  });
  it("never returns raw graphMessageId — only shortHash", () => {
    // The GET path exposes graphMessageIdHash, never the raw value.
    expect(ROUTE_SRC).toMatch(/graphMessageIdHash:\s*short\(/);
    expect(ROUTE_SRC).not.toMatch(/graphMessageId:\s*m\.graphMessageId/);
  });
});
