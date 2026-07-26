// COA mapping — validation error row UX (founder spec 2026-07-06).
//
// When the server's Validate run flags one or more rows INVALID, the
// mapping table must:
//
//   1. Auto-scroll the user to the first error row (sticky-header-
//      aware so the row clears the chrome).
//   2. Flash the row red briefly so the eye lands on it.
//   3. Render an "Error" status pill + the inline error message so
//      the row never reads "Ready" while the batch carries errors.
//   4. Expose a "Next error" jump button to cycle through additional
//      error rows.
//   5. Clear the row's visual error styling as soon as the operator
//      edits any field (the server-side INVALID record persists
//      until the next Validate run — this is a UI shield while the
//      operator is mid-fix).
//   6. Reset the dirty flag on Save Mapping success.
//
// Source-contract tests (matches the repo's existing convention).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

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
const GLOBALS = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/globals.css"),
  "utf8",
);

const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/*") && !l.trim().startsWith("*"))
    .join("\n");

describe("Server validation state flows down to the mapping table", () => {
  it("page.tsx surfaces ImportRow.status + errorMessage + per-row error breakdown on every COA row", () => {
    // server status flows through as `serverStatus`.
    expect(PAGE).toMatch(/serverStatus: r\.status/);
    // top-level errorMessage from ImportRow comes through.
    expect(PAGE).toMatch(/errorMessage: r\.errorMessage \?\? null/);
    // The per-row error breakdown (code / columnName / message)
    // is computed by grouping the batch.errors by rowNumber.
    expect(PAGE).toMatch(/errorsByRowNumber/);
    expect(PAGE).toMatch(/errorCodes: errs\.map/);
  });

  it("InitialCoaRow type carries the new server-state fields", () => {
    expect(TABLE).toMatch(/serverStatus\?: string/);
    expect(TABLE).toMatch(/errorMessage\?: string \| null/);
    expect(TABLE).toMatch(/errorCodes\?: ReadonlyArray</);
  });
});

describe("Row readiness — 3-state: error / ready / incomplete", () => {
  it("mapReadiness returns 'error' when the server flagged INVALID AND operator hasn't edited", () => {
    expect(TABLE).toMatch(
      /if \(r\.serverStatus === "INVALID" && !r\.dirtySinceValidation\) return "error"/,
    );
  });

  it("the status cell renders 'Error' (not 'Ready') for invalid rows + an inline error message", () => {
    // The "Error" word appears as its own JSX child line within
    // the status pill — match it tolerant of whitespace.
    expect(TABLE).toMatch(/>\s*Error\s*</);
    // The inline message slot is testid'd per-row so e2e can find it.
    expect(TABLE).toMatch(/data-testid=\{`coa-row-\$\{row\.number\}-error-message`\}/);
    // The row's data-row-status surfaces the readiness for tests + a11y.
    expect(TABLE).toMatch(/data-row-status=\{isError \? "error" : readiness\}/);
  });

  it("editing any field other than `selected` flips dirtySinceValidation, clearing the visual error", () => {
    expect(TABLE).toMatch(/editsValue = Object\.keys\(patch\)\.some\(\(k\) => k !== "selected"\)/);
    expect(TABLE).toMatch(/dirtySinceValidation: editsValue \? true : r\.dirtySinceValidation/);
  });

  it("Save Mapping success resets dirtySinceValidation on every row", () => {
    expect(TABLE).toMatch(
      /prev\.map\(\(r\) => \(\{ \.\.\.r, selected: false, dirtySinceValidation: false \}\)\)/,
    );
  });
});

describe("Error row visual treatment — permanent red border + transient flash", () => {
  it("invalid row receives the permanent red-left-border + tint classes", () => {
    expect(TABLE).toMatch(/isError \? "bg-red-50\/60 border-l-4 border-l-red-500" : ""/);
  });

  it("scrolled-to row gets the transient pulse class", () => {
    expect(TABLE).toMatch(/isFlashing \? "animate-pulse-error" : ""/);
  });

  it("globals.css defines the spectre-pulse-error keyframe + the .animate-pulse-error utility", () => {
    expect(GLOBALS).toContain("@keyframes spectre-pulse-error");
    expect(GLOBALS).toContain(".animate-pulse-error");
    expect(GLOBALS).toContain("animation: spectre-pulse-error");
  });
});

describe("Auto-scroll + Next-error jump (sticky-header aware)", () => {
  it("scrollToErrorRow offsets by the measured sticky-header height so the row clears the chrome", () => {
    expect(TABLE).toContain("function scrollToErrorRow(rowId: string)");
    expect(TABLE).toMatch(/window\.scrollY \+ rect\.top - stickyHeaderHeight - 12/);
    expect(TABLE).toMatch(/behavior: "smooth"/);
  });

  it("auto-scrolls to the FIRST error row whenever the error set changes", () => {
    expect(TABLE).toContain("lastAutoScrollKey");
    expect(TABLE).toMatch(/errorRowIndices\[0\]/);
    expect(TABLE).toMatch(/scrollToErrorRow\(firstErrorRowId\)/);
  });

  it("Next-error button cycles through errorRowIndices (modulo length) + advances the cursor", () => {
    expect(TABLE).toContain("function jumpToNextError()");
    expect(TABLE).toMatch(/errorRowIndices\[nextErrorCursor % errorRowIndices\.length\]/);
    expect(TABLE).toMatch(/setNextErrorCursor\(\(c\) => c \+ 1\)/);
  });

  it("Next-error cursor resets when the error count changes (re-validated set)", () => {
    expect(TABLE).toMatch(/setNextErrorCursor\(0\)/);
    // Effect depends on errorRowCount.
    expect(TABLE).toMatch(/useEffect\(\(\) => \{[\s\S]+?setNextErrorCursor\(0\)[\s\S]+?\}, \[errorRowCount\]\)/);
  });

  it("mapping table's sticky header no longer carries any error UI — error summary + Next error live in CoaErrorsCard now", () => {
    // Founder rule 2026-07-16: the mapping header is reserved
    // for mapping actions only; all error nav moved to the
    // sibling Errors card.
    expect(TABLE).not.toContain('data-testid="coa-mapping-error-summary"');
    expect(TABLE).not.toContain('data-testid="coa-mapping-error-count"');
    expect(TABLE).not.toContain('data-testid="coa-mapping-next-error"');
  });

  it("mapping table still listens for the window events fired by the Errors card", () => {
    expect(TABLE).toContain('"spectre:coa-next-error"');
    expect(TABLE).toContain('"spectre:coa-jump-to-row"');
    expect(TABLE).toMatch(/window\.addEventListener\("spectre:coa-next-error"/);
    expect(TABLE).toMatch(/window\.addEventListener\("spectre:coa-jump-to-row"/);
  });

  it("flash auto-clears after ~1.6s (matches the keyframe duration)", () => {
    expect(TABLE).toMatch(/window\.setTimeout\([\s\S]+?1600\)/);
    expect(TABLE).toMatch(/setFlashRowId\(\(current\) => \(current === rowId \? null : current\)\)/);
  });
});

describe("Row refs are wired so jumps + flashes land on the right element", () => {
  it("each <tr> registers itself in rowRefs via a callback ref", () => {
    const c = codeOnly(TABLE);
    expect(c).toMatch(/rowRefs\.current\.set\(row\.rowId, el\)/);
    expect(c).toMatch(/rowRefs\.current\.delete\(row\.rowId\)/);
  });
});
