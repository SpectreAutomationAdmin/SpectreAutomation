// COA-MAP-2A (2026-10-06) — repair-slice contract regressions.
//
//   §A  Global window.dragover listener wired for the lifetime of
//       the drag — NOT scoped only to group rows.
//   §B  Auto-scroll targets document.scrollingElement (plus the
//       spectre-dw-table-wrap defensive fallback), not the generic
//       window.scrollBy call that the previous slice used.
//   §C  Module integration — CoaModeSwitch component renders two
//       links (Account List / Financial Statement Mapping) with
//       the right data-testids and is mounted on BOTH pages.
//   §D  Sidebar nav surfaces /app/admin/coa-mapping under Finance.
//   §E  Disposable test fixture endpoint exists, is staging-only,
//       tenant-scoped, and strictly prefix-matches on delete.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO       = path.resolve(__dirname, "..");
const UI         = path.join(REPO, "src/app/app/admin/coa-mapping/mapping-workspace-client.tsx");
const MAP_PAGE   = path.join(REPO, "src/app/app/admin/coa-mapping/page.tsx");
const COA_PAGE   = path.join(REPO, "src/app/app/admin/coa/page.tsx");
const SWITCH     = path.join(REPO, "src/components/coa/CoaModeSwitch.tsx");
const SIDEBAR    = path.join(REPO, "src/components/sidebar-nav-data.ts");
const FIXTURE    = path.join(REPO, "src/app/api/admin/testing/coa-map-2a-fixture/route.ts");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

describe("COA-MAP-2A §A — global window.dragover listener", () => {
  const src = stripComments(readFileSync(UI, "utf8"));

  it("mounts a window-level dragover listener while a drag is active", () => {
    expect(src).toMatch(/window\.addEventListener\("dragover"/);
  });

  it("the dragover listener prevents default (so dragover keeps firing)", () => {
    const idx = src.indexOf('addEventListener("dragover"');
    const near = src.slice(Math.max(0, idx - 400), idx + 400);
    expect(near).toMatch(/e\.preventDefault\(\)/);
  });

  it("the listener drives updateAutoScroll(clientY)", () => {
    const idx = src.indexOf('addEventListener("dragover"');
    const near = src.slice(Math.max(0, idx - 200), idx + 400);
    expect(near).toMatch(/updateAutoScroll\(e\.clientY\)/);
  });

  it("the listener is removed in the useEffect cleanup when dragging stops", () => {
    expect(src).toMatch(/removeEventListener\("dragover"/);
    expect(src).toMatch(/removeEventListener\("dragend"/);
    expect(src).toMatch(/removeEventListener\("drop"/);
  });

  it("useEffect is scoped to [dragging, …] so the listener mounts/unmounts with the drag", () => {
    expect(src).toMatch(/useEffect\(\(\) => \{[\s\S]*?if \(!dragging\) return undefined;[\s\S]*?\}, \[dragging, updateAutoScroll, stopAutoScroll\]\)/);
  });
});

describe("COA-MAP-2A §B — scroll owner correctness", () => {
  const src = stripComments(readFileSync(UI, "utf8"));

  it("auto-scroll targets document.scrollingElement (not window.scrollBy)", () => {
    expect(src).toMatch(/document\.scrollingElement/);
    // The previous slice used window.scrollBy on the step; the repair
    // must set scrollTop on the real scroll owner.
    expect(src).toMatch(/\.scrollTop = /);
  });

  it("defensively also scrolls .spectre-dw-table-wrap when present", () => {
    expect(src).toMatch(/\.spectre-dw-table-wrap/);
  });

  it("edge threshold is in the 70-100 px range per directive", () => {
    expect(src).toMatch(/const edge = (70|80|90|100);/);
  });

  it("velocity ramps rather than being a single constant", () => {
    expect(src).toMatch(/maxV/);
    expect(src).toMatch(/minV/);
  });
});

describe("COA-MAP-2A §C — module integration (CoaModeSwitch)", () => {
  it("CoaModeSwitch component exists", () => {
    expect(existsSync(SWITCH)).toBe(true);
  });

  const switchSrc = readFileSync(SWITCH, "utf8");
  const mapPage = readFileSync(MAP_PAGE, "utf8");
  const coaPage = readFileSync(COA_PAGE, "utf8");

  it("switch renders two tabs with the required testids", () => {
    expect(switchSrc).toMatch(/data-testid="coa-mode-switch"/);
    expect(switchSrc).toMatch(/testid:\s*"coa-mode-list"/);
    expect(switchSrc).toMatch(/testid:\s*"coa-mode-mapping"/);
  });

  it("Mapping Studio page mounts CoaModeSwitch with active=\"mapping\"", () => {
    expect(mapPage).toMatch(/import \{ CoaModeSwitch \} from "@\/components\/coa\/CoaModeSwitch"/);
    expect(mapPage).toMatch(/<CoaModeSwitch active="mapping"/);
  });

  it("Chart of Accounts page mounts CoaModeSwitch with active=\"list\"", () => {
    expect(coaPage).toMatch(/import \{ CoaModeSwitch \} from "@\/components\/coa\/CoaModeSwitch"/);
    expect(coaPage).toMatch(/<CoaModeSwitch active="list"/);
  });

  it("switch uses stone-900 active state (Spectre neutral palette, no SaaS accent)", () => {
    expect(switchSrc).toMatch(/bg-stone-900/);
    expect(switchSrc).not.toMatch(/bg-(blue|indigo|purple|violet|emerald|cyan|teal|sky|green|red)/);
  });
});

describe("COA-MAP-2A §D — sidebar surfaces Mapping Studio", () => {
  const src = readFileSync(SIDEBAR, "utf8");

  it("Finance section includes /app/admin/coa-mapping entry", () => {
    expect(src).toMatch(/href:\s*"\/app\/admin\/coa-mapping"/);
    expect(src).toMatch(/label:\s*"Financial Statement Mapping"/);
  });

  it("the mapping entry sits directly after the Chart of Accounts entry", () => {
    const coaIdx = src.indexOf('"/app/admin/coa"');
    const mapIdx = src.indexOf('"/app/admin/coa-mapping"');
    expect(coaIdx).toBeGreaterThan(0);
    expect(mapIdx).toBeGreaterThan(coaIdx);
    // No other nav entry between them.
    const between = src.slice(coaIdx, mapIdx);
    expect(between.split("\n").length).toBeLessThan(10);
  });
});

describe("COA-MAP-2A §E — disposable test fixture endpoint", () => {
  it("fixture route exists", () => {
    expect(existsSync(FIXTURE)).toBe(true);
  });

  const src = stripComments(readFileSync(FIXTURE, "utf8"));

  it("exposes POST + DELETE handlers", () => {
    expect(src).toMatch(/export async function POST\(/);
    expect(src).toMatch(/export async function DELETE\(/);
  });

  it("is staging-only (404 in production)", () => {
    expect(src).toMatch(/isStaging\(\)/);
    expect(src).toMatch(/"Not available in production\."/);
  });

  it("requires clubId + enforces tenant isolation", () => {
    expect(src).toMatch(/clubId required/);
    expect(src).toMatch(/hasClubAccess\(/);
  });

  it("creates exactly two BALANCE_SHEET groups + one ASSET account", () => {
    // Two groups.
    const grpCount = (src.match(/prisma\.financialStatementGroup\.create\(/g) ?? []).length;
    expect(grpCount).toBe(2);
    // One account.
    const accCount = (src.match(/prisma\.account\.create\(/g) ?? []).length;
    expect(accCount).toBe(1);
    // Both groups are BS; account is ASSET.
    expect(src).toMatch(/statement:\s*"BALANCE_SHEET"/);
    expect(src).toMatch(/type:\s*"ASSET"/);
  });

  it("seeds an effective-dated assignment so the AS-OF resolver finds it today", () => {
    expect(src).toMatch(/prisma\.accountFinancialStatementAssignment\.create\(/);
    expect(src).toMatch(/effectiveFrom:\s*start/);
  });

  it("DELETE strictly prefix-matches on fixture key + name (never a blanket wipe)", () => {
    expect(src).toMatch(/startsWith:\s*`TENANT_\$\{fixtureKey\}_`/);
    expect(src).toMatch(/startsWith:\s*`\$\{fixtureKey\} —`/);
    expect(src).toMatch(/startsWith:\s*`\$\{fixtureKey\} `/);
  });

  it("DELETE runs inside a prisma.$transaction", () => {
    expect(src).toMatch(/prisma\.\$transaction\(async \(tx\)/);
  });
});

describe("COA-MAP-2A §F — COA-MAP-1 / 1A / 2 contracts still preserved", () => {
  const ui = readFileSync(UI, "utf8");
  it("handleDragStart + handleDragOverGroup + handleDropOnGroup + handleDragEnd preserved", () => {
    expect(ui).toMatch(/handleDragStart/);
    expect(ui).toMatch(/handleDragOverGroup/);
    expect(ui).toMatch(/handleDropOnGroup/);
    expect(ui).toMatch(/handleDragEnd/);
  });
  it("draggable attribute + stopAutoScroll + rAF loop preserved", () => {
    expect(ui).toMatch(/draggable[\r\n]/);
    expect(ui).toMatch(/stopAutoScroll/);
    expect(ui).toMatch(/requestAnimationFrame/);
  });
});
