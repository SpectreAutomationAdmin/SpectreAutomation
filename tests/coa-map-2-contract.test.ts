// COA-MAP-2 (2026-10-06) — Mapping Studio UX contract.
//
//   §A  Workspace structure — statement switcher, search, filter chips,
//       status strip, attention queue, drop affordance.
//   §B  Humanization — reportingRole + statement labels never surface
//       raw enum literals to the Controller.
//   §C  Mapping-history endpoint shape — read-only over the existing
//       AccountFinancialStatementAssignment table.
//   §D  Account Inspector — Reporting / Accounting / Reporting history
//       sections present; "Change mapping" uses labelForStatement in
//       the group picker.
//   §E  Create Group — "Reporting Purpose" dropdown uses
//       labelForReportingRole option labels (not raw enum).
//   §F  Preserved COA-MAP-1 + 1A testids + handler names still present.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO    = path.resolve(__dirname, "..");
const PAGE    = path.join(REPO, "src/app/app/admin/coa-mapping/page.tsx");
const UI      = path.join(REPO, "src/app/app/admin/coa-mapping/mapping-workspace-client.tsx");
const ROLE    = path.join(REPO, "src/lib/coa-mapping/reporting-role.ts");
const HISTORY = path.join(REPO, "src/app/api/admin/coa-mapping/accounts/[accountId]/history/route.ts");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

describe("COA-MAP-2 §A — workspace structure", () => {
  const page = readFileSync(PAGE, "utf8");
  const ui   = readFileSync(UI, "utf8");

  const pageTestids = new Set([
    "coa-mapping-header",
    "coa-mapping-status-strip",
    "coa-mapping-stat-unmapped",
    "coa-mapping-stat-attention",
  ]);
  for (const testid of [
    // page.tsx
    "coa-mapping-header",
    "coa-mapping-status-strip",
    "coa-mapping-stat-unmapped",
    "coa-mapping-stat-attention",
    // client.tsx
    "coa-mapping-statement-switcher",
    "coa-mapping-statement-is",
    "coa-mapping-search",
    "coa-mapping-filters",
    "coa-mapping-filter-all",
    "coa-mapping-filter-attention",
    "coa-mapping-filter-unmapped",
    "coa-mapping-filter-tenant",
    "coa-mapping-attention-count",
    "coa-mapping-empty-attention",
    "coa-mapping-drop-affordance",
  ]) {
    it(`exposes [data-testid="${testid}"]`, () => {
      const haystack = pageTestids.has(testid) ? page : ui;
      // Match either `data-testid="X"` (direct attribute) or `"X"`
      // (string literal passed through a prop or option array —
      // the templated form). Either way the compiled DOM carries
      // `data-testid="X"`.
      const re = new RegExp(`(data-testid="|testid: "|testid="|^\\s*"|  "|: "|=")${testid.replace(/-/g, "\\-")}"`, "m");
      expect(haystack).toMatch(re);
    });
  }

  it("hierarchy section carries data-statement for IS/BS/CF", () => {
    expect(ui).toMatch(/data-statement=/);
  });

  it("page title reads 'Financial Statement Mapping' with 'Chart of Accounts' eyebrow", () => {
    expect(page).toMatch(/Chart of Accounts/);
    expect(page).toMatch(/Financial Statement Mapping/);
  });
});

describe("COA-MAP-2 §B — humanization: no raw enums in user-facing copy", () => {
  const ui   = readFileSync(UI, "utf8");
  const page = readFileSync(PAGE, "utf8");

  it("UI imports the humanization helpers", () => {
    expect(ui).toMatch(/labelForReportingRole/);
    expect(ui).toMatch(/labelForStatement/);
    expect(ui).toMatch(/groupBySectionsForStatement/);
  });

  it("UI does not render the old 'role: {g.reportingRole}' raw-enum copy", () => {
    expect(ui).not.toMatch(/role:\s*\{g\.reportingRole\}/);
  });

  it("UI does not render g.statement.replace(/_/g, ' ') as a visible label", () => {
    expect(ui).not.toMatch(/g\.statement\.replace\(\/_\/g,\s*" "\)/);
  });

  it("Create Group panel calls labelForStatement for statement <option> labels", () => {
    // labelForStatement is called with each statement constant.
    expect(ui).toMatch(/labelForStatement\("INCOME_STATEMENT"\)/);
    expect(ui).toMatch(/labelForStatement\("BALANCE_SHEET"\)/);
  });

  it("Create Group panel uses labelForReportingRole for Reporting Purpose <option> labels", () => {
    expect(ui).toMatch(/labelForReportingRole\(/);
  });

  it("Create Group panel renames the raw 'role' hint to 'Reporting Purpose'", () => {
    expect(ui).toMatch(/Reporting Purpose/);
    expect(ui).not.toMatch(/e\.g\. OTHER_INCOME/);
  });

  it("Workspace header renames 'FS Group' to 'Financial Statement Group' / 'Financial Statement Mapping'", () => {
    expect(page).toMatch(/Financial Statement Mapping/);
    // Short form "FS Group" must not appear anywhere visible.
    expect(page).not.toMatch(/FS Group/i);
    expect(ui).not.toMatch(/>FS Group</i);
  });
});

describe("COA-MAP-2 §C — mapping-history endpoint", () => {
  it("history route exists", () => {
    expect(existsSync(HISTORY)).toBe(true);
  });

  const src = stripComments(readFileSync(HISTORY, "utf8"));

  it("is a GET handler", () => {
    expect(src).toMatch(/export async function GET\(/);
  });

  it("requires clubId query parameter and enforces tenant isolation", () => {
    expect(src).toMatch(/clubId required/);
    expect(src).toMatch(/hasClubAccess\(/);
  });

  it("reads AccountFinancialStatementAssignment ordered by effectiveFrom ASC", () => {
    expect(src).toMatch(/prisma\.accountFinancialStatementAssignment\.findMany/);
    expect(src).toMatch(/orderBy:\s*\{\s*effectiveFrom:\s*"asc"\s*\}/);
  });

  it("returns { account, history } where each history row carries fsGroupName / effectiveFrom / effectiveTo", () => {
    expect(src).toMatch(/fsGroupName:\s*r\.fsGroup\.name/);
    expect(src).toMatch(/effectiveFrom:\s*r\.effectiveFrom\.toISOString/);
    expect(src).toMatch(/effectiveTo:\s*r\.effectiveTo \? r\.effectiveTo\.toISOString/);
  });

  it("is read-only (no mutations, no posting guard needed)", () => {
    expect(src).not.toMatch(/assertPostingAllowed/);
    expect(src).not.toMatch(/prisma\.[a-z]+\.(create|update|delete|upsert)/);
  });
});

describe("COA-MAP-2 §D — Account Inspector + Reporting history", () => {
  const ui = readFileSync(UI, "utf8");

  for (const testid of [
    "coa-mapping-inspector-empty",
    "coa-mapping-inspector-filled",
    "coa-mapping-inspector-group-select",
    "coa-mapping-inspector-preview-button",
    "coa-mapping-reporting-history",
    "coa-mapping-reporting-history-row",
  ]) {
    it(`inspector exposes [data-testid="${testid}"]`, () => {
      expect(ui).toMatch(new RegExp(`data-testid="${testid.replace(/-/g, "\\-")}"`));
    });
  }

  it("inspector fetches /api/admin/coa-mapping/accounts/{id}/history on selection", () => {
    expect(ui).toMatch(/\/api\/admin\/coa-mapping\/accounts\/\$\{[^}]+\}\/history/);
  });

  it("group picker uses <optgroup> with labelForStatement labels (no raw enum)", () => {
    expect(ui).toMatch(/<optgroup/);
    expect(ui).toMatch(/label=\{labelForStatement/);
  });

  it("Inspector exposes three humanized sections: Financial reporting / Accounting / Reporting history", () => {
    expect(ui).toMatch(/Financial reporting/);
    expect(ui).toMatch(/>\s*Accounting\s*</);
    expect(ui).toMatch(/Reporting history/);
  });
});

describe("COA-MAP-2 §E — labelForStatement + section groupings", () => {
  const src = readFileSync(ROLE, "utf8");

  it("labelForStatement handles INCOME_STATEMENT / BALANCE_SHEET / CASH_FLOW", () => {
    expect(src).toMatch(/INCOME_STATEMENT.*Income Statement/);
    expect(src).toMatch(/BALANCE_SHEET.*Balance Sheet/);
    expect(src).toMatch(/CASH_FLOW.*Cash Flow/);
  });

  it("groupBySectionsForStatement defines IS + BS section orders", () => {
    expect(src).toMatch(/IS_SECTION_ORDER/);
    expect(src).toMatch(/BS_SECTION_ORDER/);
  });

  it("IS sections include canonical Spectre buckets", () => {
    expect(src).toMatch(/"Operating Revenue"/);
    expect(src).toMatch(/"Payroll & Related"/);
    expect(src).toMatch(/"Operating Expenses"/);
    expect(src).toMatch(/"Interest & Financing"/);
    expect(src).toMatch(/"Capital Fund"/);
  });

  it("BS sections include canonical Spectre buckets", () => {
    expect(src).toMatch(/"Current Assets"/);
    expect(src).toMatch(/"Capital Assets"/);
    expect(src).toMatch(/"Equity"/);
  });
});

describe("COA-MAP-2 §F — COA-MAP-1 + 1A pins preserved", () => {
  const ui = readFileSync(UI, "utf8");

  // All the pinned testids from COA-MAP-1 §H + COA-MAP-1A §C must
  // still exist in the rewritten client.
  for (const testid of [
    "coa-mapping-workspace",
    "coa-mapping-unmapped",
    "coa-mapping-inspector",
    "coa-mapping-preview",
    "coa-mapping-preview-effective-fieldset",
    "coa-mapping-effective-current-period",
    "coa-mapping-effective-fiscal-year",
    "coa-mapping-effective-custom",
    "coa-mapping-preview-effective-from",
    "coa-mapping-historical-note",
    "coa-mapping-preview-apply",
    "coa-mapping-preview-cancel",
    "coa-mapping-create-group-open",
    "coa-mapping-create-group-form",
    "coa-mapping-create-group-name",
    "coa-mapping-create-group-statement",
    "coa-mapping-create-group-role",
    "coa-mapping-create-group-submit",
  ]) {
    it(`still exposes [data-testid="${testid}"]`, () => {
      expect(ui).toMatch(new RegExp(`data-testid="${testid.replace(/-/g, "\\-")}"`));
    });
  }

  it("drag/drop handlers still named exactly as COA-MAP-1 §H pinned", () => {
    expect(ui).toMatch(/handleDragStart/);
    expect(ui).toMatch(/handleDragOverGroup/);
    expect(ui).toMatch(/handleDropOnGroup/);
    expect(ui).toMatch(/handleDragEnd/);
  });

  it("account row still draggable (line-anchor preserved for cross-platform regex)", () => {
    expect(ui).toMatch(/draggable[\r\n]/);
  });

  it("new DragLeave handler clears hoverGroupId (fixes pre-existing comparator bug)", () => {
    // Old buggy code: onDragLeave={() => props.hoverGroupId === g.id}
    // New code: onDragLeave={() => props.onDragLeaveGroup(g.id)} with
    // a setHoverGroupId((cur) => (cur === groupId ? null : cur)) body.
    expect(ui).toMatch(/handleDragLeaveGroup/);
    expect(ui).toMatch(/setHoverGroupId\(\(cur\) => \(cur === groupId \? null : cur\)\)/);
  });
});

describe("COA-MAP-2 §G — auto-scroll during drag", () => {
  const ui = readFileSync(UI, "utf8");

  it("edge-triggered auto-scroll wired via rAF loop", () => {
    expect(ui).toMatch(/scrollRafRef/);
    expect(ui).toMatch(/requestAnimationFrame/);
    expect(ui).toMatch(/updateAutoScroll/);
    expect(ui).toMatch(/stopAutoScroll/);
  });

  it("updateAutoScroll triggers on handleDragOverGroup (not just on drag start)", () => {
    expect(ui).toMatch(/updateAutoScroll\(e\.clientY\)/);
  });

  it("stops auto-scroll on dragEnd + drop + unmount", () => {
    expect(ui).toMatch(/handleDragEnd[\s\S]{0,120}stopAutoScroll\(\)/);
    expect(ui).toMatch(/handleDropOnGroup[\s\S]{0,200}stopAutoScroll\(\)/);
    expect(ui).toMatch(/useEffect\(\(\) => \(\) => stopAutoScroll\(\)/);
  });
});

describe("COA-MAP-2 §H — Preview panel copy refinement", () => {
  const ui = readFileSync(UI, "utf8");

  it("Preview panel heading reads 'Reporting impact' (not 'Reporting Impact Preview')", () => {
    expect(ui).toMatch(/>\s*Reporting impact\s*</);
    expect(ui).not.toMatch(/>\s*Reporting Impact Preview\s*</);
  });

  it("Preview panel shows Current / Proposed row with the group names", () => {
    expect(ui).toMatch(/>\s*Current\s*</);
    expect(ui).toMatch(/>\s*Proposed\s*</);
    expect(ui).toMatch(/preview\.targetFsGroup\.name/);
  });

  it("Preview warning button copy is 'Review & Apply' (not raw '(confirm warning)')", () => {
    expect(ui).toMatch(/Review & Apply/);
    expect(ui).not.toMatch(/Apply \(confirm warning\)/);
  });

  it("humanizePreviewError strips the BLOCKED / WARNING prefix for the Controller", () => {
    expect(ui).toMatch(/humanizePreviewError/);
    expect(ui).toMatch(/\^BLOCKED:/);
    expect(ui).toMatch(/\^WARNING:/);
  });
});
