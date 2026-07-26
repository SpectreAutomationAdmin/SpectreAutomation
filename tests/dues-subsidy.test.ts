import { describe, it, expect } from "vitest";
import {
  buildDuesSubsidyData,
  SILVER_SPRINGS_DUES_TOTAL,
  SILVER_SPRINGS_MEMBER_COUNT,
  SILVER_SPRINGS_DUES_CATEGORIES,
} from "@/lib/reporting/dues-subsidy";

const data = buildDuesSubsidyData(
  SILVER_SPRINGS_DUES_TOTAL,
  SILVER_SPRINGS_MEMBER_COUNT,
  SILVER_SPRINGS_DUES_CATEGORIES,
);

describe("Dues Subsidy Analysis — Silver Springs", () => {
  it("emits 15 categories in the founder-approved order", () => {
    expect(data.categories.length).toBe(15);
    expect(data.categories.map((c) => c.key)).toEqual([
      "golf-course-maint", "admin", "fb-events", "lodging",
      "facilities", "marketing-realestate", "utilities", "grounds",
      "marina-outdoor", "equestrian", "property-insurance",
      "legal-audit", "security", "poa-fees", "golf-operations",
    ]);
  });

  it("percentages total 100 % (Rule 5)", () => {
    const sum = data.categories.reduce((s, c) => s + c.pct, 0);
    expect(sum).toBe(100);
  });

  it("summary line strings are computed from the totals", () => {
    // $10.38M / 253 = $41,028 → ~$41K
    expect(data.totalDuesLabel).toBe("$10.38M");
    expect(data.memberCountLabel).toBe("253 Members");
    expect(data.perMemberLabel).toBe("~$41K / member / yr");
    expect(data.totalDuesDollars).toBe(10_381_000);
    expect(data.memberCount).toBe(253);
  });

  it("each category gets a distinct restrained-palette colour (NO bright SaaS chart colours)", () => {
    // Every colour is a 7-char #RRGGBB hex.
    for (const c of data.categories) {
      expect(c.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    // No two adjacent categories share the same colour (palette is
    // contiguous).
    for (let i = 0; i + 1 < data.categories.length; i++) {
      expect(data.categories[i].color).not.toBe(data.categories[i + 1].color);
    }
    // Saguaro-style restraint — none of the obvious bright primaries.
    for (const c of data.categories) {
      expect(c.color.toLowerCase()).not.toMatch(/^#(ff|00){3}$/);   // pure black/white
      expect(c.color.toLowerCase()).not.toBe("#ff0000");             // pure red
      expect(c.color.toLowerCase()).not.toBe("#0000ff");             // pure blue
      expect(c.color.toLowerCase()).not.toBe("#00ff00");             // pure green
    }
  });

  it("arc angles are cumulative; first slice starts at 0, last slice ends at 360", () => {
    expect(data.categories[0].arcStartAngle).toBe(0);
    expect(data.categories[data.categories.length - 1].arcEndAngle).toBeCloseTo(360, 5);
    // Each slice's start matches the previous slice's end.
    for (let i = 0; i + 1 < data.categories.length; i++) {
      expect(data.categories[i + 1].arcStartAngle).toBeCloseTo(data.categories[i].arcEndAngle, 5);
    }
    // First slice (25%) sweeps 90°.
    expect(data.categories[0].arcEndAngle - data.categories[0].arcStartAngle).toBeCloseTo(90, 5);
  });

  it("changing the seed total dues changes the displayed labels", () => {
    const bumped = buildDuesSubsidyData(20_000_000, 253, SILVER_SPRINGS_DUES_CATEGORIES);
    expect(bumped.totalDuesLabel).toBe("$20.00M");
    expect(bumped.perMemberLabel).toBe("~$79K / member / yr"); // 20M / 253
  });

  it("changing the seed member count changes the per-member calculation", () => {
    const bumped = buildDuesSubsidyData(SILVER_SPRINGS_DUES_TOTAL, 500, SILVER_SPRINGS_DUES_CATEGORIES);
    expect(bumped.memberCountLabel).toBe("500 Members");
    expect(bumped.perMemberLabel).toBe("~$21K / member / yr"); // 10.38M / 500
  });

  it("Header / subtitle / pill label match the founder spec", () => {
    expect(data.title).toBe("Dues Subsidy Analysis");
    expect(data.subtitle).toBe('"WHAT DO MY CLUB DUES PAY FOR?" — ALLOCATION OF OPERATING EXPENSES');
    expect(data.pillLabel).toBe("DUES BREAKDOWN");
  });

  it("Category labels match the founder spec", () => {
    expect(data.categories[0].label).toBe("Golf Course Maint. & Staffing");
    expect(data.categories[14].label).toBe("Golf Operations & Staffing");
  });
});
