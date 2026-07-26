// Reactive commentary generator for the Stewardship KPI Dashboard
// "Dashboard Notes" block. Per `Reactive Commentary for Financial
// Reporting — Mandatory` in CLAUDE.md, the generator MUST branch on
// the underlying operating + capital KPI tones + reserve / PPE
// status flags so the prose changes when the data changes, and
// EVERY KPI it names must be present in the input roster (no
// hardcoded React strings, no mention of metrics that don't exist
// in the data).
//
// Output contract: TWO paragraph bullets — one operating, one
// capital. Each `text` is a complete executive paragraph composed
// of multiple sentences. The React surface stacks both as bullet
// items; reactivity rides on the paragraph composition.

import { describe, it, expect } from "vitest";

import {
  buildStewardshipDashboardNotes,
  type StewardshipDashboardNoteInputs,
  type StewardshipDashboardNoteKpi,
} from "@/lib/reporting/stewardship-dashboard-notes";

const greenOp: StewardshipDashboardNoteKpi[] = [
  { key: "dues-rev",        name: "Dues-to-Revenue Ratio",          tone: "green" },
  { key: "payroll-ratio",   name: "Payroll Ratio",                  tone: "green" },
  { key: "noi-margin",      name: "NOI Margin",                     tone: "green" },
  { key: "fb-subsidy",      name: "F&B Subsidy",                    tone: "green" },
  { key: "rounds-vs-plan",  name: "Rounds vs Plan",                 tone: "green" },
  { key: "covers-vs-plan",  name: "Covers vs Plan",                 tone: "green" },
  { key: "ar-current",      name: "AR Current %",                   tone: "green" },
  { key: "init-fee-subsidy",name: "Initiation Fee Operating Subsidy", tone: "green" },
];

const greenCap: StewardshipDashboardNoteKpi[] = [
  { key: "reserve-coverage",      name: "Reserve Coverage",          tone: "green" },
  { key: "capital-income-vs-plan",name: "Capital Income vs Plan",    tone: "green" },
  { key: "capital-spend-vs-plan", name: "Capital Spend vs Plan",     tone: "green" },
  { key: "debt-equity",           name: "Long-Term Debt-to-Equity",  tone: "green" },
  { key: "ppe-reinvestment",      name: "PPE Reinvestment",          tone: "green" },
  { key: "working-capital",       name: "Working Capital",           tone: "green" },
];

const BASE_INPUTS: StewardshipDashboardNoteInputs = {
  operatingKpis: greenOp,
  capitalKpis:   greenCap,
  reserveCoverageMeetsFloor: true,
  reserveCoveragePct: "61%",
  facBenchmarkPct: "60%",
  ppeBelowBenchmark: false,
};

describe("buildStewardshipDashboardNotes — paragraph-bullet generator", () => {
  it("returns EXACTLY TWO bullets — one operating, one capital", () => {
    const out = buildStewardshipDashboardNotes(BASE_INPUTS);
    expect(out).toHaveLength(2);
    expect(out[0].tone).toBe("operating");
    expect(out[1].tone).toBe("capital");
  });

  it("each bullet text is a complete paragraph (multiple sentences)", () => {
    const out = buildStewardshipDashboardNotes(BASE_INPUTS);
    for (const bullet of out) {
      // A complete executive paragraph has at least two sentences.
      const sentenceCount = bullet.text.split(/\. /).length;
      expect(sentenceCount, `bullet for ${bullet.tone} must have at least 2 sentences`).toBeGreaterThanOrEqual(2);
      // Paragraph ends with a period (full thought, not a fragment).
      expect(bullet.text.trim().endsWith(".")).toBe(true);
    }
  });

  it("operating paragraph — all-green branch matches the founder-approved wording", () => {
    const out = buildStewardshipDashboardNotes(BASE_INPUTS);
    const op = out.find((b) => b.tone === "operating")!;
    expect(op.text).toMatch(/The operating panel confirms the club is running close to plan/);
    expect(op.text).toMatch(/understood, authorized, or attributable to known timing factors/);
    expect(op.text).toMatch(/clean AR and strong working capital/);
  });

  it("operating paragraph — monitor branch names the amber KPI(s) in the verdict sentence", () => {
    const withAmber = greenOp.map((k) =>
      k.key === "ar-current" ? { ...k, tone: "amber" as const } : k,
    );
    const out = buildStewardshipDashboardNotes({ ...BASE_INPUTS, operatingKpis: withAmber });
    const op = out.find((b) => b.tone === "operating")!;
    expect(op.text).toMatch(/broadly on plan/);
    expect(op.text).toMatch(/AR Current %/);
    expect(op.text).toMatch(/clean AR and strong working capital/);
  });

  it("operating paragraph — action branch escalates language + names the red KPI(s)", () => {
    const withRed = greenOp.map((k) =>
      k.key === "ar-current" ? { ...k, tone: "red" as const } : k,
    );
    const out = buildStewardshipDashboardNotes({ ...BASE_INPUTS, operatingKpis: withRed });
    const op = out.find((b) => b.tone === "operating")!;
    expect(op.text).toMatch(/AR Current %/);
    expect(op.text).toMatch(/outside policy and requires board attention/);
    expect(op.text).toMatch(/structural cost growth/);
  });

  it("operating paragraph — action + monitor branches together produce a richer paragraph", () => {
    const mixed = greenOp.map((k) => {
      if (k.key === "ar-current")     return { ...k, tone: "red"   as const };
      if (k.key === "covers-vs-plan") return { ...k, tone: "amber" as const };
      return k;
    });
    const out = buildStewardshipDashboardNotes({ ...BASE_INPUTS, operatingKpis: mixed });
    const op = out.find((b) => b.tone === "operating")!;
    expect(op.text).toMatch(/AR Current %/);
    expect(op.text).toMatch(/Covers vs Plan/);
  });

  it("never names a KPI that isn't in the input roster", () => {
    const out = buildStewardshipDashboardNotes({
      ...BASE_INPUTS,
      operatingKpis: [],
      capitalKpis:   [],
    });
    const joined = out.map((b) => b.text).join("\n");
    expect(joined).not.toMatch(/AR Current %/);
    expect(joined).not.toMatch(/Payroll Ratio/);
    expect(joined).not.toMatch(/Capital Spend vs Plan/);
  });

  it("capital paragraph — at-or-above-FAC branch + refreshed-PPE branch", () => {
    const out = buildStewardshipDashboardNotes({ ...BASE_INPUTS, ppeBelowBenchmark: false });
    const cap = out.find((b) => b.tone === "capital")!;
    expect(cap.text).toMatch(/FAC 60%\+/);
    expect(cap.text).toMatch(/above the 50% benchmark/);
    expect(cap.text).toMatch(/refreshed on pace/);
  });

  it("capital paragraph — at-or-above-FAC + aging-PPE branch ships the original founder-approved long sentence", () => {
    const out = buildStewardshipDashboardNotes({ ...BASE_INPUTS, ppeBelowBenchmark: true });
    const cap = out.find((b) => b.tone === "capital")!;
    expect(cap.text).toMatch(/FAC 60%\+/);
    expect(cap.text).toMatch(/Net-to-Gross PP&E ratio is below the 50% benchmark, indicating aging assets/);
    expect(cap.text).toMatch(/argument for accelerating reserve contributions strengthens/);
    expect(cap.text).toMatch(/depreciating faster than they are being rebuilt/);
  });

  it("capital paragraph — below-FAC branch quotes the actual reserve % + recommends accelerating contributions", () => {
    const out = buildStewardshipDashboardNotes({
      ...BASE_INPUTS,
      reserveCoverageMeetsFloor: false,
      reserveCoveragePct: "54%",
    });
    const cap = out.find((b) => b.tone === "capital")!;
    expect(cap.text).toMatch(/54%/);
    expect(cap.text).toMatch(/below the FAC 60% benchmark/);
    expect(cap.text).toMatch(/accelerating reserve contributions/);
  });

  it("capital paragraph — surfaces an additional capital monitor metric by name when present", () => {
    const amberSpend = greenCap.map((k) =>
      k.key === "capital-spend-vs-plan" ? { ...k, tone: "amber" as const } : k,
    );
    const out = buildStewardshipDashboardNotes({ ...BASE_INPUTS, capitalKpis: amberSpend });
    const cap = out.find((b) => b.tone === "capital")!;
    expect(cap.text).toMatch(/Capital Spend vs Plan/);
    expect(cap.text).toMatch(/monitor range/);
  });

  it("capital paragraph — never duplicates reserve-coverage or ppe-reinvestment in the additional callout", () => {
    const flipped = greenCap.map((k) =>
      k.key === "reserve-coverage" || k.key === "ppe-reinvestment"
        ? { ...k, tone: "amber" as const }
        : k,
    );
    const out = buildStewardshipDashboardNotes({ ...BASE_INPUTS, capitalKpis: flipped });
    const cap = out.find((b) => b.tone === "capital")!;
    // Should NOT include "X also sits in monitor range" for those two
    // — their dedicated branches already speak to them.
    expect(cap.text).not.toMatch(/Reserve Coverage also sits in monitor range/);
    expect(cap.text).not.toMatch(/PPE Reinvestment also sits in monitor range/);
  });

  it("input sensitivity — flipping any KPI tone or capital flag changes the rendered paragraph", () => {
    const baseline = buildStewardshipDashboardNotes(BASE_INPUTS);
    const baselineSig = baseline.map((b) => b.text).join("\n");

    const opFlip = buildStewardshipDashboardNotes({
      ...BASE_INPUTS,
      operatingKpis: greenOp.map((k) =>
        k.key === "dues-rev" ? { ...k, tone: "red" as const } : k,
      ),
    });
    expect(opFlip.map((b) => b.text).join("\n")).not.toBe(baselineSig);

    const capFlip = buildStewardshipDashboardNotes({
      ...BASE_INPUTS,
      reserveCoverageMeetsFloor: false,
      reserveCoveragePct: "54%",
    });
    expect(capFlip.map((b) => b.text).join("\n")).not.toBe(baselineSig);

    const ppeFlip = buildStewardshipDashboardNotes({ ...BASE_INPUTS, ppeBelowBenchmark: true });
    expect(ppeFlip.map((b) => b.text).join("\n")).not.toBe(baselineSig);
  });
});
