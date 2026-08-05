// Sprint 3 · Checkpoint 16H rejection #3 (2026-08-06) — the
// Mission Control summary buckets must reconcile to the visible
// Active feed. See founder §12/§13.
//
// The invariant being tested at unit scope:
//   loadBriefingCounts is now called with visibleWorkItems (post-
//   filter), so RESOLVED items that the Active view drops cannot
//   inflate Needs Judgment / Informational / Ready for Approval /
//   Completed Automatically buckets.
//
// Full DB round-trip is exercised by the Playwright staging
// acceptance (§21) and by the existing mission-control-c14c suite.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MC_INDEX_TS = fs.readFileSync(
  path.join(process.cwd(), "src", "lib", "mission-control", "index.ts"),
  "utf8",
);

describe("16H rejection #3 · Mission Control count reconciliation", () => {
  it("loadBriefingCounts is passed visibleWorkItems, not raw workItems", () => {
    // Slice the loadMissionControlSnapshot function so we don't
    // accidentally match an unrelated call elsewhere in the module.
    const start = MC_INDEX_TS.indexOf("export async function loadMissionControlSnapshot");
    expect(start, "loadMissionControlSnapshot must exist").toBeGreaterThan(-1);
    const end = MC_INDEX_TS.indexOf("\n}\n", start);
    const fn = MC_INDEX_TS.slice(start, end);
    // The active call MUST pass visibleWorkItems.
    expect(fn).toMatch(/loadBriefingCounts\(\s*principal\s*,\s*clubId\s*,\s*visibleWorkItems\s*,/);
    // And MUST NOT pass raw workItems in that position (regression
    // guard for the pre-fix bug where 8+2 counters shipped for a
    // 7-item feed).
    expect(fn).not.toMatch(/loadBriefingCounts\(\s*principal\s*,\s*clubId\s*,\s*workItems\s*,/);
  });

  it("state values used by loadBriefingCounts are mutually exclusive", () => {
    // The four Active buckets (approval / judgment / info / auto)
    // are derived from `w.state`. WorkItemState is a string union
    // — a single item can only carry ONE literal value. Test
    // asserts the type declaration hasn't gained overlap.
    expect(MC_INDEX_TS).toMatch(
      /export type WorkItemState\s*=\s*"judgment"\s*\|\s*"approval"\s*\|\s*"comm"\s*\|\s*"auto"\s*\|\s*"info"/,
    );
  });

  it("briefing derivation reads exactly one state field per bucket", () => {
    const start = MC_INDEX_TS.indexOf("async function loadBriefingCounts");
    const end = MC_INDEX_TS.indexOf("\n}\n", start);
    const fn = MC_INDEX_TS.slice(start, end);
    // Each of the three feed-derived counts must filter on a
    // single state literal — no compound predicates that could
    // count one item twice.
    expect(fn).toMatch(/filter\(\(w\) => w\.state === "approval"\)\.length/);
    expect(fn).toMatch(/filter\(\(w\) => w\.state === "judgment"\)\.length/);
    expect(fn).toMatch(/filter\(\(w\) => w\.state === "info"\)\.length/);
  });
});
