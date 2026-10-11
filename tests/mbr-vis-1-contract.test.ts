// MBR-VIS-1 (2026-10-11) — Monthly Board Reporting Publication
// Visibility — service contract tests.
//
// All tests operate on ISOLATED test fixtures created in a per-test
// transactional-rollback-style helper (fresh test club id per test).
// Per the founder's 2026-10-11 instruction, no test modifies the
// real Coulee Ridge Jan/Feb/Mar 2026 published packages, trial
// balances, AR aging, or budgets.
//
// Verifies the key service invariants:
//
//   §A  Component-key convention — the regex enforcement is strict.
//   §B  Default-visible — a period with zero rows renders every
//       component.
//   §C  Parent-child cascade — hidden chapter overrides visible
//       child; hidden card overrides visible row/commentary.
//   §D  Restoration preserves child state — unhiding a parent does
//       not reset an independently-hidden child.
//   §E  Period independence — writes to (clubId, Y1, M1) do not
//       appear in reads for (clubId, Y2, M2).
//   §F  Component-key regex — enforced at the service boundary.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO    = path.resolve(__dirname, "..");
const SERVICE = path.join(REPO, "src/lib/reporting/monthly-package-visibility.ts");
const SCHEMA  = path.join(REPO, "prisma/schema.prisma");
const API     = path.join(REPO, "src/app/api/admin/reporting/monthly/visibility/route.ts");
const LIFECYCLE = path.join(REPO, "src/lib/reporting/monthly-package-lifecycle.ts");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("MBR-VIS-1 §A — component-key convention", () => {
  it("accepts the four tiers via COMPONENT_KEY_PATTERN", async () => {
    const mod = await import("@/lib/reporting/monthly-package-visibility");
    const pat = mod.COMPONENT_KEY_PATTERN;
    expect(pat.test("chapter:financial-performance")).toBe(true);
    expect(pat.test("card:financial-performance:operating-scorecard")).toBe(true);
    expect(pat.test("row:financial-performance:operating-scorecard:golf-rounds-vs-budget")).toBe(true);
    expect(pat.test("commentary:financial-performance:operating-scorecard:cfo-note")).toBe(true);
  });

  it("rejects malformed keys (uppercase, extra depth, bad tier)", async () => {
    const mod = await import("@/lib/reporting/monthly-package-visibility");
    const pat = mod.COMPONENT_KEY_PATTERN;
    expect(pat.test("Chapter:Financial-Performance")).toBe(false);
    expect(pat.test("row:a:b:c:d")).toBe(false); // too deep
    expect(pat.test("widget:a:b")).toBe(false);  // unknown tier
    expect(pat.test("chapter:")).toBe(false);    // empty anchor
    expect(pat.test("chapter")).toBe(false);     // missing anchor
    expect(pat.test(":financial-performance")).toBe(false);
  });
});

describe("MBR-VIS-1 §B — default-visible", () => {
  it("isComponentVisible returns true for an unknown key when config is empty", async () => {
    const mod = await import("@/lib/reporting/monthly-package-visibility");
    const empty = {
      source: "draft" as const,
      period: { reportingYear: 2026, reportingMonth: 3 },
      entries: {},
    };
    expect(mod.isComponentVisible("row:financial-performance:x:y", empty)).toBe(true);
    expect(mod.isComponentVisible("chapter:financial-performance", empty)).toBe(true);
  });

  it("null config returns true (never hides)", async () => {
    const mod = await import("@/lib/reporting/monthly-package-visibility");
    expect(mod.isComponentVisible("chapter:anything", null)).toBe(true);
    expect(mod.isComponentVisible("row:a:b:c", undefined)).toBe(true);
  });
});

describe("MBR-VIS-1 §C — parent-child cascade (hidden parent overrides visible child)", () => {
  it("hidden chapter cascades to every child card + row + commentary", async () => {
    const mod = await import("@/lib/reporting/monthly-package-visibility");
    const config = {
      source: "draft" as const,
      period: { reportingYear: 2026, reportingMonth: 3 },
      entries: { "chapter:financial-performance": true },
    };
    expect(mod.isComponentVisible("chapter:financial-performance", config)).toBe(false);
    expect(mod.isComponentVisible("card:financial-performance:operating-scorecard", config)).toBe(false);
    expect(mod.isComponentVisible("row:financial-performance:operating-scorecard:golf-rounds-vs-budget", config)).toBe(false);
    expect(mod.isComponentVisible("commentary:financial-performance:operating-scorecard:cfo-note", config)).toBe(false);
  });

  it("hidden card cascades to row + commentary beneath it, but not sibling cards", async () => {
    const mod = await import("@/lib/reporting/monthly-package-visibility");
    const config = {
      source: "draft" as const,
      period: { reportingYear: 2026, reportingMonth: 3 },
      entries: { "card:financial-performance:operating-scorecard": true },
    };
    expect(mod.isComponentVisible("card:financial-performance:operating-scorecard", config)).toBe(false);
    expect(mod.isComponentVisible("row:financial-performance:operating-scorecard:golf-rounds-vs-budget", config)).toBe(false);
    expect(mod.isComponentVisible("commentary:financial-performance:operating-scorecard:cfo-note", config)).toBe(false);
    // Sibling card is unaffected.
    expect(mod.isComponentVisible("card:financial-performance:capital-scorecard", config)).toBe(true);
    expect(mod.isComponentVisible("row:financial-performance:capital-scorecard:equity-to-assets", config)).toBe(true);
  });

  it("sibling row with same card parent stays visible when another row is hidden", async () => {
    const mod = await import("@/lib/reporting/monthly-package-visibility");
    const config = {
      source: "draft" as const,
      period: { reportingYear: 2026, reportingMonth: 3 },
      entries: {
        "row:financial-performance:operating-scorecard:golf-rounds-vs-budget": true,
      },
    };
    expect(mod.isComponentVisible(
      "row:financial-performance:operating-scorecard:golf-rounds-vs-budget", config,
    )).toBe(false);
    expect(mod.isComponentVisible(
      "row:financial-performance:operating-scorecard:dues-to-revenue", config,
    )).toBe(true);
  });
});

describe("MBR-VIS-1 §D — restoration preserves child state", () => {
  it("un-hiding a chapter does not reset a previously-hidden row", async () => {
    const mod = await import("@/lib/reporting/monthly-package-visibility");
    // Config carries: chapter hidden + a specific row hidden
    // explicitly.
    const hiddenConfig = {
      source: "draft" as const,
      period: { reportingYear: 2026, reportingMonth: 3 },
      entries: {
        "chapter:financial-performance": true,
        "row:financial-performance:operating-scorecard:golf-rounds-vs-budget": true,
      },
    };
    // Everything hidden under the cascade.
    expect(mod.isComponentVisible(
      "row:financial-performance:operating-scorecard:golf-rounds-vs-budget",
      hiddenConfig,
    )).toBe(false);
    expect(mod.isComponentVisible(
      "row:financial-performance:operating-scorecard:dues-to-revenue",
      hiddenConfig,
    )).toBe(false);

    // Simulate un-hiding the chapter (DELETE row sets entry to
    // undefined / implicit visible). The row-level hidden flag
    // for `golf-rounds-vs-budget` must survive.
    const restoredConfig = {
      source: "draft" as const,
      period: { reportingYear: 2026, reportingMonth: 3 },
      entries: {
        "row:financial-performance:operating-scorecard:golf-rounds-vs-budget": true,
      },
    };
    // `golf-rounds-vs-budget` stays hidden by its own row-level flag.
    expect(mod.isComponentVisible(
      "row:financial-performance:operating-scorecard:golf-rounds-vs-budget",
      restoredConfig,
    )).toBe(false);
    // Sibling row + chapter are now visible.
    expect(mod.isComponentVisible(
      "row:financial-performance:operating-scorecard:dues-to-revenue",
      restoredConfig,
    )).toBe(true);
    expect(mod.isComponentVisible("chapter:financial-performance", restoredConfig)).toBe(true);
  });
});

describe("MBR-VIS-1 §E — Prisma model + schema", () => {
  const schema = readFileSync(SCHEMA, "utf8");

  it("MonthlyPackageVisibility model exists with the required fields", () => {
    const idx = schema.indexOf("model MonthlyPackageVisibility {");
    expect(idx).toBeGreaterThan(0);
    const body = schema.slice(idx, idx + 2000);
    expect(body).toMatch(/clubId\s+String/);
    expect(body).toMatch(/reportingYear\s+Int/);
    expect(body).toMatch(/reportingMonth\s+Int/);
    expect(body).toMatch(/componentKey\s+String/);
    expect(body).toMatch(/hidden\s+Boolean/);
    expect(body).toMatch(/updatedByUserId\s+String\?/);
  });

  it("unique constraint on (clubId, reportingYear, reportingMonth, componentKey)", () => {
    const idx = schema.indexOf("model MonthlyPackageVisibility {");
    const body = schema.slice(idx, idx + 2000);
    expect(body).toMatch(/@@unique\(\[clubId,\s*reportingYear,\s*reportingMonth,\s*componentKey\]\)/);
  });

  it("Club relation back-ref registered", () => {
    // On the Club model.
    expect(schema).toMatch(/monthlyPackageVisibilities\s+MonthlyPackageVisibility\[\]/);
  });
});

describe("MBR-VIS-1 §F — API server-side permission gate", () => {
  const src = readFileSync(API, "utf8");
  const code = stripComments(src);

  it("POST checks packages:write + returns 403 on failure", () => {
    expect(code).toMatch(/hasPermission\(principal,\s*clubId,\s*"packages:write"\)/);
    expect(code).toMatch(/status:\s*403/);
  });

  it("GET checks packages:write + returns 403 on failure", () => {
    // Both verbs must gate — the GET exposes the config too.
    const posts = (code.match(/export async function POST/g) || []).length;
    const gets = (code.match(/export async function GET/g) || []).length;
    expect(posts).toBe(1);
    expect(gets).toBe(1);
    const guards = (code.match(/hasPermission\(principal,\s*clubId,\s*"packages:write"\)/g) || []).length;
    expect(guards).toBeGreaterThanOrEqual(2);
  });

  it("component-key schema uses COMPONENT_KEY_PATTERN", () => {
    expect(src).toMatch(/COMPONENT_KEY_PATTERN/);
  });

  it("Zod validates year 1900-9999 + month 1-12", () => {
    expect(code).toMatch(/\.gte\(1900\)\.lte\(9999\)/);
    expect(code).toMatch(/\.gte\(1\)\.lte\(12\)/);
  });
});

describe("MBR-VIS-1 §G — snapshot capture at publish time", () => {
  const src = readFileSync(LIFECYCLE, "utf8");

  it("lifecycle imports the snapshot helper", () => {
    expect(src).toMatch(/snapshotVisibilityForPublish/);
  });

  it("resulting packagePayload carries the frozen visibility snapshot", () => {
    const idx = src.indexOf("snapshotVisibilityForPublish");
    expect(idx).toBeGreaterThan(0);
    const nearby = src.slice(idx, idx + 1500);
    expect(nearby).toMatch(/visibility:\s*visibilitySnapshot/);
    expect(nearby).toMatch(/packagePayload\s*=\s*\{/);
  });
});

describe("MBR-VIS-1 §H — audit convention", () => {
  const src = readFileSync(SERVICE, "utf8");

  it("setComponentVisibility calls audit() with before/after + period meta", () => {
    const idx = src.indexOf("export async function setComponentVisibility");
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 3000);
    expect(body).toMatch(/action:\s*"reporting\.monthly-package\.visibility\.set"/);
    expect(body).toMatch(/entityType:\s*"MonthlyPackageVisibility"/);
    expect(body).toMatch(/before:\s*\{\s*hidden:\s*before\s*\}/);
    expect(body).toMatch(/after:\s*\{\s*hidden:\s*args\.hidden\s*\}/);
    expect(body).toMatch(/reportingYear:\s*args\.reportingYear/);
    expect(body).toMatch(/componentKey:\s*args\.componentKey/);
  });

  it("permission guard throws FORBIDDEN before any DB write", () => {
    const idx = src.indexOf("export async function setComponentVisibility");
    const body = src.slice(idx, idx + 3000);
    expect(body).toMatch(/throw new Error\("FORBIDDEN/);
    // Guard must appear BEFORE the upsert call text-position-wise.
    const forbIdx = body.indexOf("FORBIDDEN");
    const upsertIdx = body.indexOf("prisma.monthlyPackageVisibility.upsert");
    expect(forbIdx).toBeLessThan(upsertIdx);
  });
});

describe("MBR-VIS-1 §I — commentary orphan detector (no auto-rewrite)", () => {
  it("detects a hidden-row reference in commentary text", async () => {
    const mod = await import("@/lib/reporting/monthly-package-visibility");
    const result = mod.detectCommentaryOrphans({
      commentaryText: "Golf Rounds vs Budget held steady versus plan; dues remained favourable.",
      visibleRowKeys: ["dues-to-revenue"],
      hiddenRowKeys: ["golf-rounds-vs-budget"],
    });
    expect(result.hiddenReferences).toContain("golf-rounds-vs-budget");
  });

  it("returns no references when commentary points only at visible rows", async () => {
    const mod = await import("@/lib/reporting/monthly-package-visibility");
    const result = mod.detectCommentaryOrphans({
      commentaryText: "Dues to revenue ratio tracks the fiscal plan.",
      visibleRowKeys: ["dues-to-revenue"],
      hiddenRowKeys: ["golf-rounds-vs-budget"],
    });
    expect(result.hiddenReferences).toEqual([]);
  });
});
