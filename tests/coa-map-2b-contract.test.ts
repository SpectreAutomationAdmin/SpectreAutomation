// COA-MAP-2B (2026-10-06) — Account-List direct drag/drop mapping.
//
// This slice makes /app/admin/coa (Chart of Accounts Account List)
// a first-class entry point into the canonical mapping workflow:
//
//   §A  Shared MappingPreviewPanel component mounted by BOTH
//       surfaces — no duplicate preview UI.
//   §B  DwAccountRow carries the canonical FinancialStatementGroup.id
//       (never inferred from display text).
//   §C  Group sub-header is a drop target; carries data-fs-group-id.
//   §D  Account row has a drag handle (not the whole row) so row
//       click still opens the Inspector.
//   §E  Global window.dragover drives .spectre-dw-table-wrap
//       auto-scroll; velocity ramps with edge proximity.
//   §F  AccountListMappingDrawer calls the SAME /api/.../preview and
//       /api/.../reassign endpoints the Mapping Studio uses.
//   §G  All prior COA-MAP contracts preserved.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO    = path.resolve(__dirname, "..");
const COA_UI  = path.join(REPO, "src/components/data-workspace/ChartOfAccountsClient.tsx");
const COA_PAGE= path.join(REPO, "src/app/app/admin/coa/page.tsx");
const SHARED  = path.join(REPO, "src/components/coa-mapping/MappingPreviewPanel.tsx");
const DRAWER  = path.join(REPO, "src/components/coa-mapping/AccountListMappingDrawer.tsx");
const MAP_UI  = path.join(REPO, "src/app/app/admin/coa-mapping/mapping-workspace-client.tsx");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

describe("COA-MAP-2B §A — shared MappingPreviewPanel", () => {
  it("shared panel exists", () => expect(existsSync(SHARED)).toBe(true));

  const shared = readFileSync(SHARED, "utf8");
  it("shared panel exports MappingPreviewPanel + MappingPreviewResult type", () => {
    expect(shared).toMatch(/export function MappingPreviewPanel\(/);
    expect(shared).toMatch(/export type MappingPreviewResult = /);
  });

  const mapUi = readFileSync(MAP_UI, "utf8");
  const drawer = readFileSync(DRAWER, "utf8");

  it("Mapping Studio imports MappingPreviewPanel from the shared file", () => {
    expect(mapUi).toMatch(/import \{ MappingPreviewPanel, type MappingPreviewResult \} from "@\/components\/coa-mapping\/MappingPreviewPanel"/);
    expect(mapUi).toMatch(/<MappingPreviewPanel\s/);
  });

  it("Account List drawer also imports MappingPreviewPanel from the shared file", () => {
    expect(drawer).toMatch(/import \{\s*MappingPreviewPanel,\s*type MappingPreviewResult,\s*\} from "@\/components\/coa-mapping\/MappingPreviewPanel"/);
    expect(drawer).toMatch(/<MappingPreviewPanel\s/);
  });

  it("Mapping Studio no longer defines its own local PreviewPanel", () => {
    expect(mapUi).not.toMatch(/^function PreviewPanel\(/m);
  });
});

describe("COA-MAP-2B §B — DwAccountRow carries canonical fsGroupId", () => {
  const src = readFileSync(COA_UI, "utf8");
  const page = readFileSync(COA_PAGE, "utf8");

  it("DwAccountRow type includes fsGroupId: string | null", () => {
    expect(src).toMatch(/fsGroupId:\s*string \| null/);
  });

  it("server serializer populates fsGroupId from a.fsGroup?.id", () => {
    expect(page).toMatch(/fsGroupId:\s*a\.fsGroup\?\.id\s*\?\?\s*null/);
  });
});

describe("COA-MAP-2B §C — group sub-header is a drop target", () => {
  const src = readFileSync(COA_UI, "utf8");

  it("sub-header renders data-fs-group-id for every group tbody", () => {
    expect(src).toMatch(/data-fs-group-id=\{fsg\.id/);
  });

  it("sub-header conditionally attaches onDragOver / onDragLeave / onDrop when a mapping drag is active", () => {
    expect(src).toMatch(/onDragOver:\s*\(e:\s*React\.DragEvent\)\s*=>\s*ctx\.mapping!\.onDragOverGroup/);
    expect(src).toMatch(/onDrop:\s*\(e:\s*React\.DragEvent\)\s*=>\s*ctx\.mapping!\.onDropOnGroup/);
    expect(src).toMatch(/onDragLeave:\s*\(\)\s*=>\s*ctx\.mapping!\.onDragLeaveGroup/);
  });

  it("destination inferred from fsGroupId (never from display text / fsGroupKey / fsGroupLabel)", () => {
    expect(src).not.toMatch(/onDropOnGroup\(.*fsg\.key\)/);
    expect(src).not.toMatch(/onDropOnGroup\(.*fsg\.label\)/);
    expect(src).toMatch(/onDropOnGroup\(e,\s*fsg\.id as string\)/);
  });

  it("hovered destination exposes coa-mapping-drop-affordance 'Move here' label", () => {
    expect(src).toMatch(/data-testid="coa-mapping-drop-affordance"/);
    expect(src).toMatch(/Move here/);
  });

  it("eligible destinations are flagged with data-drop-eligible for CSS targeting", () => {
    expect(src).toMatch(/data-drop-eligible=/);
  });
});

describe("COA-MAP-2B §D — drag handle on account rows (not whole row)", () => {
  const src = readFileSync(COA_UI, "utf8");

  it("AccountRow accepts onMappingDragStart / onMappingDragEnd props", () => {
    expect(src).toMatch(/onMappingDragStart\?:\s*\(e:\s*React\.DragEvent,\s*accountId:\s*string\)\s*=>\s*void/);
    expect(src).toMatch(/onMappingDragEnd\?:\s*\(\)\s*=>\s*void/);
  });

  it("row <tr> is NOT draggable; only the handle span is", () => {
    // No `draggable` attribute on `.spectre-dw-row` <tr> itself.
    expect(src).not.toMatch(/<tr\s[^>]*className="spectre-dw-row"[^>]*draggable/);
    // Handle span has `draggable` on its own line (CRLF-portable).
    expect(src).toMatch(/<span\s*\n?\s*draggable/);
  });

  it("handle has coa-mapping-drag-handle-{accountNumber} testid", () => {
    expect(src).toMatch(/data-testid=\{`coa-mapping-drag-handle-\$\{row\.accountNumber\}`\}/);
  });

  it("handle stops propagation of click so row click still opens Inspector", () => {
    const idx = src.indexOf("coa-mapping-drag-handle");
    const near = src.slice(idx, idx + 600);
    expect(near).toMatch(/onClick=\{\(e\)\s*=>\s*e\.stopPropagation\(\)\}/);
  });

  it("handle is hidden in fundMode OR when canEdit is false", () => {
    expect(src).toMatch(/onMappingDragStart && !fundMode && canEdit/);
  });
});

describe("COA-MAP-2B §E — global window.dragover + spectre-dw-table-wrap auto-scroll", () => {
  // ChartOfAccountsClient contains a block comment somewhere that
  // makes stripComments too aggressive on this file; use raw src.
  const src = readFileSync(COA_UI, "utf8");

  it("global dragover listener mounted on window while mappingDragId is set", () => {
    expect(src).toMatch(/window\.addEventListener\("dragover"/);
    expect(src).toMatch(/if \(!mappingDragId\) return undefined/);
  });

  it("auto-scroll targets .spectre-dw-table-wrap", () => {
    expect(src).toMatch(/document\.querySelector\(["']\.spectre-dw-table-wrap["']\)/);
  });

  it("velocity ramps rather than being a constant", () => {
    expect(src).toMatch(/const maxV = 24;/);
    expect(src).toMatch(/const minV = 6;/);
    expect(src).toMatch(/const edge = 100;/);
  });

  it("rAF loop + cleanup on dragend/drop/unmount", () => {
    expect(src).toMatch(/requestAnimationFrame\(stepAutoScroll\)/);
    expect(src).toMatch(/removeEventListener\("dragover"/);
    expect(src).toMatch(/removeEventListener\("dragend"/);
    expect(src).toMatch(/removeEventListener\("drop"/);
    expect(src).toMatch(/useEffect\(\(\)\s*=>\s*\(\)\s*=>\s*stopAutoScroll\(\)/);
  });
});

describe("COA-MAP-2B §F — AccountListMappingDrawer canonical API usage", () => {
  const src = stripComments(readFileSync(DRAWER, "utf8"));

  it("drawer fetches the shared /api/admin/coa-mapping/preview endpoint", () => {
    expect(src).toMatch(/\/api\/admin\/coa-mapping\/preview/);
  });

  it("drawer applies via the shared /api/admin/coa-mapping/accounts/\\{id\\}/reassign endpoint", () => {
    expect(src).toMatch(/\/api\/admin\/coa-mapping\/accounts\/\$\{accountId\}\/reassign/);
  });

  it("drawer forwards the 409 / 422 BLOCKED / WARNING semantics", () => {
    expect(src).toMatch(/res\.status === 409/);
    expect(src).toMatch(/res\.status === 422/);
    expect(src).toMatch(/BLOCKED:/);
    expect(src).toMatch(/WARNING:/);
  });

  it("drawer passes acknowledgeWarnings so the Review & Apply retry works", () => {
    expect(src).toMatch(/acknowledgeWarnings:\s*confirmWarnings/);
  });

  it("drawer uses the SHARED MappingPreviewPanel (no second preview UI)", () => {
    expect(src).toMatch(/<MappingPreviewPanel\s/);
  });

  it("drawer has coa-mapping-drawer root testid", () => {
    expect(src).toMatch(/data-testid="coa-mapping-drawer"/);
  });

  it("drawer uses testid='coa-mapping-drawer-preview' override so Playwright can disambiguate", () => {
    expect(src).toMatch(/testid="coa-mapping-drawer-preview"/);
  });
});

describe("COA-MAP-2B §G — ChartOfAccountsClient wiring", () => {
  const src = readFileSync(COA_UI, "utf8");
  const page = readFileSync(COA_PAGE, "utf8");

  it("ChartOfAccountsClient receives clubId as a prop", () => {
    expect(src).toMatch(/clubId:\s*string;/);
    expect(page).toMatch(/<ChartOfAccountsClient[\s\S]*?clubId=\{clubId\}/);
  });

  it("renderCategorySubgroups ctx carries mapping drag context", () => {
    expect(src).toMatch(/mapping\?\s*:\s*MappingDragCtx/);
  });

  it("ChartOfAccountsClient renders AccountListMappingDrawer on drop", () => {
    expect(src).toMatch(/<AccountListMappingDrawer/);
    expect(src).toMatch(/accountId=\{mappingDrop\.accountId\}/);
    expect(src).toMatch(/targetFsGroupId=\{mappingDrop\.targetFsGroupId\}/);
  });

  it("beginMappingDrag / endMappingDrag / dropOnGroup handlers defined", () => {
    expect(src).toMatch(/const beginMappingDrag = useCallback/);
    expect(src).toMatch(/const endMappingDrag = useCallback/);
    expect(src).toMatch(/const dropOnGroup = useCallback/);
    expect(src).toMatch(/const dragOverGroup = useCallback/);
    expect(src).toMatch(/const dragLeaveGroup = useCallback/);
  });
});
