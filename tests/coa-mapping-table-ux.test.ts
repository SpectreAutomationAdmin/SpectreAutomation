// COA mapping table — bulk Apply All, searchable comboboxes, and
// info-icon tooltip contracts (founder spec 2026-07-03).
//
// Source-contract tests (matches the repo's existing convention).
// The mapping page is a heavy client component with portals,
// keyboard navigation, and async state — these tests assert on the
// component source, the helper components, and the action
// pipeline. Behaviour-test coverage of the apply logic lives in
// the resolveCoaRow / imports-coa-mapping suites already.

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
const PICKER = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/SearchablePicker.tsx"),
  "utf8",
);
const INFOTIP = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/InfoTip.tsx"),
  "utf8",
);

const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/*") && !l.trim().startsWith("*"))
    .join("\n");

describe("Bulk Actions — single Apply All button replaces the four per-field Apply buttons", () => {
  it("renders exactly ONE Apply All button (testid `coa-bulk-apply-all`)", () => {
    expect(TABLE).toMatch(/data-testid="coa-bulk-apply-all"/);
    // The button copy "Apply All" is the static JSX label.
    expect(TABLE).toContain("Apply All");
    // Exactly one bulk Apply button — the per-field Apply buttons
    // have been removed.
    const matches = TABLE.match(/data-testid="coa-bulk-[a-z]+-apply"/g);
    expect(matches).toBeNull();
  });

  it("removes the per-field Apply buttons (testids and labels)", () => {
    const c = codeOnly(TABLE);
    expect(c).not.toMatch(/coa-bulk-type-apply/);
    expect(c).not.toMatch(/coa-bulk-category-apply/);
    expect(c).not.toMatch(/coa-bulk-fsgroup-apply/);
    expect(c).not.toMatch(/coa-bulk-dept-apply/);
    expect(c).not.toMatch(/applyBulkType\(/);
    expect(c).not.toMatch(/applyBulkCategory\(/);
    expect(c).not.toMatch(/applyBulkFsGroup\(/);
    expect(c).not.toMatch(/applyBulkDepartments\(/);
  });

  it("Apply All function gates on selection + at-least-one-populated-field and emits validation messages", () => {
    expect(TABLE).toMatch(/function applyAll\(\)/);
    expect(TABLE).toMatch(/setBulkValidation\("Select at least one row above\."\)/);
    expect(TABLE).toMatch(/setBulkValidation\("Choose at least one field to apply\."\)/);
    // Live aria region for the validation message.
    expect(TABLE).toMatch(/data-testid="coa-bulk-validation"/);
    expect(TABLE).toMatch(/aria-live="polite"/);
  });

  it("applyAll respects the 'only populated fields apply' rule (blank fields are skipped)", () => {
    expect(TABLE).toMatch(/const hasType = bulkType !== ""/);
    expect(TABLE).toMatch(/const hasCategory = bulkCategory !== ""/);
    expect(TABLE).toMatch(/const hasFsGroup = bulkFsGroup !== ""/);
    expect(TABLE).toMatch(/const hasDepartments = bulkDepartments\.length > 0/);
    // Each apply branch is gated on its has-flag.
    expect(TABLE).toMatch(/if \(hasType\) \{/);
    expect(TABLE).toMatch(/if \(hasCategory && bulkCategoryDef\)/);
    expect(TABLE).toMatch(/if \(hasFsGroup\) \{/);
    expect(TABLE).toMatch(/if \(hasDepartments\) \{/);
  });

  it("applying a Type clears an incompatible row Category (so the operator notices the rebinding)", () => {
    expect(TABLE).toMatch(/if \(cat && cat\.accountType !== next\.type\) next\.categoryKey = null/);
  });
});

describe("Info icons — one beside each mapping column header", () => {
  it("renders four InfoTip instances (Type, Category, FS Group, Departments)", () => {
    for (const testid of [
      "coa-info-type",
      "coa-info-category",
      "coa-info-fsgroup",
      "coa-info-dept",
    ]) {
      expect(TABLE).toMatch(new RegExp(`testid="${testid}"`));
    }
  });

  it("each tooltip is sourced from `options.*` (live config) — not hard-coded labels", () => {
    // Type tooltip lists every entry from options.types.
    expect(TABLE).toMatch(/InfoTip[\s\S]*?coa-info-type[\s\S]*?options\.types\.map/);
    // Category tooltip from options.categories.
    expect(TABLE).toMatch(/InfoTip[\s\S]*?coa-info-category[\s\S]*?options\.categories\.map/);
    // FS Group tooltip iterates the same grouped picker structure
    // the dropdown uses.
    expect(TABLE).toMatch(/InfoTip[\s\S]*?coa-info-fsgroup[\s\S]*?fsGroupPickerGroups\.map/);
    // Departments tooltip iterates options.departments.
    expect(TABLE).toMatch(/InfoTip[\s\S]*?coa-info-dept[\s\S]*?options\.departments\.map/);
  });

  it("InfoTip renders via React portal so it escapes the sticky-header overflow context", () => {
    expect(INFOTIP).toMatch(/import \{ createPortal \} from "react-dom"/);
    // Portal target is document.body (non-greedy across the
    // multi-line createPortal call).
    expect(INFOTIP).toMatch(/createPortal\([\s\S]*?document\.body/);
    expect(INFOTIP).toMatch(/position: "fixed"/);
    // Z-index above all sticky chrome.
    expect(INFOTIP).toMatch(/zIndex: 1000/);
  });

  it("InfoTip opens on hover AND keyboard focus (accessibility)", () => {
    expect(INFOTIP).toMatch(/onMouseEnter=\{\(\) => setOpen\(true\)\}/);
    expect(INFOTIP).toMatch(/onFocus=\{\(\) => setOpen\(true\)\}/);
    expect(INFOTIP).toMatch(/e\.key === "Escape"/);
    expect(INFOTIP).toMatch(/role="tooltip"/);
  });
});

describe("SearchablePicker — replaces every native <select> + the old pill dropdown", () => {
  it("CoaMappingTable imports and uses SearchablePicker (not <select>) for all 4 mapping fields", () => {
    expect(TABLE).toMatch(
      /import \{ SearchablePicker[\s\S]*?\} from "@\/components\/SearchablePicker"/,
    );
    // The 4 bulk-bar controls + 4 row-level controls all mount it.
    expect(TABLE).toMatch(/<SearchablePicker[\s\S]+?testid="coa-bulk-type"/);
    expect(TABLE).toMatch(/<SearchablePicker[\s\S]+?testid="coa-bulk-category"/);
    expect(TABLE).toMatch(/<SearchablePicker[\s\S]+?testid="coa-bulk-fsgroup"/);
    expect(TABLE).toMatch(/<SearchablePicker[\s\S]+?multi[\s\S]+?testid="coa-bulk-dept"/);
    // Row-level (the template-literal testid hooks each row).
    expect(TABLE).toMatch(/<SearchablePicker[\s\S]+?testid=\{`coa-row-\$\{row\.number\}-type`\}/);
    expect(TABLE).toMatch(/<SearchablePicker[\s\S]+?testid=\{`coa-row-\$\{row\.number\}-category`\}/);
    expect(TABLE).toMatch(/<SearchablePicker[\s\S]+?testid=\{`coa-row-\$\{row\.number\}-fsgroup`\}/);
    expect(TABLE).toMatch(/<SearchablePicker[\s\S]+?multi[\s\S]+?testid=\{`coa-row-\$\{row\.number\}-dept`\}/);
  });

  it("removes the prior native <select> markup for Type/Category/FS Group on rows + bulk bar", () => {
    const c = codeOnly(TABLE);
    expect(c).not.toMatch(/data-testid="coa-bulk-type-select"/);
    expect(c).not.toMatch(/data-testid="coa-bulk-category-select"/);
    expect(c).not.toMatch(/data-testid="coa-bulk-fsgroup-select"/);
    expect(c).not.toMatch(/data-testid=\{`coa-row-\$\{row\.number\}-type`\}[\s\S]+?<option /);
    expect(c).not.toMatch(/data-testid=\{`coa-row-\$\{row\.number\}-fsgroup`\}[\s\S]+?<option /);
  });

  it("the prior DepartmentMultiSelect (pill popover) component is gone from this file", () => {
    expect(TABLE).not.toMatch(/function DepartmentMultiSelect\(/);
  });
});

describe("SearchablePicker — search, keyboard nav, and multi-select contract", () => {
  it("renders a search input at the top of the popover and filters by label OR key", () => {
    expect(PICKER).toMatch(/data-testid=\{`\$\{testid\}-search`\}/);
    expect(PICKER).toMatch(/function matches\(opt: PickerOption, query: string\)/);
    // Case-insensitive matching on label, key, and subtitle.
    expect(PICKER).toMatch(/opt\.label\.toLowerCase\(\)\.includes\(q\)/);
    expect(PICKER).toMatch(/opt\.key\?\.toLowerCase\(\)\.includes\(q\)/);
  });

  it("supports keyboard navigation (ArrowDown/Up + Enter to select, Escape to close)", () => {
    expect(PICKER).toMatch(/e\.key === "ArrowDown"/);
    expect(PICKER).toMatch(/e\.key === "ArrowUp"/);
    expect(PICKER).toMatch(/e\.key === "Enter"/);
    expect(PICKER).toMatch(/e\.key === "Escape"/);
  });

  it("multi-select mode renders aria-multiselectable + checkbox per option + comma-joined trigger label", () => {
    expect(PICKER).toMatch(/aria-multiselectable=\{props\.multi \? "true" : undefined\}/);
    expect(PICKER).toMatch(/type="checkbox"/);
    expect(PICKER).toMatch(/codes\.map\(\(o\) => o\.label\)\.join\(", "\)/);
  });

  it("single-select mode shows the selected label and closes on selection", () => {
    expect(PICKER).toMatch(/optionByValue\.get\(props\.value\)\?\.label/);
    expect(PICKER).toMatch(/setOpen\(false\);\s*triggerRef\.current\?\.focus\(\)/);
  });

  it("accepts optgroups as input but renders a single flat list (founder rule 2026-07-17)", () => {
    expect(PICKER).toMatch(/optgroups\?: ReadonlyArray<PickerOptionGroup>/);
    // No optgroup HEADER rendering — visibleOptions is a flat
    // filter over allOptions; group labels are never displayed
    // in the popover.
    const c = codeOnly(PICKER);
    expect(c).not.toMatch(/group\.label && \(/);
    expect(c).toMatch(/visibleOptions = useMemo\(\(\) => \{[\s\S]+?allOptions\.filter/);
  });

  it("closes on outside click and on Escape", () => {
    expect(PICKER).toMatch(/document\.addEventListener\("mousedown"/);
    expect(PICKER).toMatch(/setOpen\(false\)/);
  });
});

describe("Department selector preserves multi-select (no-zero, one, or many)", () => {
  it("bulk Departments uses SearchablePicker in multi mode (founder spec retained)", () => {
    expect(TABLE).toMatch(/<SearchablePicker\s+multi[\s\S]+?testid="coa-bulk-dept"/);
  });

  it("row Departments uses SearchablePicker in multi mode", () => {
    expect(TABLE).toMatch(/<SearchablePicker\s+multi[\s\S]+?testid=\{`coa-row-\$\{row\.number\}-dept`\}/);
  });
});
