// Founder rule 2026-07-16: the COA detail page's Errors summary
// is a collapsed-by-default card that owns the Next-error
// navigation. The mapping table's sticky header no longer
// carries any error UI. The two components talk via window
// CustomEvents so the page can stay a server component.
//
// Source-contract tests across the three touched files:
//   • CoaErrorsCard.tsx       — the new compact-summary card.
//   • CoaMappingTable.tsx     — listens for the window events.
//   • [id]/page.tsx           — wires the card into the COA layout.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const CARD = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/imports/[id]/CoaErrorsCard.tsx",
  ),
  "utf8",
);
const TABLE = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/imports/[id]/CoaMappingTable.tsx",
  ),
  "utf8",
);
const PAGE = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/imports/[id]/page.tsx",
  ),
  "utf8",
);

describe("CoaErrorsCard — collapsed-by-default summary", () => {
  it("uses useState<boolean>(false) for the expanded flag (collapsed initial state)", () => {
    expect(CARD).toMatch(/useState\(false\)/);
    expect(CARD).toMatch(/const \[expanded, setExpanded\]/);
  });

  it("renders nothing when errors.length === 0 (founder rule 6)", () => {
    expect(CARD).toMatch(/if \(errors\.length === 0\) return null/);
  });

  it("compact summary always visible: error count, See error details, Next error →", () => {
    expect(CARD).toContain("error{errors.length === 1");
    expect(CARD).toContain("found");
    expect(CARD).toMatch(/See error details/);
    expect(CARD).toMatch(/Hide error details/);
    expect(CARD).toContain("Next error →");
  });

  it("'See error details' toggle controls the disclosure via aria-expanded", () => {
    expect(CARD).toMatch(/aria-expanded=\{expanded\}/);
    expect(CARD).toContain('aria-controls="coa-errors-detail-list"');
    expect(CARD).toContain('id="coa-errors-detail-list"');
  });

  it("expanded view renders the full error table with Row / Code / Column / Message", () => {
    expect(CARD).toMatch(/\{expanded && \(/);
    expect(CARD).toContain(">Row<");
    expect(CARD).toContain(">Code<");
    expect(CARD).toContain(">Column<");
    expect(CARD).toContain(">Message<");
  });

  it("each expanded row is clickable and dispatches spectre:coa-jump-to-row with the rowNumber", () => {
    expect(CARD).toMatch(/cursor-pointer/);
    expect(CARD).toMatch(/onClick=\{\(\) => jumpTo\(e\.rowNumber\)\}/);
    expect(CARD).toMatch(/new CustomEvent\("spectre:coa-jump-to-row"/);
    expect(CARD).toMatch(/detail: \{ rowNumber \}/);
  });

  it("Next-error button dispatches spectre:coa-next-error", () => {
    expect(CARD).toMatch(/new CustomEvent\("spectre:coa-next-error"\)/);
    expect(CARD).toContain('data-testid="coa-errors-next-error"');
  });

  it("exposes stable testids for every interactive control", () => {
    expect(CARD).toContain('data-testid="coa-errors-summary-card"');
    expect(CARD).toContain('data-testid="coa-errors-summary-bar"');
    expect(CARD).toContain('data-testid="coa-errors-summary-count"');
    expect(CARD).toContain('data-testid="coa-errors-toggle"');
    expect(CARD).toContain('data-testid="coa-errors-next-error"');
    expect(CARD).toContain('data-testid="coa-errors-detail-list"');
    // Per-row testid for the expanded list.
    expect(CARD).toMatch(/`coa-errors-detail-row-\$\{e\.rowNumber\}`/);
  });
});

describe("CoaMappingTable — error chip removed from sticky header; listens via window events", () => {
  it("the in-header error-summary chip is gone", () => {
    expect(TABLE).not.toContain('data-testid="coa-mapping-error-summary"');
    expect(TABLE).not.toContain('data-testid="coa-mapping-next-error"');
    expect(TABLE).not.toContain('data-testid="coa-mapping-error-count"');
  });

  it("the sticky-header progress counter remains (it's a mapping signal, not an error signal)", () => {
    expect(TABLE).toContain('data-testid="coa-mapping-progress"');
    expect(TABLE).toContain("rows fully mapped");
  });

  it("listens for both window events", () => {
    expect(TABLE).toMatch(/window\.addEventListener\("spectre:coa-next-error", onNext\)/);
    expect(TABLE).toMatch(/window\.addEventListener\("spectre:coa-jump-to-row", onJumpToRow\)/);
  });

  it("jump-to-row handler resolves rowNumber → rowId via the rows array and calls scrollToErrorRow", () => {
    expect(TABLE).toMatch(/rows\.find\(\(r\) => r\.rowNumber === detail\.rowNumber\)/);
    expect(TABLE).toMatch(/scrollToErrorRow\(row\.rowId\)/);
  });

  it("listener effect cleans up both event handlers on unmount", () => {
    expect(TABLE).toMatch(/window\.removeEventListener\("spectre:coa-next-error", onNext\)/);
    expect(TABLE).toMatch(/window\.removeEventListener\("spectre:coa-jump-to-row", onJumpToRow\)/);
  });

  it("the existing jumpToNextError function is still in place (called by the window event)", () => {
    expect(TABLE).toContain("function jumpToNextError()");
    expect(TABLE).toMatch(/onNext\(\) \{\s*jumpToNextError\(\);/);
  });
});

describe("Detail page wires CoaErrorsCard into the COA layout", () => {
  it("imports + renders <CoaErrorsCard> on the COA branch, passing the batch errors", () => {
    expect(PAGE).toContain('import { CoaErrorsCard } from "./CoaErrorsCard"');
    expect(PAGE).toContain("<CoaErrorsCard");
    expect(PAGE).toMatch(/errors=\{batch\.errors\.map\(/);
  });

  it("CoaErrorsCard sits ABOVE CoaMappingTable on the COA branch (founder rule 7)", () => {
    const cardIdx = PAGE.indexOf("<CoaErrorsCard");
    const mappingTableIdx = PAGE.indexOf("<CoaMappingTable");
    expect(cardIdx).toBeGreaterThan(0);
    expect(mappingTableIdx).toBeGreaterThan(0);
    expect(cardIdx).toBeLessThan(mappingTableIdx);
  });

  it("the legacy inline Errors-table JSX is no longer on the COA branch (only inside non-COA + Advanced disclosure)", () => {
    // The non-COA branch still renders the legacy inline table
    // (with the 'No errors.' empty-state shell). It MUST not
    // appear inside the COA branch.
    const coaStart = PAGE.indexOf("isCoa ? (");
    const coaEnd = PAGE.indexOf(") : (", coaStart);
    const coaBranch = PAGE.slice(coaStart, coaEnd);
    expect(coaBranch).not.toContain("No errors.");
    expect(coaBranch).not.toMatch(/Errors \(\{batch\.errors\.length\}\)/);
  });
});
