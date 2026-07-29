// Sprint 3 · Checkpoint 15R (2026-07-29) — source-contract test for
// the auto-sync scheduler status filter. The pre-15R filter used
// the string "PENDING_SYNC" which does NOT match the actual enum
// value "CONNECTED_PENDING_SYNC" (src/lib/mailbox/status.ts:38).
// Real staging symptom: Coulee Ridge's mailbox went 19+ hours
// without a sync attempt because the scheduler never enqueued it.
//
// This test asserts the current source uses the canonical
// `MAILBOX_STATUS` constants in the status filter — no bare
// strings that could drift from the enum again.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEDULER_SRC_RAW = readFileSync(
  join(process.cwd(), "src/lib/mailbox/auto-sync-scheduler.ts"),
  "utf8",
);
// Strip line comments + block comments so historical notes that
// name the pre-15R defect string do not trip the regex.
const SCHEDULER_SRC = SCHEDULER_SRC_RAW
  .replace(/\/\/[^\n]*/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");

describe("15R · auto-sync scheduler filter", () => {
  it("uses MAILBOX_STATUS.CONNECTED_PENDING_SYNC (not the bare string 'PENDING_SYNC')", () => {
    expect(SCHEDULER_SRC).toMatch(/MAILBOX_STATUS\.CONNECTED_PENDING_SYNC/);
    // The specific pre-15R defect: bare "PENDING_SYNC" string in the
    // status alternation. Bare use of that string in the filter
    // would mean the enum drift is back.
    expect(SCHEDULER_SRC).not.toMatch(/"PENDING_SYNC"/);
  });

  it("also includes MAILBOX_STATUS.CONNECTED + MAILBOX_STATUS.DELAYED for auto-sync eligibility", () => {
    expect(SCHEDULER_SRC).toMatch(/MAILBOX_STATUS\.CONNECTED\b/);
    expect(SCHEDULER_SRC).toMatch(/MAILBOX_STATUS\.DELAYED\b/);
  });

  it("still requires deltaLink AND refreshTokenSecretRef to be non-null (initial-sync gate + credentials gate)", () => {
    expect(SCHEDULER_SRC).toMatch(/deltaLink:\s*\{\s*not:\s*null\s*\}/);
    expect(SCHEDULER_SRC).toMatch(/refreshTokenSecretRef:\s*\{\s*not:\s*null\s*\}/);
  });
});
