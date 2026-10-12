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

describe("MBR-VIS-5 §A — ChapterTitleToggle shared component", () => {
  const code = src(CHAPTER_TOGGLE);

  it("exists and is a client component", () => {
    expect(code).toMatch(/"use client"/);
  });

  it("imports MonthlyBodyVisibilityConfig from the shared types module", () => {
    expect(code).toMatch(/visibility-types/);
  });

  it("uses the client-side VisibilityState context", () => {
    expect(code).toMatch(/useVisibilityState/);
  });

  it("renders a chip with the chapter number + title + toggle (no absolute positioning)", () => {
    expect(code).toMatch(/data-testid={`chapter-title-toggle-\$\{anchorId\}`}/);
    expect(code).not.toMatch(/position:\s*["']absolute["']/);
    expect(code).not.toMatch(/position:\s*"absolute"/);
    expect(code).toMatch(/<VisibilityToggle/);
  });

  it("gates on editing + period being present", () => {
    expect(code).toMatch(/if\s*\(!editing\s*\|\|\s*!period\)\s*return\s*null/);
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

  it("surfaces explicit vs effective visibility distinctly", () => {
    expect(code).toMatch(/explicitHidden/);
    expect(code).toMatch(/effectiveHidden/);
  });

  it("omits children entirely when non-editing + effectively hidden", () => {
    expect(code).toMatch(/if\s*\(!editing\s*&&\s*effectiveHidden\)\s*return\s*null/);
  });

  it("mutes children at 0.55 opacity when editing + effectively hidden", () => {
    expect(code).toMatch(/opacity:\s*editing\s*&&\s*effectiveHidden\s*\?\s*0\.55\s*:\s*1/);
  });

  it("renders an inline toggle overlay by default, and skips it when renderInlineToggle=false", () => {
    expect(code).toMatch(/renderInlineToggle\s*=\s*true/);
    expect(code).toMatch(/renderInlineToggle\s*&&/);
  });
});

describe("MBR-VIS-5 §C — ChapterSection no longer uses absolute toggle positioning", () => {
  const code = src(BODY);

  it("imports ChapterTitleToggle from the shared module", () => {
    expect(code).toMatch(/import\s*\{\s*ChapterTitleToggle\s*\}\s*from\s*"@\/components\/reporting\/ChapterTitleToggle"/);
  });

  it("ChapterSectionInner mounts <ChapterTitleToggle> as its first child", () => {
    const sect = code.slice(code.indexOf("function ChapterSectionInner"));
    const close = sect.indexOf("export function MonthlyReportingPackageBody");
    const body = sect.slice(0, close);
    expect(body).toMatch(/<ChapterTitleToggle/);
  });

  it("the chapter-toggle-wrap absolute div has been removed", () => {
    const sect = code.slice(code.indexOf("function ChapterSectionInner"));
    const close = sect.indexOf("export function MonthlyReportingPackageBody");
    const body = sect.slice(0, close);
    expect(body).not.toMatch(/data-testid={`chapter-toggle-wrap/);
    // The ChapterSection body must not use position: absolute at all
    // (the inner toggle might inherit from parent via the chip).
    expect(body).not.toMatch(/position:\s*"absolute"/);
  });
});

describe("MBR-VIS-5 §D — StewardshipScorecardCard card toggle is inline (no absolute)", () => {
  const code = src(BODY);

  it("the card-toggle-wrap is now a flex child, not absolute-positioned", () => {
    const card = code.slice(code.indexOf("function StewardshipScorecardCard"));
    const close = card.indexOf("\n// ============================================================================");
    const body = close > -1 ? card.slice(0, close) : card.slice(0, 3000);
    // No absolute positioning on the card toggle wrap.
    const toggleBlock = body.slice(body.indexOf("card-toggle-wrap"), body.indexOf("card-toggle-wrap") + 800);
    expect(toggleBlock).not.toMatch(/position:\s*["']absolute["']/);
    // Lives inside an inline-flex cluster with the legend.
    expect(toggleBlock).toMatch(/inline-flex/);
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
