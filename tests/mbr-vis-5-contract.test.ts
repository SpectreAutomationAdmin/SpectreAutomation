// MBR-VIS-5 (2026-10-11) — universal component visibility + chapter
// toggle placement.
//
// Source-contract tests covering:
//
//   §A  Shared ChapterTitleToggle lives in the Shell components tree
//       and uses the shared visibility-types module.
//   §B  Shared CardVisibilityWrapper lives in the Shell components
//       tree, honours parent-child cascade, and surfaces explicit vs
//       effective visibility.
//   §C  ChapterSection in the body no longer uses absolute positioning
//       for the chapter toggle — delegates to ChapterTitleToggle.
//   §D  StewardshipScorecardCard's card toggle is now inline inside
//       the dark-green header (no `position: absolute`).
//   §E  Each of the 11 top-level chapter panels IV-XIV is wrapped in
//       CardVisibilityWrapper with a stable `card:<chapter>:<panel>`
//       componentKey.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const BODY = path.join(REPO, "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx");
const CHAPTER_TOGGLE = path.join(REPO, "src/components/reporting/ChapterTitleToggle.tsx");
const CARD_WRAPPER = path.join(REPO, "src/components/reporting/CardVisibilityWrapper.tsx");
const TYPES = path.join(REPO, "src/app/app/admin/reporting/monthly/visibility-types.ts");

function src(p: string): string {
  return readFileSync(p, "utf8");
}

describe("MBR-VIS-5A §A — ChapterTitleToggle is a retired no-op shell", () => {
  // The founder's VIS-5A review retired the "CHAPTER X · TITLE ·
  // VISIBLE" chip entirely.  Chapter visibility toggles now render
  // inline inside each panel's own h2 via <InlineChapterToggle>.
  // The old component is kept as a no-op for API stability so the
  // body import does not break.
  const code = src(CHAPTER_TOGGLE);

  it("exports a function that returns null", () => {
    expect(code).toMatch(/export function ChapterTitleToggle/);
    expect(code).toMatch(/return null/);
  });

  it("does not render the retired CHAPTER · TITLE · VISIBLE chip", () => {
    expect(code).not.toMatch(/data-testid={`chapter-title-toggle-/);
    expect(code).not.toMatch(/Chapter \$\{chapterNumber\}/);
    expect(code).not.toMatch(/VisibilityToggle/);
  });
});

describe("MBR-VIS-5A §A1 — InlineChapterToggle is the active chapter toggle", () => {
  const INLINE_CHAPTER = path.join(REPO, "src/components/reporting/InlineChapterToggle.tsx");
  const code = src(INLINE_CHAPTER);

  it("exists and is a client component", () => {
    expect(code).toMatch(/"use client"/);
  });

  it("uses the client-side VisibilityState context + reads period from it", () => {
    expect(code).toMatch(/useVisibilityState/);
    expect(code).toMatch(/ctx\.period/);
  });

  it("renders an inline eye + Visible/Hidden text with no chip background", () => {
    expect(code).toMatch(/inline-chapter-toggle-\$\{anchorId\}/);
    expect(code).toMatch(/Hidden/);
    expect(code).toMatch(/Visible/);
    // No chip background, no border — the toggle inherits from the
    // surrounding typography.
    expect(code).not.toMatch(/bg-club-cream/);
    expect(code).not.toMatch(/\brounded\b/);
  });

  it("gates on context + period being present (returns null outside Provider)", () => {
    expect(code).toMatch(/if\s*\(!ctx\s*\|\|\s*!ctx\.period\)\s*return\s*null/);
  });
});

describe("MBR-VIS-5 §B — CardVisibilityWrapper shared component", () => {
  const code = src(CARD_WRAPPER);

  it("exists and is a client component", () => {
    expect(code).toMatch(/"use client"/);
  });

  it("honours parent-child cascade via isAncestorHidden", () => {
    expect(code).toMatch(/function isAncestorHidden/);
    expect(code).toMatch(/chapter:\$\{anchor\}/);
    expect(code).toMatch(/card:\$\{anchor\}:\$\{cardKey\}/);
  });

  it("resolves effective visibility (parent cascade honoured)", () => {
    // MBR-VIS-5C simplified: the wrapper reads effective hidden
    // from either the Provider (editing surfaces) or the server-
    // passed visibility prop (non-editing surfaces).
    expect(code).toMatch(/effectiveHidden/);
  });

  it("omits children entirely when non-editing + effectively hidden", () => {
    expect(code).toMatch(/if\s*\(!resolvedEditing\s*&&\s*effectiveHidden\)\s*return\s*null/);
  });

  it("mutes children at 0.55 opacity via cloneElement (no new DOM node)", () => {
    // MBR-VIS-5C — opacity is now injected onto the child element's
    // style via React.cloneElement, so the card's own article/section
    // root receives it.  No wrapper div exists, so flex-1 / w-full /
    // grid placement on the child are preserved exactly.
    expect(code).toMatch(/opacity:\s*\n?\s*resolvedEditing\s*&&\s*effectiveHidden\s*\?\s*0\.55/);
    expect(code).toMatch(/cloneElement/);
    expect(code).toMatch(/Children\.only/);
  });

  it("renders NO DOM wrapper node — uses React.cloneElement so the child is the layout root", () => {
    // MBR-VIS-5C — regression fix.  The prior wrapper div as a flex/
    // grid intermediate broke `flex-1` on sibling articles in the
    // Financial Performance card pairs.  The wrapper now returns
    // either `null` (hidden on non-editing) or `cloneElement(child, …)`
    // (zero new DOM nodes).
    //
    // Scope the search to the wrapper function body only (not the
    // doc-block comments at the top of the file, which legitimately
    // mention <div>).
    const fnStart = code.indexOf("export function CardVisibilityWrapper");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = code.slice(fnStart);
    expect(fnBody).not.toMatch(/<div\s/);
    expect(fnBody).not.toMatch(/<span\s/);
    expect(fnBody).toMatch(/cloneElement/);
  });
});

describe("MBR-VIS-5A §C — chapter toggle integration", () => {
  const code = src(BODY);

  it("imports InlineChapterToggle from the shared module", () => {
    expect(code).toMatch(/import\s*\{\s*InlineChapterToggle\s*\}\s*from\s*"@\/components\/reporting\/InlineChapterToggle"/);
  });

  it("ChapterSection no longer uses absolute positioning anywhere", () => {
    const sect = code.slice(code.indexOf("function ChapterSectionInner"));
    const close = sect.indexOf("export function MonthlyReportingPackageBody");
    const body = sect.slice(0, close);
    expect(body).not.toMatch(/data-testid={`chapter-toggle-wrap/);
    expect(body).not.toMatch(/position:\s*"absolute"/);
  });

  it("each of the 11 single-component panels mounts <InlineChapterToggle> in its h2", () => {
    const panels: Array<{ title: string; anchorId: string }> = [
      { title: "soa", anchorId: "statement-of-activities" },
      { title: "cf", anchorId: "capital-fund" },
      { title: "cpt", anchorId: "capital-projects" },
      { title: "sofp", anchorId: "financial-position" },
      { title: "ara", anchorId: "ar-aging" },
      { title: "os", anchorId: "operating-statistics" },
      { title: "dpl", anchorId: "departmental-p-and-l" },
      { title: "mws", anchorId: "weather-and-utilization" },
      { title: "dpa", anchorId: "payroll-analysis" },
      { title: "fbs", anchorId: "f-and-b-statistics" },
      { title: "inv", anchorId: "inventory-analysis" },
    ];
    for (const p of panels) {
      // Each panel's h2 must contain <InlineChapterToggle anchorId="…">
      expect(code).toContain(`anchorId="${p.anchorId}"`);
    }
  });

  it("the multi-component chapters II + III mount the toggle via SectionHeading props", () => {
    expect(code).toContain(`chapterAnchorId="financial-performance"`);
    expect(code).toContain(`chapterAnchorId="stewardship-dashboard"`);
  });
});

describe("MBR-VIS-5A §D — StewardshipScorecardCard uses icon-only InlineCardToggle beside title", () => {
  const code = src(BODY);

  it("the retired card-toggle-wrap chip has been removed from the dark-green header", () => {
    const card = code.slice(code.indexOf("function StewardshipScorecardCard"));
    const close = card.indexOf("\n// ============================================================================");
    const body = close > -1 ? card.slice(0, close) : card.slice(0, 5000);
    expect(body).not.toMatch(/card-toggle-wrap/);
    expect(body).not.toMatch(/cardExplicitHidden\s*\?\s*"Hidden"\s*:\s*"Visible"/);
  });

  it("mounts <InlineCardToggle> next to the scorecard title with tone='cream'", () => {
    const card = code.slice(code.indexOf("function StewardshipScorecardCard"));
    const close = card.indexOf("\n// ============================================================================");
    const body = close > -1 ? card.slice(0, close) : card.slice(0, 5000);
    expect(body).toMatch(/<InlineCardToggle/);
    expect(body).toMatch(/tone="cream"/);
  });
});

describe("MBR-VIS-5 §E — top-level chapter panels wrapped with CardVisibilityWrapper", () => {
  const code = src(BODY);

  const expectedPanels: Array<{ chapter: string; cardKey: string }> = [
    { chapter: "statement-of-activities", cardKey: "soa-panel" },
    { chapter: "capital-fund", cardKey: "capital-fund-panel" },
    { chapter: "capital-projects", cardKey: "capital-projects-panel" },
    { chapter: "financial-position", cardKey: "financial-position-panel" },
    { chapter: "ar-aging", cardKey: "ar-aging-panel" },
    { chapter: "operating-statistics", cardKey: "operating-statistics-panel" },
    { chapter: "departmental-p-and-l", cardKey: "departmental-pl-panel" },
    { chapter: "weather-and-utilization", cardKey: "weather-panel" },
    { chapter: "payroll-analysis", cardKey: "payroll-panel" },
    { chapter: "f-and-b-statistics", cardKey: "f-and-b-panel" },
    { chapter: "inventory-analysis", cardKey: "inventory-panel" },
  ];

  for (const { chapter, cardKey } of expectedPanels) {
    it(`chapter ${chapter} panel is wrapped with card:${chapter}:${cardKey}`, () => {
      expect(code).toContain(`card:${chapter}:${cardKey}`);
    });
  }

  it("CardVisibilityWrapper is imported from the shared module", () => {
    expect(code).toMatch(/import\s*\{\s*CardVisibilityWrapper\s*\}\s*from\s*"@\/components\/reporting\/CardVisibilityWrapper"/);
  });
});

describe("MBR-VIS-5 §F — shared visibility-types module", () => {
  const code = src(TYPES);

  it("exports MonthlyBodyVisibilityConfig", () => {
    expect(code).toMatch(/export\s+type\s+MonthlyBodyVisibilityConfig/);
    expect(code).toMatch(/source:\s*"draft"\s*\|\s*"published"/);
    expect(code).toMatch(/entries:\s*Record<string,\s*boolean>/);
  });
});

describe("MBR-VIS-5H §N — Stewardship Dashboard component visibility", () => {
  const body = src(BODY);

  it("4 headline KPI tiles wired with tile:stewardship-dashboard:* keys", () => {
    for (const key of [
      "tile:stewardship-dashboard:active-members",
      "tile:stewardship-dashboard:attrition-ttm",
      "tile:stewardship-dashboard:entrance-fees-ytd",
      "tile:stewardship-dashboard:average-tenure",
    ]) {
      expect(body).toContain(key);
    }
    // OperatingHeadlineTile accepts the opt-in props.
    expect(body).toMatch(/componentKey\?:\s*string;\s*\n?\s*cardLabel\?:\s*string;/);
  });

  it("Membership Category Mix section + per-row keys wired", () => {
    expect(body).toContain("card:stewardship-dashboard:membership-category-mix");
    expect(body).toMatch(/row:stewardship-dashboard:membership-category-mix:\$\{row\.key\}/);
    // TOTAL ACTIVE row retains its underlying all-category meaning
    // — the row still uses `total={m.activeMembers}` and the
    // directive-mandated preservation comment is present.
    expect(body).toMatch(/TOTAL ACTIVE row retains its underlying/i);
  });

  it("Waitlist section + 2 sub-component keys wired", () => {
    expect(body).toContain("card:stewardship-dashboard:membership-waitlist");
    expect(body).toContain("tile:stewardship-dashboard:membership-waitlist-summary");
    expect(body).toContain("tile:stewardship-dashboard:membership-waitlist-aging");
  });

  it("Tenure Distribution section key wired", () => {
    expect(body).toContain("card:stewardship-dashboard:membership-tenure-distribution");
  });

  it("every Stewardship Dashboard toggle uses an inline flex header (no absolute positioning)", () => {
    // Count the inline eye-icon mountings inside the three stewardship
    // section headers — each should be inside a flex items-start
    // justify-between row to preserve the pre-VIS-5H geometry.
    const kpiBlock = body.slice(body.indexOf("stewardship-kpi-dashboard-membership-headline"));
    // The 4 OperatingHeadlineTile sites + 3 section headers = at
    // least 7 mountings referencing stewardship-dashboard keys.
    const matches = kpiBlock.match(/stewardship-dashboard/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(7);
  });
});

describe("MBR-VIS-5I §O — Operating vs. Capital Stewardship visibility", () => {
  const body = src(BODY);

  it("section wrapper + heading toggle wired under card:stewardship-dashboard:operating-vs-capital-stewardship", () => {
    expect(body).toContain("card:stewardship-dashboard:operating-vs-capital-stewardship");
    // The heading h3 must carry the InlineCardToggle inline next to
    // the "Operating vs. Capital Stewardship" title.
    const heading = body.slice(body.indexOf("stewardship-kpi-dashboard-op-vs-cap-heading"));
    const chunk = heading.slice(0, 1_200);
    expect(chunk).toContain("Operating vs. Capital Stewardship");
    expect(chunk).toContain("InlineCardToggle");
  });

  it("4 ribbon tiles wired with independent tile:stewardship-dashboard:* keys", () => {
    for (const key of [
      "tile:stewardship-dashboard:total-operating-revenue",
      "tile:stewardship-dashboard:noi-before-depreciation",
      "tile:stewardship-dashboard:capital-fund-income-ytd",
      "tile:stewardship-dashboard:reserve-coverage-ratio",
    ]) {
      expect(body).toContain(key);
    }
  });

  it("StewardshipKpiSummaryCard accepts opt-in componentKey + cardLabel + mounts the wrapper + inline toggle", () => {
    const fn = body.slice(body.indexOf("function StewardshipKpiSummaryCard"));
    const scope = fn.slice(0, 3_000);
    expect(scope).toMatch(/componentKey\?:\s*string/);
    expect(scope).toMatch(/cardLabel\?:\s*string/);
    expect(scope).toContain("InlineCardToggle");
    expect(scope).toContain("CardVisibilityWrapper");
  });

  it("Operating + Capital subsection toggles wired on the dark-green panel headers", () => {
    expect(body).toContain("card:stewardship-dashboard:operating-stewardship-subsection");
    expect(body).toContain("card:stewardship-dashboard:capital-stewardship-subsection");
    // The panel-header toggle uses the cream tone so the eye renders
    // white on the dark-green header band.
    const hdrFn = body.slice(body.indexOf("function StewardshipKpiPanelHeader"));
    const scope = hdrFn.slice(0, 2_500);
    expect(scope).toMatch(/tone="cream"/);
    expect(scope).toContain("InlineCardToggle");
  });

  it("every per-metric card is keyed under row:stewardship-dashboard:(operating|capital)-stewardship-subsection:<kpi.key>", () => {
    expect(body).toContain("row:stewardship-dashboard:operating-stewardship-subsection");
    expect(body).toContain("row:stewardship-dashboard:capital-stewardship-subsection");
    // The paired grid composes the per-metric key by concatenating
    // the prefix with the kpi key — confirm the template is present.
    expect(body).toMatch(/\$\{operating\.metricKeyPrefix\}:\$\{row\.op\.key\}/);
    expect(body).toMatch(/\$\{capital\.metricKeyPrefix\}:\$\{row\.cap\.key\}/);
  });

  it("StewardshipMetricCard accepts opt-in componentKey + cardLabel + mounts the wrapper + inline toggle", () => {
    const fn = body.slice(body.indexOf("function StewardshipMetricCard"));
    const scope = fn.slice(0, 3_500);
    expect(scope).toMatch(/componentKey\?:\s*string/);
    expect(scope).toMatch(/cardLabel\?:\s*string/);
    expect(scope).toContain("InlineCardToggle");
    expect(scope).toContain("CardVisibilityWrapper");
  });

  it("ribbon Reserve Coverage key is DISTINCT from any detailed-card capital key", () => {
    // Per the directive: a metric displayed in both the four-tile
    // ribbon AND the detailed stewardship-card list must have SEPARATE
    // visibility keys.  The ribbon tile uses tile:...:reserve-coverage-ratio;
    // the detailed capital card uses the row: prefix with the kpi's
    // key (e.g. reserve-coverage).  The two prefixes must not collide.
    expect(body).toContain("tile:stewardship-dashboard:reserve-coverage-ratio");
    expect(body).not.toContain("tile:stewardship-dashboard:reserve-coverage-ratio-row");
    // Row-tier prefix for capital metrics must exist.
    expect(body).toContain("row:stewardship-dashboard:capital-stewardship-subsection");
  });
});

describe("MBR-VIS-5F §M — Executive Opening KPI tile visibility (15 tiles)", () => {
  const body = src(BODY);
  const atAGlance = src(path.join(REPO, "src/components/reporting/AtAGlanceBlock.tsx"));

  it("AtAGlanceBlock accepts a tilePrefix prop + mounts per-tile wrapper when provided", () => {
    expect(atAGlance).toMatch(/tilePrefix\?:\s*string/);
    expect(atAGlance).toMatch(/<CardVisibilityWrapper/);
    expect(atAGlance).toMatch(/<InlineCardToggle/);
  });

  it("cover renders AtAGlanceBlock with the executive-opening at-a-glance prefix", () => {
    expect(body).toMatch(/tilePrefix="tile:executive-opening:at-a-glance"/);
  });

  it("each of the 3 briefing cards wires per-KPI componentKeys under tile:executive-opening", () => {
    expect(body).toContain("tile:executive-opening:operations-");
    expect(body).toContain("tile:executive-opening:financial-health-");
    expect(body).toContain("tile:executive-opening:capital-program-");
  });

  it("each KPI dt row is flex items-start justify-between so the inline eye lands next to the label without layout shift", () => {
    const section = body.slice(body.indexOf("cover-briefing-operations-kpis"));
    const close = section.indexOf("CapitalProgramBriefingCard");
    const scope = close > -1 ? section.slice(0, close) : section.slice(0, 10_000);
    // All three briefing cards share the dt pattern.
    expect(scope.match(/flex items-start justify-between gap-2 text-\[11px\] uppercase tracking-\[0\.18em\]/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("tile cascade works for Executive Opening via chapter:executive-opening (no card parent required)", () => {
    const vis = src(path.join(REPO, "src/lib/reporting/monthly-package-visibility.ts"));
    const resolver = vis.slice(vis.indexOf("function isAncestorHidden"));
    // The existing VIS-5D tile branch already handles chapter cascade:
    //   if (entries[`chapter:${anchor}`] === true) return true;
    // That line governs Executive Opening tiles too — no further
    // resolver change needed for VIS-5F.
    expect(resolver).toMatch(/tier\s*===\s*"tile"/);
    expect(resolver).toMatch(/entries\[`chapter:\$\{anchor\}`\]/);
  });
});

describe("MBR-VIS-5E §L — Provider mounts on EVERY surface + editing flag drives omit-vs-mute", () => {
  const vstate = src(path.join(REPO, "src/components/reporting/VisibilityState.tsx"));
  const wrapper = src(path.join(REPO, "src/components/reporting/CardVisibilityWrapper.tsx"));
  const body = src(BODY);

  it("VisibilityStateContextValue carries an `editing: boolean` field", () => {
    expect(vstate).toMatch(/editing:\s*boolean/);
  });

  it("VisibilityStateProvider accepts an `editing` prop and threads it to context", () => {
    expect(vstate).toMatch(/editing\s*=\s*false,?\s*\n/);
    expect(vstate).toMatch(/editing\s*\?:\s*boolean/);
  });

  it("body mounts the Provider UNCONDITIONALLY (no `if (editing)` gate)", () => {
    // The old `if (editing) { return <Provider>...</Provider> } return bodyInner`
    // conditional is gone.  The Provider wraps bodyInner on every path.
    expect(body).not.toMatch(/if\s*\(editing\)\s*\{\s*\n?\s*return\s*\(\s*\n?\s*<VisibilityStateProvider/);
    // And the unconditional mount explicitly passes an `editing={editing}`
    // prop so the context carries the mode flag.
    expect(body).toMatch(/<VisibilityStateProvider[\s\S]{0,400}editing=\{editing\}/);
    // Period is only set in editing mode so leaf toggles stay gated.
    expect(body).toMatch(/period=\{editing\s*\?\s*period\s*:\s*undefined\}/);
  });

  it("CardVisibilityWrapper resolvedEditing falls back to ctx.editing (not ctx != null)", () => {
    expect(wrapper).toMatch(/resolvedEditing\s*=\s*editing\s*\?\?\s*ctx\?\.editing/);
  });
});

describe("MBR-VIS-5D §K — individual Stewardship KPI tile toggles", () => {
  const body = src(BODY);
  const vis = src(path.join(REPO, "src/lib/reporting/monthly-package-visibility.ts"));
  const vstate = src(path.join(REPO, "src/components/reporting/VisibilityState.tsx"));
  const wrapper = src(path.join(REPO, "src/components/reporting/CardVisibilityWrapper.tsx"));

  it("extends COMPONENT_KEY_PATTERN to accept the `tile:` tier", () => {
    expect(vis).toMatch(/\(chapter\|card\|row\|commentary\|tile\)/);
  });

  it("server resolver cascades `tile:X:Z` from chapter:X and card:X:tile-availability", () => {
    expect(vis).toMatch(/TILE_PARENT_CARD_KEY\s*=\s*"tile-availability"/);
    const resolver = vis.slice(vis.indexOf("function isAncestorHidden"));
    expect(resolver).toMatch(/tier\s*===\s*"tile"/);
    expect(resolver).toMatch(/TILE_PARENT_CARD_KEY/);
  });

  it("client VisibilityState context mirrors the cascade", () => {
    expect(vstate).toMatch(/TILE_PARENT_CARD_KEY\s*=\s*"tile-availability"/);
    expect(vstate).toMatch(/tier\s*===\s*"tile"/);
  });

  it("client CardVisibilityWrapper cascade mirrors the server too", () => {
    expect(wrapper).toMatch(/TILE_PARENT_CARD_KEY\s*=\s*"tile-availability"/);
    expect(wrapper).toMatch(/tier\s*===\s*"tile"/);
  });

  it("Stewardship — Tile-Level Availability grid has been REMOVED from the body (VIS-5G)", () => {
    // MBR-VIS-5G retired the entire 11-tile diagnostic grid from
    // the Financial Performance chapter.  The visibility
    // infrastructure (the `tile:` tier + its cascade) is still
    // intact — the records are preserved for auditability.  But
    // the DOM render no longer exists.
    //
    // The retired title/comment strings may still appear inside
    // the VIS-5G removal comment that documents the change.  Narrow
    // each assertion to code tokens that only exist in live JSX,
    // not in free-text comments.
    expect(body).not.toMatch(/stewardshipTiles\.tiles\.map/);
    expect(body).not.toMatch(/data-testid="stewardship-tiles"/);
    expect(body).not.toMatch(/tile:financial-performance:\$\{t\.key\}/);
    // The authoritative-source panel's data-testid + its mapped
    // service fields are the sure code-only tokens.
    expect(body).not.toMatch(/data-testid="financial-performance-source-panel"/);
    expect(body).not.toMatch(/financialPerformanceAuthoritative\.revenueDisplay/);
    expect(body).not.toMatch(/financialPerformanceAuthoritative\.cogsDisplay/);
    // The reportingDataAsOfIso banner is gone — the data-testid is
    // the code-only token.
    expect(body).not.toMatch(/data-testid="board-package-data-through"/);
  });
});
