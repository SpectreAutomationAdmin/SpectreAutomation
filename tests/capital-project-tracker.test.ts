// Capital Project Tracker service tests — shape + reactive
// exception report + reactive project notes + period sensitivity.

import { describe, it, expect } from "vitest";

import {
  buildSilverSpringsCapitalProjectTracker,
  buildCapitalProjectExceptionReport,
  buildCapitalProjectNotes,
} from "@/lib/reporting/capital-project-tracker";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

const MAY_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
const SILVER_SPRINGS = "Silver Springs Golf & Country Club";

const SEED_OPTS = {
  clubName: SILVER_SPRINGS,
  period: MAY_2026,
  reserveBalanceLabel: "$4.82M",
  statementOfActivitiesNumber: "Statement 04",
} as const;

describe("buildCapitalProjectExceptionReport — reactive narrative", () => {
  it("emits the favourable-variance branch when there are no overruns and at least one project saved money", () => {
    const out = buildCapitalProjectExceptionReport({
      periodLabel: "Q1 2026",
      activeProjects: [
        { label: "Terrace & Patio Renovation", variance: 5_000, status: "on-track" },
        { label: "HVAC — Clubhouse",            variance: 0,     status: "on-track" },
      ],
    });
    expect(out.eyebrow).toBe("Exception Report — Q1 2026");
    expect(out.body).toMatch(/No active projects have material cost overruns to report/);
    expect(out.body).toMatch(/Terrace & Patio Renovation is tracking \$5K below authorized budget/);
    expect(out.body).toMatch(/favorable contractor pricing/);
  });

  it("emits the at-risk branch when no overruns BUT at least one project is at-risk", () => {
    const out = buildCapitalProjectExceptionReport({
      periodLabel: "Q1 2026",
      activeProjects: [
        { label: "Locker Room Renovation", variance: 0, status: "at-risk" },
        { label: "HVAC — Clubhouse",       variance: 0, status: "on-track" },
      ],
    });
    expect(out.body).toMatch(/No active projects have material cost overruns to report/);
    expect(out.body).toMatch(/Locker Room Renovation/);
    expect(out.body).toMatch(/flagged at risk/);
  });

  it("emits the overrun branch when a project carries status='over-budget'", () => {
    const out = buildCapitalProjectExceptionReport({
      periodLabel: "Q1 2026",
      activeProjects: [
        { label: "HVAC — Clubhouse", variance: -25_000, status: "over-budget" },
      ],
    });
    expect(out.body).toMatch(/Material cost overruns to report: HVAC — Clubhouse/);
    expect(out.body).toMatch(/Board attention is required/);
  });

  it("emits the all-clear branch when no overruns, no at-risk, and no favourable variances", () => {
    const out = buildCapitalProjectExceptionReport({
      periodLabel: "Q1 2026",
      activeProjects: [
        { label: "HVAC — Clubhouse", variance: 0, status: "on-track" },
      ],
    });
    expect(out.body).toMatch(/All projects are executing within authorized amounts and on schedule/);
  });

  it("input sensitivity — flipping inputs flips the rendered body", () => {
    const baseline = buildCapitalProjectExceptionReport({
      periodLabel: "Q1 2026",
      activeProjects: [{ label: "HVAC", variance: 5_000, status: "on-track" }],
    });
    const flipped = buildCapitalProjectExceptionReport({
      periodLabel: "Q1 2026",
      activeProjects: [{ label: "HVAC", variance: -5_000, status: "over-budget" }],
    });
    expect(flipped.body).not.toBe(baseline.body);
  });
});

describe("buildCapitalProjectNotes — reactive notes generator", () => {
  it("ships 2 bullets covering the largest pending decision + the two-fund framing", () => {
    const notes = buildCapitalProjectNotes({
      largestPendingProjectLabel: "Locker Room Renovation",
      reserveBalanceLabel: "$4.82M",
      nextBoardMeetingLabel: "Q3 2026",
      statementOfActivitiesNumber: "Statement 04",
    });
    expect(notes).toHaveLength(2);
    expect(notes[0].text).toMatch(/Locker Room Renovation/);
    expect(notes[0].text).toMatch(/\$4\.82M/);
    expect(notes[0].text).toMatch(/board at the Q3 2026 meeting/);
    expect(notes[1].text).toMatch(/two-fund structure/);
    expect(notes[1].text).toMatch(/Statement 04/);
  });

  it("REGRESSION: changing the next-board-meeting label flips the bullet text", () => {
    const baseline = buildCapitalProjectNotes({
      largestPendingProjectLabel: "Locker Room Renovation",
      reserveBalanceLabel: "$4.82M",
      nextBoardMeetingLabel: "Q3 2026",
      statementOfActivitiesNumber: "Statement 04",
    });
    const flipped = buildCapitalProjectNotes({
      largestPendingProjectLabel: "Locker Room Renovation",
      reserveBalanceLabel: "$4.82M",
      nextBoardMeetingLabel: "Q1 2027",
      statementOfActivitiesNumber: "Statement 04",
    });
    expect(flipped[0].text).not.toBe(baseline[0].text);
    expect(flipped[0].text).toMatch(/board at the Q1 2027 meeting/);
  });
});

describe("buildSilverSpringsCapitalProjectTracker — service contract", () => {
  it("ships the Saguaro header chrome — period flows from ReportingPeriod (no Q1/March hardcodes)", () => {
    const cpt = buildSilverSpringsCapitalProjectTracker(SEED_OPTS);
    expect(cpt.eyebrow).toBe("Silver Springs Golf & Country Club · Capital Projects");
    expect(cpt.title).toBe("Capital Project Tracker");
    expect(cpt.periodLabel).toBe("May 2026 · For the period ended May 31, 2026 · Year to Date");
    expect(cpt.periodLabel).not.toMatch(/Q1/);
    expect(cpt.periodLabel).not.toMatch(/March/);
    expect(cpt.statementNumber).toBe("Statement 06 of 14");
    expect(cpt.documentChip).toBe("Capital Projects");
    expect(cpt.preparedFor).toBe("Finance Committee");
    expect(cpt.introNote).toMatch(/What was approved/);
  });

  it("ships all 9 column headers", () => {
    const cpt = buildSilverSpringsCapitalProjectTracker(SEED_OPTS);
    expect(cpt.columnHeaders.project).toBe("Project");
    expect(cpt.columnHeaders.authorized).toBe("Authorized");
    expect(cpt.columnHeaders.contracted).toBe("Contracted");
    expect(cpt.columnHeaders.spentYtd).toBe("Spent YTD");
    expect(cpt.columnHeaders.projectedFinal).toBe("Proj. Final");
    expect(cpt.columnHeaders.variance).toBe("Variance");
    expect(cpt.columnHeaders.percentDone).toBe("% Done");
    expect(cpt.columnHeaders.estComplete).toBe("Est. Complete");
    expect(cpt.columnHeaders.status).toBe("Status");
  });

  it("ships every Saguaro section + project row + total band", () => {
    const cpt = buildSilverSpringsCapitalProjectTracker(SEED_OPTS);
    const keys = cpt.rows.map((r) => `${r.kind}:${r.key}`);
    expect(keys).toContain("section-band:band-replacements");
    expect(keys).toContain("project:hvac-clubhouse");
    expect(keys).toContain("project:kitchen-equipment");
    expect(keys).toContain("project:golf-cart-fleet");
    expect(keys).toContain("section-band:band-improvements");
    expect(keys).toContain("project:fitness-center");
    expect(keys).toContain("project:terrace-patio");
    expect(keys).toContain("project:driving-range");
    expect(keys).toContain("section-band:band-planning");
    expect(keys).toContain("project:locker-room");
    expect(keys).toContain("commentary:locker-room-comment");
    expect(keys).toContain("total:total-authorized");
  });

  it("seeds the Saguaro reference values verbatim — projects + total", () => {
    const cpt = buildSilverSpringsCapitalProjectTracker(SEED_OPTS);
    const terrace = cpt.rows.find((r) => r.key === "terrace-patio")!.values!;
    expect(terrace.authorized).toBe(160_000);
    expect(terrace.contracted).toBe(148_000);
    expect(terrace.spentYtd).toBe(20_000);
    expect(terrace.projectedFinal).toBe(155_000);
    expect(terrace.variance).toBe(5_000);
    expect(terrace.percentDone).toBeCloseTo(0.13, 2);
    expect(terrace.estCompleteLabel).toBe("Q4 2026");

    const total = cpt.rows.find((r) => r.key === "total-authorized")!.values!;
    expect(total.authorized).toBe(1_620_000);
    expect(total.contracted).toBe(1_568_000);
    expect(total.spentYtd).toBe(620_000);
    expect(total.projectedFinal).toBe(1_615_000);
    expect(total.variance).toBe(5_000);
  });

  it("Locker Room (planning row) ships TBD values + a Planning status pill", () => {
    const cpt = buildSilverSpringsCapitalProjectTracker(SEED_OPTS);
    const locker = cpt.rows.find((r) => r.key === "locker-room")!;
    expect(locker.values!.authorized).toBe(2_800_000);
    expect(locker.values!.contracted).toBeNull();
    expect(locker.values!.spentYtd).toBeNull();
    expect(locker.values!.projectedFinal).toBeNull();
    expect(locker.projectedFinalLabel).toBe("TBD");
    expect(locker.values!.estCompleteLabel).toBe("TBD");
    expect(locker.status?.tone).toBe("planning");
  });

  it("status pills cover the 3 reference tones (on-track, pre-install, planning)", () => {
    const cpt = buildSilverSpringsCapitalProjectTracker(SEED_OPTS);
    const tones = new Set(cpt.rows.filter((r) => r.status).map((r) => r.status!.tone));
    expect(tones.has("on-track")).toBe(true);
    expect(tones.has("pre-install")).toBe(true);
    expect(tones.has("planning")).toBe(true);
  });

  it("exception report eyebrow flows from period.currentYearQuarterLabel; body cites the Terrace favourable variance", () => {
    const cpt = buildSilverSpringsCapitalProjectTracker(SEED_OPTS);
    // May 2026 → Q2 2026.
    expect(cpt.exceptionReport.eyebrow).toBe("Exception Report — Q2 2026");
    expect(cpt.exceptionReport.body).toMatch(/Terrace & Patio Renovation is tracking \$5K below authorized budget/);
  });

  it("project notes reference the next-quarter board meeting (May 2026 → Q3 2026)", () => {
    const cpt = buildSilverSpringsCapitalProjectTracker(SEED_OPTS);
    expect(cpt.projectNotes[0].text).toMatch(/board at the Q3 2026 meeting/);
    // And the cross-chapter Statement of Activities reference flows from opts.
    expect(cpt.projectNotes[1].text).toMatch(/Statement 04/);
    expect(cpt.projectNotes[0].text).toMatch(/\$4\.82M/);
  });

  it("REGRESSION: another period flip — March 2026 → Q1 eyebrow + Q2 next-meeting", () => {
    const MAR_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 2, 31)));
    const cpt = buildSilverSpringsCapitalProjectTracker({ ...SEED_OPTS, period: MAR_2026 });
    expect(cpt.periodLabel).toBe("March 2026 · For the period ended March 31, 2026 · Year to Date");
    expect(cpt.exceptionReport.eyebrow).toBe("Exception Report — Q1 2026");
    expect(cpt.projectNotes[0].text).toMatch(/board at the Q2 2026 meeting/);
  });

  it("REGRESSION: Q4 → Q1 next-year wrap (December 2026 → Q4 2026 + Q1 2027 next meeting)", () => {
    const DEC_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 11, 31)));
    const cpt = buildSilverSpringsCapitalProjectTracker({ ...SEED_OPTS, period: DEC_2026 });
    expect(cpt.exceptionReport.eyebrow).toBe("Exception Report — Q4 2026");
    expect(cpt.projectNotes[0].text).toMatch(/board at the Q1 2027 meeting/);
  });
});
