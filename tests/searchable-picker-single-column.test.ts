// Founder rule 2026-07-17: SearchablePicker is a single-column,
// modern-ERP combobox. The old key + subtitle inline columns +
// optgroup headers that crowded the popover are gone.
//
// Source-contract tests on src/components/SearchablePicker.tsx.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const PICKER = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/SearchablePicker.tsx"),
  "utf8",
);
const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/*") && !l.trim().startsWith("*"))
    .join("\n");

describe("Single-column layout", () => {
  it("each option row renders ONE label span (no key column, no subtitle column)", () => {
    const c = codeOnly(PICKER);
    // The legacy key column was a fixed-width mono span.
    expect(c).not.toMatch(/font-mono text-\[10px\] text-stone-500 w-20/);
    // The legacy subtitle was an uppercase eyebrow span.
    expect(c).not.toMatch(/opt\.subtitle && \(/);
    // The single visible label is wrapped in flex-1 + nowrap.
    expect(c).toMatch(/<span className="flex-1 whitespace-nowrap">\{opt\.label\}<\/span>/);
  });

  it("no optgroup headers render inside the popover (single flat list)", () => {
    const c = codeOnly(PICKER);
    expect(c).not.toMatch(/uppercase tracking-wide text-stone-500[\s\S]+?\{group\.label\}/);
    expect(c).not.toMatch(/filteredGroups\.map/);
  });

  it("optgroups are still ACCEPTED as input (FS Group uses them) — they just flatten for display", () => {
    expect(PICKER).toMatch(/optgroups\?: ReadonlyArray<PickerOptionGroup>/);
    expect(PICKER).toMatch(/allOptions = useMemo\(\(\) => flatten\(options, optgroups\)/);
  });
});

describe("Width / overflow — no horizontal scrollbar", () => {
  it("popover sizes to content width with an explicit max + horizontal overflow hidden", () => {
    expect(PICKER).toMatch(/w-max/);
    expect(PICKER).toMatch(/min-w-full/);
    expect(PICKER).toMatch(/max-w-\[28rem\]/);
    expect(PICKER).toMatch(/overflow-x-hidden/);
  });

  it("only a vertical scrollbar appears, and only when needed", () => {
    expect(PICKER).toMatch(/overflow-y-auto/);
    expect(PICKER).toMatch(/max-h-\[20rem\]/);
  });

  it("labels do not wrap mid-row — long names use whitespace-nowrap inside the content-sized popover", () => {
    expect(PICKER).toMatch(/whitespace-nowrap/);
  });
});

describe("Row readability — taller rows + padding + highlight states", () => {
  it("rows use py-2 + px-3.5 + text-sm (vs the prior dense py-1.5 + px-3 + text-xs)", () => {
    expect(PICKER).toMatch(/className=\{\s*"flex items-center gap-2 px-3\.5 py-2 text-sm cursor-pointer leading-tight "/);
  });

  it("active (keyboard-focused) row uses bg-club-green-50 + text-club-green-900", () => {
    expect(PICKER).toMatch(/bg-club-green-50 text-club-green-900/);
  });

  it("selected (but not active) row uses bg-stone-50 + text-stone-900", () => {
    expect(PICKER).toMatch(/isSelected\s*\? "bg-stone-50 text-stone-900 "/);
  });

  it("hover treatment falls back to bg-stone-50 when neither active nor selected", () => {
    expect(PICKER).toMatch(/text-stone-800 hover:bg-stone-50/);
  });

  it("single-select shows a checkmark on the selected row", () => {
    expect(PICKER).toMatch(/!props\.multi && isSelected && \(/);
    expect(PICKER).toMatch(/<polyline points="20 6 9 17 4 12"/);
  });
});

describe("Search box + filtering", () => {
  it("search input sits at the top of the popover with a stable testid", () => {
    expect(PICKER).toMatch(/data-testid=\{`\$\{testid\}-search`\}/);
    expect(PICKER).toMatch(/placeholder=\{searchPlaceholder\}/);
  });

  it("filter is case-insensitive substring on label / key / subtitle (search-by-internal-key still works)", () => {
    expect(PICKER).toMatch(/opt\.label\.toLowerCase\(\)\.includes\(q\)/);
    expect(PICKER).toMatch(/opt\.key\?\.toLowerCase\(\)\.includes\(q\)/);
    expect(PICKER).toMatch(/opt\.subtitle\?\.toLowerCase\(\)\.includes\(q\)/);
  });
});

describe("Keyboard nav + scroll-to-active", () => {
  it("ArrowDown / ArrowUp move the active index inside the visible list", () => {
    expect(PICKER).toMatch(/e\.key === "ArrowDown"/);
    expect(PICKER).toMatch(/e\.key === "ArrowUp"/);
    expect(PICKER).toMatch(/setActiveIndex\(\(i\) => Math\.min\(visibleOptions\.length - 1, i \+ 1\)\)/);
    expect(PICKER).toMatch(/setActiveIndex\(\(i\) => Math\.max\(0, i - 1\)\)/);
  });

  it("Enter selects the active option; Escape closes + returns focus to the trigger", () => {
    expect(PICKER).toMatch(/e\.key === "Enter"/);
    expect(PICKER).toMatch(/e\.key === "Escape"/);
    expect(PICKER).toMatch(/setOpen\(false\);\s*triggerRef\.current\?\.focus\(\)/);
  });

  it("each option row registers a ref so keyboard movement can scroll the active row into view", () => {
    expect(PICKER).toMatch(/optionRefs = useRef<Map<string, HTMLLIElement>>/);
    expect(PICKER).toMatch(/optionRefs\.current\.set\(opt\.value, el\)/);
    expect(PICKER).toMatch(/optionRefs\.current\.delete\(opt\.value\)/);
  });

  it("the scroll-to-active effect uses scrollIntoView with block: 'nearest'", () => {
    expect(PICKER).toMatch(/node\?\.scrollIntoView\(\{ block: "nearest" \}\)/);
    expect(PICKER).toMatch(/\}, \[activeIndex, open, visibleOptions\]\)/);
  });
});

describe("Accessibility + interaction model is uniform for all four mapping controls", () => {
  it("popover has role=listbox + each option has role=option", () => {
    expect(PICKER).toMatch(/role="listbox"/);
    expect(PICKER).toMatch(/role="option"/);
  });

  it("multi-select shows checkboxes; single-select shows a checkmark — both use the same row layout", () => {
    expect(PICKER).toMatch(/props\.multi && \(/);
    expect(PICKER).toMatch(/<input\s+type="checkbox"/);
    // Same className tree wraps both modes — only the leading
    // marker differs.
    expect(PICKER).toMatch(/className=\{\s*"flex items-center gap-2 px-3\.5 py-2 text-sm cursor-pointer leading-tight "/);
  });

  it("aria-selected reflects the selection state on every option row", () => {
    expect(PICKER).toMatch(/aria-selected=\{isSelected\}/);
  });

  it("outside-click + Escape both close the popover", () => {
    expect(PICKER).toMatch(/document\.addEventListener\("mousedown"/);
    expect(PICKER).toMatch(/document\.addEventListener\("keydown"/);
  });
});
