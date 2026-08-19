// Phase 4R rev-6 (2026-08-15) — source-contract for the refresh UX
// + shell alignment tokens.
//
// The project's vitest config is Node-only (no jsdom/happy-dom, no
// @testing-library/react). Behaviour tests for the click flow are
// covered by the Playwright acceptance spec (staging). This file
// pins the source-level contract so a future refactor cannot
// silently reintroduce the retired "Refresh now" text or the
// out-of-pill status chip.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function read(p: string): string {
  return fs.readFileSync(path.join(process.cwd(), p), "utf8");
}

// Strip TypeScript/JSX comments so a mention of a retired affordance
// in a rationale comment doesn't trip the "must not contain" checks
// below. We only care about what the compiled/rendered output emits.
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")   // /* ... */
    .replace(/^\s*\/\/.*$/gm, "")        // // line comments
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ""); // {/* JSX comments */}
}

const CSS = read("src/app/globals.css");
const PILL = read("src/components/mission-control/FeedSyncedStatusPill.tsx");
const LIVE = read("src/components/mission-control/MissionControlLiveRefresh.tsx");
const CTX = read("src/components/mission-control/LiveRefreshContext.tsx");
const ICONS = read("src/components/spectre/icons/index.tsx");
const PAGE = read("src/app/app/admin/page.tsx");

describe("Refresh UX — retired affordances are gone", () => {
  const LIVE_CODE = codeOnly(LIVE);
  it("MissionControlLiveRefresh no longer renders a 'Refresh now' button", () => {
    expect(LIVE_CODE).not.toMatch(/Refresh now/i);
    expect(LIVE_CODE).not.toMatch(/data-testid=["']mc-refresh-now/);
  });
  it("MissionControlLiveRefresh no longer renders a standalone 'Refreshing…' status chip", () => {
    expect(LIVE_CODE).not.toMatch(/data-testid=["']mc-live-refresh-status/);
    // The `Refreshing…` literal must NOT survive as a rendered chip
    // sibling to the pill. It IS still emitted by the pill itself as
    // a label swap (see below), but never as an adjacent element.
    expect(LIVE_CODE).not.toMatch(/Refreshing…/);
    expect(LIVE_CODE).not.toMatch(/Refreshing\.{3}/);
  });
  it("The 'N new work items' banner (headless bg-refresh response) is preserved", () => {
    expect(LIVE).toMatch(/mc-new-items-banner/);
    expect(LIVE).toMatch(/newItemsAvailable/);
  });
});

describe("Feed Synced pill — refresh icon integrated inside the pill", () => {
  it("imports IconRefresh from the Spectre icon library", () => {
    expect(PILL).toMatch(/import\s*\{\s*IconRefresh\s*\}\s*from\s*["']@\/components\/spectre\/icons["']/);
    // And IconRefresh exists in the library.
    expect(ICONS).toMatch(/export const IconRefresh = /);
  });
  it("renders the refresh button INSIDE the .spectre-feed-pill element", () => {
    // The pill returns a single <span className="spectre-feed-pill …">
    // whose children are the label link + the refresh button.
    expect(PILL).toMatch(/feed-synced-pill-refresh/);
    // ClassName is composed via template literal in the source.
    expect(PILL).toContain("spectre-feed-pill ${toneClass}");
    // The refresh button must live within the pill's return.
    const returnBlock = PILL.slice(PILL.indexOf("return ("), PILL.lastIndexOf("</span>"));
    expect(returnBlock).toMatch(/feed-synced-pill-refresh/);
    expect(returnBlock).toMatch(/feed-synced-pill-label/);
  });
  it("has an accessible label ('Refresh feed') + aria-busy binding", () => {
    expect(PILL).toMatch(/aria-label="Refresh feed"/);
    expect(PILL).toMatch(/aria-busy=\{manualRefreshing\}/);
  });
  it("is keyboard-actionable + prevents repeat clicks while pending", () => {
    // native <button> handles Enter/Space; source keeps the explicit
    // key-handler for defensive coverage. Repeat-click protection lives
    // in the context via `inFlightRef.current === "manual"` short-circuit.
    expect(PILL).toMatch(/disabled=\{manualRefreshing\}/);
    expect(CTX).toMatch(/if \(inFlightRef\.current === "manual"\) return;/);
  });
});

describe("Refresh state model — manual vs background distinction", () => {
  it("LiveRefreshContext exposes distinct manualRefreshing + backgroundRefreshing flags", () => {
    expect(CTX).toMatch(/manualRefreshing:\s*boolean/);
    expect(CTX).toMatch(/backgroundRefreshing:\s*boolean/);
  });
  it("doRefresh takes a 'manual' | 'background' source", () => {
    expect(CTX).toMatch(/source:\s*"manual"\s*\|\s*"background"/);
  });
  it("background poll dispatches source='background'", () => {
    expect(CTX).toMatch(/void doRefresh\("background"\)/);
  });
  it("public refreshManually + acceptNewItems dispatch source='manual'", () => {
    expect(CTX).toMatch(/refreshManually = useCallback\(\(\) => \{ void doRefresh\("manual"\); \}/);
    expect(CTX).toMatch(/acceptNewItems = useCallback\(\(\) => \{ void doRefresh\("manual"\); \}/);
  });
  it("the pill's visible label ONLY responds to the manual flag (never the background flag)", () => {
    // The label swap logic reads only `manualRefreshing`.
    expect(PILL).toMatch(/const manualRefreshing = !!live\?\.manualRefreshing;/);
    expect(PILL).toMatch(/const displayLabel = manualRefreshing\s*\n\s*\?\s*"Refreshing…"/);
    // The base status label is used in every non-manual case
    // (background refresh included).
    expect(PILL).not.toMatch(/backgroundRefreshing/);
  });
});

describe("Refresh state model — honest failure state", () => {
  it("a manual failure surfaces 'Refresh failed' in the pill label", () => {
    expect(PILL).toMatch(/const refreshFailed = !!live\?\.error;/);
    expect(PILL).toMatch(/"Refresh failed"/);
  });
  it("a background refresh does NOT clear a manual error", () => {
    // The provider only resets `error` at the START of a MANUAL
    // attempt — a background poll that fails again would only set
    // the error, never clear the visible one.
    //
    // Stabilization (2026-08-19): converted from a line-shape regex
    // to a scoped semantic assertion. The old regex pinned the
    // literal `if (source === "manual") setError(null);` which
    // required the entry-point ternary shape; the current code
    // splits handling into `doManualRefresh` (calls setError(null))
    // and `doBackgroundRefresh` (never calls setError(null)). Both
    // shapes preserve the invariant; only the background-branch
    // absence is what actually matters.
    const bgFn = CTX.match(/const doBackgroundRefresh = useCallback[\s\S]+?\n  \}, \[[^\]]*\]\);/);
    expect(bgFn, "doBackgroundRefresh function not found").toBeTruthy();
    expect(bgFn![0]).not.toMatch(/setError\(null\)/);
    // And the manual path DOES clear the error at the start.
    const manualFn = CTX.match(/const doManualRefresh = useCallback[\s\S]+?\n  \}, \[[^\]]*\]\);/);
    expect(manualFn, "doManualRefresh function not found").toBeTruthy();
    expect(manualFn![0]).toMatch(/setError\(null\)/);
  });
});

describe("Page wiring — LiveRefreshProvider wraps the header meta row", () => {
  it("admin/page.tsx imports + renders <LiveRefreshProvider>", () => {
    expect(PAGE).toMatch(/import \{ LiveRefreshProvider \} from "@\/components\/mission-control\/LiveRefreshContext";/);
    expect(PAGE).toMatch(/<LiveRefreshProvider/);
  });
  it("MissionControlLiveRefresh is invoked with NO refresh-state props (it now reads from context)", () => {
    expect(PAGE).toMatch(/<MissionControlLiveRefresh \/>/);
  });
});

// ---------------------------------------------------------------------------
// Shell alignment token contract
// ---------------------------------------------------------------------------

describe("Sidebar / greeting alignment (CSS token contract)", () => {
  it(".spectre-sidebar-identity is pinned to var(--spectre-topbar-h)", () => {
    const block = CSS.slice(CSS.indexOf(".spectre-sidebar-identity"));
    expect(block).toMatch(/min-height:\s*var\(--spectre-topbar-h\)/);
  });
  it(".spectre-sidebar-nav-scroll padding-top uses workspace-pad-y", () => {
    const block = CSS.slice(CSS.indexOf(".spectre-sidebar-nav-scroll"));
    expect(block).toMatch(/padding-top:\s*calc\(var\(--spectre-workspace-pad-y\)/);
  });
});
