// COA-UX-2 (2026-09-29) — Inspector-workflow structural tests.
//
// Guards against regressions in the front-end restructuring:
//   * Row click drives inspector selection (separate from checkbox)
//   * Checkbox drives bulk selection
//   * Inspector edits route through the same saveCoaRowMappings pipeline
//   * The legacy CoaMappingTable is preserved as an Advanced-grid fallback
//   * The single applyInspectorEditAction respects tenant scoping + defaults reviewed=true

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");

const CTRL = readFileSync(
  path.join(REPO, "src", "app", "app", "admin", "imports", "[id]", "BulkCoaReviewControls.tsx"),
  "utf8",
);
const ACT = readFileSync(
  path.join(REPO, "src", "app", "app", "admin", "imports", "[id]", "_bulk-coa-actions.ts"),
  "utf8",
);
const PAGE = readFileSync(
  path.join(REPO, "src", "app", "app", "admin", "imports", "[id]", "page.tsx"),
  "utf8",
);

describe("COA-UX-2 · workspace structural invariants", () => {
  it("row click selects the inspector target (independent of checkbox)", () => {
    // Row's <tr onClick> sets inspectedId; the checkbox <td>
    // stopPropagation-s so its own onChange runs but doesn't
    // trigger row selection.
    expect(CTRL).toMatch(/onClick=\{\(\)\s*=>\s*setInspectedId\(r\.rowId\)\}/);
    expect(CTRL).toMatch(/onClick=\{\(e\)\s*=>\s*e\.stopPropagation\(\)\}/);
  });

  it("checkbox drives bulk selection (independent of inspector)", () => {
    // COA-UX-2b (2026-09-29): checkbox uses the standard React
    // controlled-input pattern (onChange), NOT onClick+preventDefault
    // which desynced React's checked prop from the DOM. shiftKey is
    // captured via a ref populated on mousedown/keydown so range
    // selection still works for mouse AND keyboard.
    expect(CTRL).toMatch(/toggleCheckbox\(r\.rowId, e\.target\.checked, shift\)/);
    expect(CTRL).toMatch(/function toggleCheckbox\(rowId: string, checked: boolean, shiftKey: boolean\)/);
    expect(CTRL).toMatch(/function selectAllVisible\(\)/);
    expect(CTRL).toMatch(/function clearSelection\(\)/);
  });

  it("COA-UX-2b: checkbox does NOT call preventDefault (regression guard for visual-state desync)", () => {
    // Extract only the ROW checkbox JSX block (accounts list <tbody>).
    // The header "Select All Visible" checkbox and hidden pill
    // checkboxes elsewhere are exempt from this guard.
    const rowBlock = CTRL.match(/type="checkbox"\s+checked=\{selected\.has\(r\.rowId\)\}[\s\S]*?\/>/);
    expect(rowBlock).not.toBeNull();
    const src = rowBlock ? rowBlock[0] : "";
    expect(src).not.toMatch(/preventDefault/);
    expect(src).toMatch(/onMouseDown=\{\(e\)\s*=>\s*\{\s*shiftKeyRef\.current\s*=\s*e\.shiftKey/);
    expect(src).toMatch(/onKeyDown=\{\(e\)\s*=>\s*\{\s*shiftKeyRef\.current\s*=\s*e\.shiftKey/);
    expect(src).toMatch(/onChange=\{\(e\)\s*=>\s*\{[\s\S]*?e\.target\.checked/);
  });

  it("COA-UX-2a: SHIFT-click range selection is wired via applyCheckboxToggle", () => {
    // The pure helper is exported (tested via
    // coa-ux-2a-shift-click-range.test.ts) and the component calls
    // it with the current visibleRows order — so the range respects
    // filters and current display order, not numeric account order.
    expect(CTRL).toMatch(/export function applyCheckboxToggle\(/);
    expect(CTRL).toMatch(/applyCheckboxToggle\(prev, \{[\s\S]*?visibleRowIds: visibleRows\.map/);
    // Anchor is tracked in local state and reset on plain click,
    // cleared alongside `selected` on Clear Selection.
    expect(CTRL).toMatch(/anchorId, setAnchorId/);
    expect(CTRL).toMatch(/setAnchorId\(rowId\)/);
    expect(CTRL).toMatch(/setAnchorId\(null\)/);
  });

  it("inspector edits route through applyInspectorEditAction (not a duplicate write path)", () => {
    expect(CTRL).toMatch(/applyInspectorEditAction\(/);
    expect(ACT).toMatch(/export async function applyInspectorEditAction\(/);
    // applyInspectorEditAction must call saveCoaRowMappings — no direct Account writes.
    expect(ACT).toMatch(/await saveCoaRowMappings\(principal, \{ batchId, mappings: \[merged\] \}\)/);
    expect(ACT).not.toMatch(/prisma\.account\.(create|upsert|update)/);
    expect(ACT).not.toMatch(/prisma\.accountFund\.(create|createMany)/);
  });

  it("COA-UX-2c: inspector edits route reviewed through resolveReviewedAfterMaterialEdit (§6 material-edit review reset)", () => {
    // COA-UX-2c (2026-09-30): replaced the "any edit ⇒ reviewed=true"
    // default with §6 semantics — a material edit on a previously
    // reviewed row returns it to NOT REVIEWED. Explicit reviewed
    // (Mark Reviewed / Unmark) is still honoured. First-time edits
    // of an unreviewed row still implicitly mark it reviewed.
    expect(ACT).toMatch(/resolveReviewedAfterMaterialEdit\(\{/);
    expect(ACT).toMatch(/const priorReviewed = readReviewState\(raw\)\.reviewed === true;/);
    expect(ACT).toMatch(/explicitReviewed:\s*edits\.reviewed/);
    expect(ACT).toMatch(/reviewed:\s*resolvedReviewed/);
  });

  it("bulk toolbar is contextual — only rendered when at least one row is checkbox-selected", () => {
    // `{anySelected && !props.readOnly && (` guards the amber toolbar block.
    expect(CTRL).toMatch(/\{anySelected && !props\.readOnly && \(/);
  });

  it("bulk actions preserved: dept applicability + fund applicability + dept policy + fund policy + mark reviewed", () => {
    // Contextual toolbar renders three menus (Department, Fund,
    // Policy) plus the Mark Reviewed button.
    expect(CTRL).toMatch(/BulkMenu label="Department"/);
    expect(CTRL).toMatch(/BulkMenu label="Fund"/);
    expect(CTRL).toMatch(/BulkMenu label="Policy"/);
    // Mark Reviewed button in the toolbar (distinct from the inspector's own Mark Reviewed).
    expect(CTRL).toMatch(/runBulk\(\{ kind: "MARK_REVIEWED" \}, "Mark Reviewed"\)/);
  });

  it("COA-UX-3 (2026-09-30): Advanced grid + Advanced validation details are removed from the COA import detail page (§3-4)", () => {
    // The founder's consolidated workflow is Inspector + bulk only.
    // Neither <CoaMappingTable> nor the "Advanced validation details"
    // disclosure may appear in the rendered page tree.
    expect(PAGE).not.toMatch(/<CoaMappingTable/);
    expect(PAGE).not.toMatch(/Advanced grid · full per-row mapping table/);
    expect(PAGE).not.toMatch(/Advanced validation details/);
    expect(PAGE).not.toMatch(/data-testid="advanced-validation-details"/);
  });

  it("Inspector renders sections: Classification, Department, Fund, Review (each labelled)", () => {
    expect(CTRL).toMatch(/<Section title="Classification">/);
    expect(CTRL).toMatch(/<Section title="Department">/);
    expect(CTRL).toMatch(/<Section title="Fund">/);
    expect(CTRL).toMatch(/<Section title="Review">/);
  });

  it("Inspector visually distinguishes Policy from Applicability with helper copy (§11)", () => {
    // Department Policy help text
    expect(CTRL).toMatch(/Whether transactions on this account MUST identify a Department/);
    // Department Applicability help text
    expect(CTRL).toMatch(/Which Departments MAY use this account/);
    // Same for Fund
    expect(CTRL).toMatch(/Whether transactions on this account MUST identify a Fund/);
    expect(CTRL).toMatch(/Which Funds MAY use this account/);
  });

  it("filter state travels via URL query params (survives refresh + shareable)", () => {
    expect(CTRL).toMatch(/f_conf/);
    expect(CTRL).toMatch(/f_deptpol/);
    expect(CTRL).toMatch(/f_fundpol/);
    expect(CTRL).toMatch(/f_deptapp/);
    expect(CTRL).toMatch(/f_fundapp/);
    expect(CTRL).toMatch(/f_review/);
    expect(CTRL).toMatch(/f_capital/);
    expect(CTRL).toMatch(/f_q/);
  });

  it("compact summary strip contains all key counters (§12)", () => {
    // Confidence + policy + fund keys + review + attention should each appear.
    expect(CTRL).toMatch(/conf</);
    expect(CTRL).toMatch(/dept</);
    expect(CTRL).toMatch(/fund</);
    expect(CTRL).toMatch(/reviewed</);
    expect(CTRL).toMatch(/attention</);
  });

  it("no dimensional information is lost — the row projection includes every DIM-1/2 field", () => {
    // BulkReviewRow shape must include: type, categoryKey, fsGroupKey,
    // departmentPolicy, fundPolicy, departmentApplicabilityCodes,
    // fundApplicabilityKeys, reviewed, capitalCandidate, confidence.
    for (const field of [
      "type: string",
      "categoryKey: string",
      "fsGroupKey: string",
      "departmentPolicy: DimensionPolicy",
      "fundPolicy: DimensionPolicy",
      "departmentApplicabilityCodes: string\\[\\]",
      "fundApplicabilityKeys: string\\[\\]",
      "reviewed: boolean",
      "capitalCandidate: boolean",
      "confidence: Confidence",
    ]) {
      expect(CTRL).toMatch(new RegExp(field));
    }
  });
});
