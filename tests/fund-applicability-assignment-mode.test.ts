// Founder rule 2026-07-02 v15.3 — Fund Applicability assignment
// mode + section-level select-all.
//
// Two UX corrections locked here:
//
//   1. The Fund Applicability assignment workflow (`?mode=fund`)
//      only renders Revenue + Expense accounts. Balance-sheet
//      accounts stay visible in the normal CoA grid but are
//      excluded from the assignment view (Fund Applicability is
//      a P&L concept only).
//
//   2. Each revenue / expense FS-Group section gets a section-
//      level "Select all" checkbox that ticks / unticks every
//      row in that section, with an indeterminate state when
//      partially selected. Individual row checkboxes continue to
//      work; the section master is UI-only (no submitted value).
//
// These tests are source-contract only — the section select-all
// is a client component whose indeterminate behaviour depends on
// the DOM, so its correctness is exercised in the browser. The
// contract tests below lock the wiring the DOM depends on:
//   - Only P&L types filter through the grid in fund mode.
//   - `data-section-key` is present on every fs-group section.
//   - The SectionSelectAllCheckbox client component is imported
//     and rendered in fund mode.
//   - Bulk affordances are gated behind `fundMode` so the normal
//     grid stays clean.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const coaPage = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/admin/coa/page.tsx"),
  "utf8",
);
const sectionSelectAll = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/coa/SectionSelectAllCheckbox.tsx",
  ),
  "utf8",
);
// Data Workspace Foundation v1.0 (2026-07-18) — the per-row bulk
// affordances (fund-mode checkboxes, per-section select-all, fund
// column, unmapped indicator) moved into the workspace client
// component. Source-contract assertions that used to check
// `coaPage` alone now check `coaRendered` = page.tsx + client.tsx
// so the same behavioural intent is proven wherever the rendering
// lives.
const coaClient = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/components/data-workspace/ChartOfAccountsClient.tsx",
  ),
  "utf8",
);
const coaRendered = coaPage + "\n// ---- rendered-source separator ----\n" + coaClient;

describe("v15.3 mode toggle: `?mode=fund` enters the assignment workflow", () => {
  it("SearchParams accepts a `mode` param", () => {
    expect(coaPage).toMatch(/mode\?: string;/);
  });

  it("`fundMode` is derived from `searchParams.mode === \"fund\"`", () => {
    expect(coaPage).toMatch(/const fundMode = searchParams\.mode === "fund"/);
  });

  it("Header renders the enter/exit toggle depending on fund mode", () => {
    expect(coaPage).toMatch(/data-testid="coa-fund-mode-enter"/);
    expect(coaPage).toMatch(/data-testid="coa-fund-mode-exit"/);
    // Enter link points at ?mode=fund; exit points back to base.
    expect(coaPage).toMatch(/href="\/app\/admin\/coa\?mode=fund"/);
  });

  it("Page title flips to 'Fund Applicability — Assignment' in fund mode", () => {
    expect(coaPage).toMatch(/Fund Applicability — Assignment/);
  });

  it("Review Accounts banner deep-links into fund mode (not just the fund filter)", () => {
    // Guards against regressing to `?fund=NONE` alone — the
    // reviewer must land IN the assignment workflow so the
    // bulk affordances are available.
    expect(coaPage).toMatch(/href="\/app\/admin\/coa\?mode=fund&fund=NONE"/);
  });
});

describe("v15.3 BS accounts are excluded from the fund assignment grid", () => {
  it("Grid filter drops non-P&L types when `fundMode` is true", () => {
    // The predicate reads: in fund mode, if the account type is
    // NOT revenue AND NOT expense, exclude it. This is the byte
    // that guarantees Assets / Liabilities / Equity never
    // render in the assignment workflow.
    expect(coaPage).toMatch(
      /if \(fundMode && a\.type !== "REVENUE" && a\.type !== "EXPENSE"\) return false/,
    );
  });
});

describe("v15.3 bulk affordances are gated behind fund mode", () => {
  it("Bulk fund action bar only renders when `fundMode` is true", () => {
    // Prior version rendered the bar whenever `canEdit`, cluttering
    // the normal CoA grid. Now gated behind `fundMode` too.
    expect(coaPage).toMatch(/\{canEdit && fundMode && \(\s*<form[\s\S]*?id="coa-bulk-fund-form"/);
  });

  it("Row-level bulk-select checkboxes only render in fund mode", () => {
    // In the Data Workspace, the row checkbox's `name="accountIds"`
    // and `form="coa-bulk-fund-form"` are conditionally added only
    // when the row's fund-mode branch fires — this is what makes
    // the checkbox "bulk-selectable" (i.e. it posts an account id).
    // Outside fund mode, the same DOM checkbox is a local selection
    // toggle only. The conditional spread keys off `fundMode`.
    expect(coaRendered).toMatch(/fundMode\s*\?\s*\{[\s\S]{0,100}name:\s*"accountIds"[\s\S]{0,200}form:\s*"coa-bulk-fund-form"/);
  });

  it("The row-checkbox column header is also gated by fund mode", () => {
    // The header adds an "Assign" column in fund mode with an
    // Op/Cap paired input, next to the always-present select
    // column. Presence of the fund-assign column is gated by
    // `props.fundMode && props.canEdit`.
    expect(coaRendered).toMatch(/\{props\.fundMode && props\.canEdit && <th className="fund-assign">Assign<\/th>\}/);
  });
});

describe("v15.3 section-level select-all checkbox — data wiring", () => {
  it("Every fs-group section carries a `data-section-key` attribute", () => {
    // The workspace emits one <tbody data-section-key={fsg.key}>
    // per FS Group so the SectionSelectAllCheckbox scopes its
    // querySelector to the exact section it belongs to.
    expect(coaRendered).toMatch(/data-section-key=\{fsg\.key\}/);
  });

  it("The client component is imported and rendered in fund mode only", () => {
    // The workspace client imports the legacy SectionSelectAllCheckbox
    // from its original location and renders it inside the sub-header
    // whenever the row is in fund mode with canEdit.
    expect(coaRendered).toMatch(
      /import \{ SectionSelectAllCheckbox \} from ["'@\/][^"']*SectionSelectAllCheckbox["']/,
    );
    expect(coaRendered).toMatch(
      /\{props\.fundMode && ctx\.canEdit && \(\s*<SectionSelectAllCheckbox/,
    );
    // Test-id includes the fs-group key so specs can target
    // per-section masters (e.g. Membership Revenue).
    expect(coaRendered).toMatch(
      /testId=\{`coa-fund-section-select-all-\$\{fsg\.key\}`\}/,
    );
  });

  it("The client component is a 'use client' module with the section select-all logic", () => {
    expect(sectionSelectAll).toMatch(/^"use client"/);
    // Wires master → row checkboxes and back for the indeterminate state.
    expect(sectionSelectAll).toMatch(/master\.indeterminate/);
    expect(sectionSelectAll).toMatch(/data-section-key="\$\{/);
    // The master posts nothing itself — the JSX rendering of
    // the master input has no `name=` attribute. (The string
    // `name="accountIds"` legally appears once inside the CSS
    // selector below; the JSX-level match here confirms the
    // master is UI-only.)
    const nameAttrOccurrences = (sectionSelectAll.match(/name="accountIds"/g) ?? []).length;
    // Exactly ONE occurrence — in the CSS selector — proves the
    // master JSX carries no name attribute.
    expect(nameAttrOccurrences).toBe(1);
    // Scoping query targets only the accountIds row-checkboxes.
    expect(sectionSelectAll).toMatch(
      /input\[type="checkbox"\]\[name="accountIds"\]/,
    );
    // Wired into the same form= as the row checkboxes so tab
    // order flows correctly and the master is inside the bulk form.
    expect(sectionSelectAll).toMatch(/form="coa-bulk-fund-form"/);
  });

  it("Recompute logic covers the three master states (all / none / partial)", () => {
    expect(sectionSelectAll).toMatch(/checkedCount === 0/);
    expect(sectionSelectAll).toMatch(/checkedCount === list\.length/);
    // Indeterminate branch fires on partial selection.
    expect(sectionSelectAll).toMatch(/indeterminate = true/);
  });

  it("Master click updates every row's `checked` to the master's target state", () => {
    // onMasterChange loops through the row list and forces
    // checked to match the master.
    expect(sectionSelectAll).toMatch(/for \(const el of list\) el\.checked = target/);
  });

  it("Listeners are torn down on unmount so navigating away leaves no stale handlers", () => {
    expect(sectionSelectAll).toMatch(/removeEventListener\("change", onMasterChange\)/);
    expect(sectionSelectAll).toMatch(/removeEventListener\("change", onRowChange\)/);
  });
});

// ---------------------------------------------------------------------------
// v15.3 defensive service-layer test — reasserts that BS accounts leaking
// into the bulk selection still get silently skipped at
// applyBulkFundApplicability (v15.2 covered this end-to-end; this suite
// pins that the invariant is what the founder called out under
// "Bulk assignment still skips any non-P&L accounts defensively at the
// service layer").
// ---------------------------------------------------------------------------
describe("v15.3 defensive service-layer guard — bulk skips BS accounts", () => {
  const bulkHelper = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/accounting/bulk-fund-applicability.ts"),
    "utf8",
  );
  it("Helper explicitly branches on type !== REVENUE && type !== EXPENSE and increments skippedBs", () => {
    expect(bulkHelper).toMatch(/c\.type !== "REVENUE" && c\.type !== "EXPENSE"/);
    expect(bulkHelper).toMatch(/skippedBs\+\+/);
  });
});
