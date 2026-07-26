import { describe, it, expect } from "vitest";
import {
  buildDepartmentNetPerformanceData,
  SILVER_SPRINGS_DEPARTMENT_INPUTS,
  SILVER_SPRINGS_DEPARTMENT_COMMENTARY,
} from "@/lib/reporting/department-net-performance";

const card = buildDepartmentNetPerformanceData(
  SILVER_SPRINGS_DEPARTMENT_INPUTS,
  SILVER_SPRINGS_DEPARTMENT_COMMENTARY,
);
const row = (key: string) => card.rows.find((r) => r.key === key)!;

describe("Department Net Performance — Silver Springs", () => {
  it("emits 9 rows in the founder-approved order", () => {
    expect(card.rows.map((r) => r.key)).toEqual([
      "golf-operations",
      "golf-course-maint",
      "fb",
      "equestrian",
      "outdoor-pursuits",
      "lodging",
      "sports-barn",
      "security",
      "spa",
    ]);
  });

  it("Golf Operations: variance = actual − budget computed by the service", () => {
    // actual −$77K, budget −$127K → variance = −77 − (−127) = +50 (favourable)
    expect(row("golf-operations").actualLabel).toBe("($77K)");
    expect(row("golf-operations").budgetLabel).toBe("($127K)");
    expect(row("golf-operations").varianceLabel).toBe("+$50K");
    expect(row("golf-operations").isFavorable).toBe(true);
    expect(row("golf-operations").variance).toBe(50_000);
  });

  it("Food & Beverage: variance unfavourable; rendered in parens", () => {
    // actual −$1,886K, budget −$1,676K → variance −210K (unfavourable)
    expect(row("fb").actualLabel).toBe("($1,886K)");
    expect(row("fb").budgetLabel).toBe("($1,676K)");
    expect(row("fb").varianceLabel).toBe("($210K)");
    expect(row("fb").isFavorable).toBe(false);
    expect(row("fb").variance).toBe(-210_000);
  });

  it("Golf Course Maintenance: $K formatter handles values > $1M with comma separators (e.g. ($2,884K))", () => {
    expect(row("golf-course-maint").actualLabel).toBe("($2,884K)");
    expect(row("golf-course-maint").budgetLabel).toBe("($2,836K)");
    expect(row("golf-course-maint").varianceLabel).toBe("($48K)");
  });

  it("Equestrian: favourable variance with '+' sign", () => {
    expect(row("equestrian").varianceLabel).toBe("+$124K");
    expect(row("equestrian").isFavorable).toBe(true);
  });

  it("Spa: zero budget formats as '$0K' (no parens / no sign)", () => {
    expect(row("spa").budgetLabel).toBe("$0K");
    expect(row("spa").actualLabel).toBe("($1K)");
    expect(row("spa").varianceLabel).toBe("($1K)");
  });

  it("Trend bar widths are proportional — the row with the largest |variance| reaches 100%", () => {
    // F&B has the largest |variance| at $210K → bar 100%.
    expect(row("fb").trendBarPct).toBe(100);
    // Golf Ops at $50K → 50/210 = 23.8 % → 24% (rounded).
    expect(row("golf-operations").trendBarPct).toBe(24);
    // Spa at $1K is the smallest → tiny bar.
    expect(row("spa").trendBarPct).toBeLessThanOrEqual(1);
  });

  it("Changing seed inputs changes the formatter output (Rule 7)", () => {
    const swapped = buildDepartmentNetPerformanceData(
      SILVER_SPRINGS_DEPARTMENT_INPUTS.map((r) =>
        r.key === "golf-operations" ? { ...r, ytdActual: -200_000 } : r,
      ),
      SILVER_SPRINGS_DEPARTMENT_COMMENTARY,
    );
    const baseline = row("golf-operations");
    const swappedRow = swapped.rows.find((r) => r.key === "golf-operations")!;
    expect(baseline.actualLabel).toBe("($77K)");
    expect(swappedRow.actualLabel).toBe("($200K)");
    // Variance flips: budget −$127K, new actual −$200K → variance −$73K → unfavourable.
    expect(swappedRow.varianceLabel).toBe("($73K)");
    expect(swappedRow.isFavorable).toBe(false);
  });

  it("Header / subtitle / pill label match the founder spec", () => {
    expect(card.title).toBe("Department Net Performance Highlights");
    expect(card.subtitle).toBe("ACTUAL VS. BUDGET YTD · NET DEPARTMENT RESULT AFTER ALL EXPENSES");
    expect(card.pillLabel).toBe("DEPT SUMMARY");
  });

  it("Commentary is passed through verbatim from the seed (mentions the F&B subsidy and Golf Course Maint cost)", () => {
    expect(card.commentary).toContain("Golf Operations and Equestrian both beat budget");
    expect(card.commentary).toContain("F&B subsidy of $1.89M");
    expect(card.commentary).toContain("Golf Course Maintenance");
    expect(card.commentary).toContain("$2.88M");
  });
});
