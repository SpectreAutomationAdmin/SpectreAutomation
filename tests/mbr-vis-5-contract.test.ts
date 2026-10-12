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

  it("body wires every tile with componentKey tile:financial-performance:${t.key}", () => {
    expect(body).toMatch(/tile:financial-performance:\$\{t\.key\}/);
    // Each tile wrapped by the shared cloneElement-based wrapper
    // so the 3-column grid stays untouched.
    const tileBlock = body.slice(body.indexOf("stewardshipTiles.tiles.map"));
    const end = tileBlock.indexOf("</CardVisibilityWrapper>");
    expect(end).toBeGreaterThan(-1);
    const scope = tileBlock.slice(0, end + 100);
    expect(scope).toMatch(/<CardVisibilityWrapper/);
    expect(scope).toMatch(/<InlineCardToggle/);
    // No absolute-positioned eye on the tile — the toggle rides a
    // flex row to preserve the pre-VIS-5D geometry.
    expect(scope).toMatch(/flex items-start justify-between/);
  });
});
