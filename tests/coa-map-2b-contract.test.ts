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
// COA-MAP-3 (2026-10-07) — Mapping Studio UI retired; its former
// client file is removed.  The pins that scanned it are updated to
// confirm the retirement rather than the removed content.

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

  const drawer = readFileSync(DRAWER, "utf8");

  it("Account List drawer imports MappingPreviewPanel from the shared file", () => {
    expect(drawer).toMatch(/import \{\s*MappingPreviewPanel,\s*type MappingPreviewResult,\s*\} from "@\/components\/coa-mapping\/MappingPreviewPanel"/);
    expect(drawer).toMatch(/<MappingPreviewPanel\s/);
  });

  it("standalone Mapping Studio client has been deleted (COA-MAP-3 retirement)", () => {
    expect(existsSync(path.join(REPO, "src/app/app/admin/coa-mapping/mapping-workspace-client.tsx"))).toBe(false);
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

  it("destination is detected by fsGroupId (never from display text / fsGroupKey / fsGroupLabel)", () => {
    // COA-MAP-2C — the pointer-driven hook uses elementFromPoint and
    // walks up to the nearest [data-fs-group-id] ancestor; the
    // destination is NEVER derived from fsGroupKey or fsGroupLabel.
    expect(src).not.toMatch(/onDropOnGroup\(.*fsg\.key\)/);
    expect(src).not.toMatch(/onDropOnGroup\(.*fsg\.label\)/);
  });

  it("eligible destinations are flagged with data-drop-eligible for CSS targeting", () => {
    expect(src).toMatch(/data-drop-eligible=/);
  });

  it("hovered destinations are flagged with data-drop-hovered for CSS targeting", () => {
    expect(src).toMatch(/data-drop-hovered=/);
  });

  it("sub-header carries a coa-mapping-drop-{fsGroupId} testid for Playwright targeting", () => {
    expect(src).toMatch(/data-testid=\{fsg\.id \? `coa-mapping-drop-\$\{fsg\.id\}` : undefined\}/);
  });
});

describe("COA-MAP-2B / 2C §D — whole-row pointer-driven drag", () => {
  const src = readFileSync(COA_UI, "utf8");

  it("AccountRow accepts onRowPointerDown + currentFsGroupLabel", () => {
    expect(src).toMatch(/onRowPointerDown\?:\s*\(/);
    expect(src).toMatch(/currentFsGroupLabel:\s*string;/);
  });

  it("<tr> itself carries onPointerDown (whole row is the drag source)", () => {
    expect(src).toMatch(/onPointerDown=\{dragEnabled \? \(e\) => onRowPointerDown!/);
    // The old HTML5 handle span is gone — no `draggable` attribute
    // on the row OR anywhere inside AccountRow.
    expect(src).not.toMatch(/data-testid=\{`coa-mapping-drag-handle-/);
  });

  it("pointer-down payload carries accountId + accountNumber + accountName + currentFsGroupName", () => {
    expect(src).toMatch(/accountId:\s*row\.id/);
    expect(src).toMatch(/accountNumber:\s*row\.accountNumber/);
    expect(src).toMatch(/accountName:\s*row\.name/);
    expect(src).toMatch(/currentFsGroupName:\s*currentFsGroupLabel/);
  });

  it("drag is disabled in fundMode OR when canEdit is false", () => {
    expect(src).toMatch(/const dragEnabled = !!onRowPointerDown && !fundMode && canEdit;/);
  });

  it("row's own onClick still fires — click vs drag disambiguation lives in the useAccountDrag hook, not the row", () => {
    // The <tr> still has onClick={onRowClick}; threshold is handled
    // in the hook.  Row click opens the Inspector via its own path.
    expect(src).toMatch(/onClick=\{onRowClick\}/);
  });
});

describe("COA-MAP-2B / 2C §E — pointer-driven auto-scroll (now in useAccountDrag hook)", () => {
  // COA-MAP-2C moved auto-scroll into the pointer-driven hook so a
  // single rAF loop drives both the overlay motion and the scroll.
  const HOOK = path.join(REPO, "src/components/coa-mapping/useAccountDrag.tsx");
  const src = readFileSync(HOOK, "utf8");

  it("hook uses pointer events (not dragover) as the authoritative source", () => {
    expect(src).toMatch(/window\.addEventListener\("pointermove"/);
    expect(src).toMatch(/window\.addEventListener\("pointerup"/);
    expect(src).toMatch(/window\.addEventListener\("pointercancel"/);
  });

  it("auto-scroll walks the scrollable ancestor of the source row (defensively covers .spectre-dw-table-wrap and document)", () => {
    expect(src).toMatch(/findScrollableAncestor/);
    expect(src).toMatch(/\.spectre-dw-table-wrap/);
  });

  it("velocity is a progressive 2 → 14 px/frame quadratic curve (NOT the 6 → 24 ramp from COA-MAP-2B)", () => {
    expect(src).toMatch(/V_BASE_PX_PER_FRAME = 2/);
    expect(src).toMatch(/V_MAX_PX_PER_FRAME = 14/);
    expect(src).toMatch(/EDGE_ZONE_PX = 100/);
    // Quadratic ramp: t * t * (max - base).
    expect(src).toMatch(/t \* t \* \(V_MAX_PX_PER_FRAME - V_BASE_PX_PER_FRAME\)/);
  });

  it("rAF loop + cleanup on pointerup/pointercancel/unmount", () => {
    expect(src).toMatch(/requestAnimationFrame\(scrollStep\)/);
    expect(src).toMatch(/removeEventListener\("pointermove"/);
    expect(src).toMatch(/removeEventListener\("pointerup"/);
    expect(src).toMatch(/removeEventListener\("pointercancel"/);
    expect(src).toMatch(/cleanup/);
  });

  it("auto-scroll is driven by LAST KNOWN pointer Y (not event rate)", () => {
    // The rAF loop reads pointerRef.current.y, so the scroll velocity
    // is independent of how often the browser fires pointermove.
    expect(src).toMatch(/pointerRef\.current\.y/);
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

describe("COA-MAP-2B / 2C §G — ChartOfAccountsClient wiring", () => {
  const src = readFileSync(COA_UI, "utf8");
  const page = readFileSync(COA_PAGE, "utf8");

  it("ChartOfAccountsClient receives clubId as a prop", () => {
    expect(src).toMatch(/clubId:\s*string;/);
    expect(page).toMatch(/<ChartOfAccountsClient[\s\S]*?clubId=\{clubId\}/);
  });

  it("renderCategorySubgroups ctx carries mapping drag context", () => {
    expect(src).toMatch(/mapping\?\s*:\s*MappingDragCtx/);
  });

  it("ChartOfAccountsClient uses the pointer-driven useAccountDrag hook", () => {
    expect(src).toMatch(/import \{ useAccountDrag, AccountDragOverlay \} from "@\/components\/coa-mapping\/useAccountDrag"/);
    expect(src).toMatch(/const drag = useAccountDrag\(\);/);
  });

  it("ChartOfAccountsClient mounts the floating overlay (fixed-position drag ghost)", () => {
    expect(src).toMatch(/<AccountDragOverlay state=\{drag\.state\}/);
  });

  it("ChartOfAccountsClient renders AccountListMappingDrawer on drop (same canonical path)", () => {
    expect(src).toMatch(/<AccountListMappingDrawer/);
    expect(src).toMatch(/accountId=\{mappingDrop\.accountId\}/);
    expect(src).toMatch(/targetFsGroupId=\{mappingDrop\.targetFsGroupId\}/);
  });

  it("drag.onDrop callback is wired so pointer-driven drops open the drawer", () => {
    expect(src).toMatch(/drag\.onDrop\(\(accountId,\s*targetFsGroupId\)\s*=>\s*\{[\s\S]*?setMappingDrop/);
  });
});
