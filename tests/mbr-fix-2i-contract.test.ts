// MBR-FIX-2I (2026-10-11) — Operating Cost Coverage donut percentage
// formatting.
//
// Pre-fix: the Chair's Dashboard Dues Subsidy legend + tooltip
// rendered `{c.pct}%`, where `c.pct` is the raw unrounded share
// (e.g. 11.386988286508837).  Live tenants showed values like
// "11.386988286508837%" in the legend.
//
// Fix pins:
//   §A  dues-subsidy.ts emits a pre-formatted `pctLabel` string on
//       every FormattedDuesCategory, computed once at the builder
//       boundary with `.toFixed(2) + "%"`.
//   §B  The React legend consumes `c.pctLabel` verbatim.  No
//       `{c.pct}%` literal remains in the chapter component.
//   §C  The DuesSubsidyDonut tooltip consumes `hovered.pctLabel`
//       verbatim.  No `{hovered.pct}%` literal remains.
//   §D  The DuesArc type declares `pctLabel: string` as a required
//       field so a future refactor cannot silently drop it.
//
// Dependency contract: buildDuesSubsidyData is the only place
// formatting is applied; all consumers (demo + live cards) inherit
// the format automatically.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO    = path.resolve(__dirname, "..");
const BUILDER = path.join(REPO, "src/lib/reporting/dues-subsidy.ts");
const CHAPTER = path.join(
  REPO,
  "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx",
);
const DONUT   = path.join(REPO, "src/components/reporting/DuesSubsidyDonut.tsx");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("MBR-FIX-2I §A — builder emits pctLabel pre-formatted at 2dp + %", () => {
  const src = readFileSync(BUILDER, "utf8");

  it("FormattedDuesCategory type declares pctLabel: string", () => {
    expect(src).toMatch(/pctLabel:\s*string/);
  });

  it("buildDuesSubsidyData sets pctLabel = `${c.pct.toFixed(2)}%`", () => {
    expect(src).toMatch(/pctLabel:\s*`\$\{c\.pct\.toFixed\(2\)\}%`/);
  });

  it("raw `pct` is preserved for arc math + reconciliation", () => {
    // Field still present on the shape — pre-formatted label does not
    // replace the numeric field.
    expect(src).toMatch(/pct:\s*c\.pct,/);
  });
});

describe("MBR-FIX-2I §B — chapter legend consumes pctLabel (no raw-pct render)", () => {
  const src = readFileSync(CHAPTER, "utf8");
  const code = stripComments(src);

  it("legend renders {c.pctLabel}", () => {
    expect(code).toMatch(/\{c\.pctLabel\}/);
  });

  it("no `{c.pct}%` literal remains in the chapter", () => {
    expect(code).not.toMatch(/\{c\.pct\}%/);
  });
});

describe("MBR-FIX-2I §C — tooltip consumes pctLabel (no raw-pct render)", () => {
  const src = readFileSync(DONUT, "utf8");
  const code = stripComments(src);

  it("tooltip renders {hovered.pctLabel}", () => {
    expect(code).toMatch(/\{hovered\.pctLabel\}/);
  });

  it("no `{hovered.pct}%` literal remains in the tooltip", () => {
    expect(code).not.toMatch(/\{hovered\.pct\}%/);
  });
});

describe("MBR-FIX-2I §D — DuesArc type carries pctLabel as a required field", () => {
  const src = readFileSync(DONUT, "utf8");

  it("DuesArc declares pctLabel: string", () => {
    const typeBlock = src.slice(src.indexOf("export type DuesArc"));
    expect(typeBlock).toMatch(/pctLabel:\s*string/);
  });
});

describe("MBR-FIX-2I §E — formatter semantics", () => {
  it("round-trip: 11.386988286508837 → '11.39%' at the builder boundary", async () => {
    const mod = await import("@/lib/reporting/dues-subsidy");
    const d = mod.buildDuesSubsidyData(1_000_000, 100, [
      { key: "a", label: "A", pct: 11.386988286508837 },
      { key: "b", label: "B (surplus)", pct: 88.613011713491163 },
    ]);
    expect(d.categories[0].pctLabel).toBe("11.39%");
    expect(d.categories[1].pctLabel).toBe("88.61%");
  });

  it("boundary values format correctly (0.00%, 100.00%)", async () => {
    const mod = await import("@/lib/reporting/dues-subsidy");
    const d = mod.buildDuesSubsidyData(1_000_000, 100, [
      { key: "a", label: "Zero", pct: 0 },
      { key: "b", label: "Hundred", pct: 100 },
    ]);
    expect(d.categories[0].pctLabel).toBe("0.00%");
    expect(d.categories[1].pctLabel).toBe("100.00%");
  });

  it("unrounded pct is preserved alongside the label", async () => {
    const mod = await import("@/lib/reporting/dues-subsidy");
    const d = mod.buildDuesSubsidyData(1_000_000, 100, [
      { key: "a", label: "A", pct: 11.386988286508837 },
    ]);
    expect(d.categories[0].pct).toBeCloseTo(11.386988286508837, 10);
  });
});
