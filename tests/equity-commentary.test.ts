import { describe, it, expect } from "vitest";
import {
  buildEquityCommentary,
  classifyEquityCommentary,
  NEAR_MIN_TOLERANCE_BPS,
  type EquityCommentaryInput,
} from "@/lib/reporting/equity-commentary";

// Unit tests for the Equity Value Over Time commentary generator.
// Verifies:
//   - all four classification branches fire on the right inputs
//   - the produced prose matches the founder's requested copy
//     exactly for the Silver Springs case
//   - calendar-year format ("2018"), not FY label ("FY2018")
//   - no "Pillar" reference anywhere in any branch
//   - the boundary at the 25 bps "near-minimum" tolerance is hit on
//     both sides

const SILVER_SPRINGS: EquityCommentaryInput = {
  actualCagrBps: 740,           // 7.4%
  bestInClassCagrBps: 550,      // 5.5%
  minimumRequiredCagrBps: 350,  // 3.5%
  firstYear: "2018",
};

describe("classifyEquityCommentary", () => {
  it("classifies Silver Springs (7.4 % > 5.5 %) as above-best-in-class", () => {
    expect(classifyEquityCommentary(SILVER_SPRINGS)).toBe("above-best-in-class");
  });

  it("classifies a CAGR exactly equal to best-in-class as above-best-in-class", () => {
    expect(classifyEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 550 }))
      .toBe("above-best-in-class");
  });

  it("classifies a 1-bps shortfall to best-in-class as between-min-and-best", () => {
    expect(classifyEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 549 }))
      .toBe("between-min-and-best");
  });

  it("classifies a CAGR within 25 bps of minimum as near-minimum (above)", () => {
    expect(classifyEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 360 }))
      .toBe("near-minimum");
  });

  it("classifies a CAGR within 25 bps of minimum as near-minimum (below)", () => {
    expect(classifyEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 340 }))
      .toBe("near-minimum");
  });

  it("classifies a CAGR exactly at the minimum as near-minimum", () => {
    expect(classifyEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 350 }))
      .toBe("near-minimum");
  });

  it("classifies a CAGR at the exact 25-bps boundary as near-minimum (above)", () => {
    expect(classifyEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 350 + NEAR_MIN_TOLERANCE_BPS }))
      .toBe("near-minimum");
  });

  it("classifies a CAGR 26 bps above minimum as between-min-and-best (just past tolerance)", () => {
    expect(classifyEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 376 }))
      .toBe("between-min-and-best");
  });

  it("classifies a CAGR 26 bps below minimum as below-minimum (just past tolerance)", () => {
    expect(classifyEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 324 }))
      .toBe("below-minimum");
  });

  it("classifies a CAGR well below minimum as below-minimum", () => {
    expect(classifyEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 150 }))
      .toBe("below-minimum");
  });

  it("classifies a between case (above min by > tolerance, below best)", () => {
    expect(classifyEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 450 }))
      .toBe("between-min-and-best");
  });
});

describe("buildEquityCommentary", () => {
  it("produces the founder's exact requested sentence for Silver Springs (above-best-in-class)", () => {
    const out = buildEquityCommentary(SILVER_SPRINGS);
    expect(out).toBe(
      "Compounded annual equity growth of **7.4%** since 2018 exceeds both " +
      "the **5.5%** best-in-class benchmark and the **3.5%** minimum required " +
      "to outpace asset inflation. Clubs growing equity at less than **3.5%** " +
      "annually are falling behind replacement cost increases.",
    );
  });

  it("between-min-and-best case (4.5 % between 3.5 % floor and 5.5 % peer line)", () => {
    const out = buildEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 450 });
    expect(out).toBe(
      "Compounded annual equity growth of **4.5%** since 2018 remains above " +
      "the **3.5%** minimum required to outpace asset inflation but trails the " +
      "**5.5%** best-in-class benchmark. Equity growth remains sustainable, " +
      "though not yet at peer-leading levels.",
    );
  });

  it("near-minimum case (3.6 % — within tolerance of 3.5 % floor)", () => {
    const out = buildEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 360 });
    expect(out).toBe(
      "Compounded annual equity growth of **3.6%** since 2018 is tracking " +
      "near the **3.5%** minimum required to outpace asset inflation. The Club " +
      "is preserving equity value, but the margin of safety remains narrow.",
    );
  });

  it("below-minimum case (2.0 % — well below 3.5 %)", () => {
    const out = buildEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 200 });
    expect(out).toBe(
      "Compounded annual equity growth of **2.0%** since 2018 is below the " +
      "**3.5%** minimum required to outpace asset inflation. At this pace, " +
      "equity growth is not keeping up with replacement cost increases and warrants " +
      "Board attention.",
    );
  });

  it("commentary updates when actual CAGR changes (#2 in the founder's checklist)", () => {
    // Move the CAGR across boundaries — the prose must change branches.
    const above = buildEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 700 });
    const between = buildEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 450 });
    const near = buildEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 360 });
    const below = buildEquityCommentary({ ...SILVER_SPRINGS, actualCagrBps: 200 });

    // Each branch produces a materially different first half-sentence.
    expect(above).toContain("exceeds both");
    expect(between).toContain("remains above");
    expect(near).toContain("is tracking near");
    expect(below).toContain("is below the");

    // No two branches produce the same sentence.
    const all = new Set([above, between, near, below]);
    expect(all.size).toBe(4);
  });

  it("uses calendar year format such as '2018', not 'FY2018' (#7)", () => {
    // The founder removed the FY-prefix reference. The generator only
    // ever sees the calendar-year string the caller passes in; if any
    // branch inadvertently emits "FY" + something, this test fails.
    const cases = [
      { ...SILVER_SPRINGS, actualCagrBps: 700 },  // above
      { ...SILVER_SPRINGS, actualCagrBps: 450 },  // between
      { ...SILVER_SPRINGS, actualCagrBps: 360 },  // near
      { ...SILVER_SPRINGS, actualCagrBps: 200 },  // below
    ];
    for (const c of cases) {
      const text = buildEquityCommentary(c);
      expect(text).not.toMatch(/FY\d{2,4}/);
      expect(text).toContain(" 2018 ");
    }
  });

  it("never references pillars in any branch (#8)", () => {
    const cases = [
      { ...SILVER_SPRINGS, actualCagrBps: 700 },
      { ...SILVER_SPRINGS, actualCagrBps: 450 },
      { ...SILVER_SPRINGS, actualCagrBps: 360 },
      { ...SILVER_SPRINGS, actualCagrBps: 200 },
    ];
    for (const c of cases) {
      const text = buildEquityCommentary(c);
      expect(text.toLowerCase()).not.toContain("pillar");
    }
  });

  it("renders correct calendar year when firstYear changes (rollover scenarios)", () => {
    const out2019 = buildEquityCommentary({ ...SILVER_SPRINGS, firstYear: "2019" });
    expect(out2019).toContain(" 2019 ");
    expect(out2019).not.toContain(" 2018 ");
  });
});
