// WI-CAL-1 (2026-10-13) — Work Intake Today's Commitments reuses
// the approved Mission Control component.
//
// Pre-fix (WI-2B deferral): the Work Intake rail-view-model
// collapsed the canonical TodayCommitmentsSnapshot into an "N
// appointment(s) for today." summary string, which rendered on
// Work Intake as "1 appointment for today." — no time, no title,
// no OUTLOOK CALENDAR source.
//
// Post-fix: the rail-view-model passes the SAME canonical snapshot
// through, and WorkIntakeRightRail mounts the shared
// `components/mission-control/TodaysCommitments` component.
//
// Pure source-contract tests — the shared component itself already
// has its own tests under /tests covering per-row rendering, consent
// hints, and the 60-second live tick.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(__dirname, "..");

const RAIL_RENDERER = fs.readFileSync(
  path.join(REPO, "src/components/work-intake/scaffold/WorkIntakeRightRail.tsx"),
  "utf-8",
);
const RAIL_VIEW_MODEL = fs.readFileSync(
  path.join(REPO, "src/lib/work-intake/rail-view-model.ts"),
  "utf-8",
);
const SCAFFOLD_DATA = fs.readFileSync(
  path.join(REPO, "src/components/work-intake/scaffold/scaffold-data.ts"),
  "utf-8",
);

describe("WI-CAL-1 §A — Work Intake imports the shared Mission Control TodaysCommitments", () => {
  it("imports from @/components/mission-control/TodaysCommitments (shared)", () => {
    expect(RAIL_RENDERER).toContain('from "@/components/mission-control/TodaysCommitments"');
    expect(RAIL_RENDERER).toContain("import TodaysCommitments");
  });

  it("mounts <TodaysCommitments data={…}/> inside the WI rail slot", () => {
    expect(RAIL_RENDERER).toMatch(/<TodaysCommitments data=\{data\.commitments\.snapshot\}\s*\/>/);
  });

  it("retains the Work-Intake rail wrapper (preserves sidebar positioning + width per directive §3-7)", () => {
    // The outer <section className="wi-rail-card wi-rail-commitments-slot">
    // keeps the same width/positioning as the pre-fix card so the
    // approved Mission Control card lives inside the WI sidebar
    // chrome without touching the WI-1 §11 reference geometry.
    expect(RAIL_RENDERER).toContain("wi-rail-card wi-rail-commitments-slot");
  });
});

describe("WI-CAL-1 §B — Rail view-model passes the FULL canonical snapshot through", () => {
  it("retires the pre-fix `empty: composeCommitmentsSummary(…)` stub", () => {
    expect(RAIL_VIEW_MODEL).not.toMatch(/composeCommitmentsSummary\(/);
    expect(RAIL_VIEW_MODEL).not.toMatch(/empty:\s*composeCommitmentsSummary/);
    expect(RAIL_VIEW_MODEL).not.toMatch(/function composeCommitmentsSummary/);
    // The "N appointments for today" copy pattern is gone.
    expect(RAIL_VIEW_MODEL).not.toMatch(/\$\{events\} appointment\$\{events === 1 \?/);
  });

  it("passes `snapshot: commitments` verbatim — same object Mission Control consumes", () => {
    expect(RAIL_VIEW_MODEL).toMatch(/snapshot:\s*commitments,/);
    // The rail-view-model's Input type still carries the canonical
    // TodayCommitmentsSnapshot shape.
    expect(RAIL_VIEW_MODEL).toMatch(/commitments:\s*TodayCommitmentsSnapshot;/);
  });
});

describe("WI-CAL-1 §C — WiRailData shape carries the canonical snapshot (not an empty-copy string)", () => {
  it("the commitments field holds `snapshot: TodayCommitmentsSnapshot`", () => {
    expect(SCAFFOLD_DATA).toMatch(/commitments:\s*\{\s*\n\s*snapshot:\s*import\("@\/lib\/mission-control\/commitments"\)\.TodayCommitmentsSnapshot;/);
    // The pre-fix `empty: string` field is gone.
    expect(SCAFFOLD_DATA).not.toMatch(/commitments:\s*\{\s*\n\s*empty:\s*string;/);
  });

  it("the stub `WI_RAIL` constant has a valid empty-shape snapshot (empty items, zero counts)", () => {
    expect(SCAFFOLD_DATA).toMatch(/items:\s*\[\],/);
    expect(SCAFFOLD_DATA).toMatch(/outlookEventCount:\s*0,/);
    expect(SCAFFOLD_DATA).toMatch(/spectreCommitmentCount:\s*0,/);
    expect(SCAFFOLD_DATA).toMatch(/calendarConsent:\s*"CONNECTED",/);
  });
});

describe("WI-CAL-1 §D — Mission Control + Work Intake share one component tree + one data source", () => {
  it("the admin page (Mission Control) renders <TodaysCommitments> too", () => {
    const adminPage = fs.readFileSync(
      path.join(REPO, "src/app/app/admin/page.tsx"),
      "utf-8",
    );
    expect(adminPage).toContain("<TodaysCommitments data={snapshot.todaysCommitments}");
  });

  it("the Work Intake page threads the SAME `snapshot.todaysCommitments` field into `toRailData`", () => {
    const wiPage = fs.readFileSync(
      path.join(REPO, "src/app/app/admin/work-intake/page.tsx"),
      "utf-8",
    );
    expect(wiPage).toMatch(/commitments:\s*snapshot\.todaysCommitments,/);
  });

  it("neither page defines a separate commitments component or data path", () => {
    // Both import from the same TodaysCommitments module.  No
    // parallel implementation lives under src/components/work-intake/.
    const dirCheck = fs.readdirSync(path.join(REPO, "src/components/work-intake"), { withFileTypes: true });
    const names = dirCheck.map((d) => d.name.toLowerCase());
    const parallel = names.filter((n) =>
      n.includes("commitment") || n.includes("appointment") || n.includes("calendar"),
    );
    expect(parallel).toEqual([]);
  });
});
