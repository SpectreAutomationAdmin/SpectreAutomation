// Phase 4R rev-7 (2026-08-15) — Work Intake card tab-model
// source-contract. Vitest is Node-only in this project (no
// jsdom / @testing-library); behaviour tests are covered by the
// Playwright acceptance spec on staging. This suite pins the
// source-level guarantees so a future refactor cannot silently
// bring back the Open/Collapse accordion or the retired
// Invoice Review / Statement Review / Activity tabs.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function read(p: string): string {
  return fs.readFileSync(path.join(process.cwd(), p), "utf8");
}
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const CARD = read("src/components/mission-control/EmailIntakeCard.tsx");
const CARD_CODE = codeOnly(CARD);
const CSS = read("src/app/globals.css");

describe("Card tab model — three founder-facing tabs only", () => {
  it("`Tab` type is exactly the three founder tabs", () => {
    // The union must contain only "spectre-summary" | "conversation" |
    // "attachments" — the retired invoice/statement/activity values
    // are gone.
    expect(CARD).toMatch(/type Tab\s*=\s*"spectre-summary"\s*\|\s*"conversation"\s*\|\s*"attachments";/);
  });

  it("tabsFor always includes spectre-summary + conversation", () => {
    expect(CARD).toMatch(/const tabs: Tab\[\]\s*=\s*\["spectre-summary", "conversation"\]/);
  });

  it("attachments tab only pushed when the intake carries at least one attachment", () => {
    expect(CARD).toMatch(/if \(\(linked\?\.attachmentCount \?\? 0\) > 0\) tabs\.push\("attachments"\);/);
  });

  it("no invoice / statement / activity tab identifier survives as a Tab", () => {
    // Assert against tab-shaped call patterns (setTab, tab === "…", the
    // TAB union) — not against every string mention (the word
    // "invoice" also appears legitimately in the Spectre narrative).
    expect(CARD_CODE).not.toMatch(/setTab\(\s*"invoice"\s*\)/);
    expect(CARD_CODE).not.toMatch(/setTab\(\s*"statement"\s*\)/);
    expect(CARD_CODE).not.toMatch(/setTab\(\s*"activity"\s*\)/);
    expect(CARD_CODE).not.toMatch(/tab\s*===\s*"invoice"/);
    expect(CARD_CODE).not.toMatch(/tab\s*===\s*"statement"/);
    expect(CARD_CODE).not.toMatch(/tab\s*===\s*"activity"/);
    expect(CARD_CODE).not.toMatch(/"Invoice Review"/);
    expect(CARD_CODE).not.toMatch(/"Statement Review"/);
    expect(CARD_CODE).not.toMatch(/data-testid=["']unified-tab-invoice["']/);
    expect(CARD_CODE).not.toMatch(/data-testid=["']unified-tab-activity["']/);
  });

  it("CARD_TAB_LABEL maps the three tabs to founder-facing labels", () => {
    const start = CARD.indexOf("const CARD_TAB_LABEL");
    const block = CARD.slice(start, start + 400);
    expect(block).toMatch(/"spectre-summary":\s*"Spectre Summary"/);
    expect(block).toMatch(/conversation:\s*"Conversation"/);
    expect(block).toMatch(/attachments:\s*"Attachments"/);
  });
});

describe("Card default state + no-accordion contract", () => {
  it("initial tab state is 'spectre-summary'", () => {
    expect(CARD).toMatch(/useState<Tab>\("spectre-summary"\)/);
  });

  it("no `expanded` / `setExpanded` state remains", () => {
    expect(CARD_CODE).not.toMatch(/\bconst\s*\[\s*expanded\s*,/);
    expect(CARD_CODE).not.toMatch(/setExpanded/);
  });

  it("no `card-toggle` Open/Collapse button remains", () => {
    expect(CARD_CODE).not.toMatch(/data-testid=["']card-toggle["']/);
    // The retired button rendered {expanded ? "Collapse" : "Open"};
    // that specific ternary string is gone. Renders that use
    // "Collapsed" / "Opened" (past-tense states) are fine.
    expect(CARD_CODE).not.toMatch(/\?\s*"Collapse"\s*:\s*"Open"/);
  });

  it("no `spectre-mc-item-surface` primary click surface remains", () => {
    expect(CARD_CODE).not.toMatch(/spectre-mc-item-surface/);
  });

  it("no `role=\"button\"` wrapping the card body remains", () => {
    // The role="button" that made the whole body click-to-expand
    // is retired. Nested control-level role="button" attributes on
    // <div> elsewhere are unaffected.
    const idx = CARD_CODE.indexOf("tabIndex={0}");
    expect(idx, "no tabIndex=0 primary surface").toBe(-1);
  });

  it("data-active-tab attribute is emitted on the article", () => {
    // Rev-7 replaces data-expanded with data-active-tab so DOM
    // consumers (Playwright, unit tests, styling) can read the
    // currently selected tab without opening the card first.
    expect(CARD).toMatch(/data-active-tab=\{tab\}/);
    expect(CARD_CODE).not.toMatch(/data-expanded=/);
  });
});

describe("Card tab bar + tab body wiring", () => {
  it("<CardTabBar /> renders at the top of the article (before any tab body)", () => {
    const tabBarIdx = CARD.indexOf("<CardTabBar");
    const spectreSummaryBodyIdx = CARD.indexOf('data-testid="card-summary"');
    const conversationBodyIdx = CARD.indexOf('data-testid="card-conversation"');
    const attachmentsBodyIdx = CARD.indexOf('data-testid="card-attachments"');
    expect(tabBarIdx).toBeGreaterThan(0);
    expect(tabBarIdx).toBeLessThan(spectreSummaryBodyIdx);
    expect(tabBarIdx).toBeLessThan(conversationBodyIdx);
    expect(tabBarIdx).toBeLessThan(attachmentsBodyIdx);
  });

  it("each tab body renders only when its tab is active (no persistent summary above others)", () => {
    expect(CARD).toMatch(/\{tab === "spectre-summary" && \(/);
    expect(CARD).toMatch(/\{tab === "conversation" && \(/);
    expect(CARD).toMatch(/\{tab === "attachments" && \(/);
  });

  it("action row lives INSIDE the spectre-summary branch (understand + act)", () => {
    // The spectre-mc-actions block sits inside the
    // `tab === "spectre-summary"` fragment — verify by proximity.
    const summaryOpen = CARD.indexOf('{tab === "spectre-summary" && (');
    const actionsIdx = CARD.indexOf('className="spectre-mc-actions"');
    const conversationOpen = CARD.indexOf('{tab === "conversation" && (');
    expect(actionsIdx).toBeGreaterThan(summaryOpen);
    expect(actionsIdx).toBeLessThan(conversationOpen);
  });
});

describe("Mark-read behaviour moved to first tab click", () => {
  it("`handleTabChange` fires markReadOnce alongside the tab change", () => {
    const block = CARD.slice(CARD.indexOf("handleTabChange"));
    expect(block).toMatch(/void markReadOnce\(\);/);
  });

  it("primary-action onPrimary (AP path) still fires markReadOnce for modal-open actions", () => {
    // A user clicking Create-vendor-and-post from the Spectre
    // Summary must still mark the item read even if they never
    // click a tab explicitly.
    const primaryBlock = CARD.slice(CARD.indexOf("onPrimary={()"));
    expect(primaryBlock).toMatch(/void markReadOnce\(\);/);
  });
});

describe("Retired diagnostics endpoints + data still exist server-side", () => {
  it("ap-evidence + statement-evidence + activity endpoints are not deleted (only tabs are gone)", () => {
    // Keep the assertion light — this repo has separate server
    // suites for these endpoints. Here we only assert that the
    // Card component no longer PROXIES them into tab bodies, which
    // is the acceptance criterion for the founder-facing UI.
    expect(CARD_CODE).not.toMatch(/loadApEvidenceOnce\(/);
    expect(CARD_CODE).not.toMatch(/loadStatementEvidenceOnce\(/);
    expect(CARD_CODE).not.toMatch(/InvoiceFacetPane/);
    expect(CARD_CODE).not.toMatch(/StatementFacetPane/);
  });
});

describe("CSS — retired accordion styles gone, new tab-driven styles present", () => {
  it(".spectre-mc-item-surface is removed", () => {
    expect(CSS).not.toMatch(/\.spectre-mc-item-surface\b/);
  });
  it(".spectre-mc-tabs--card + .spectre-mc-item-body are defined", () => {
    expect(CSS).toMatch(/\.spectre-mc-tabs--card\s*\{/);
    expect(CSS).toMatch(/\.spectre-mc-item-body\s*\{/);
  });
});

describe("Rev-11 CSS — outer article once again owns the visible card chrome", () => {
  // Phase 4R rev-11 (2026-08-15) — founder review rejected the
  // rev-9 "bare wrapper + protruding-tabs" file-folder framing and
  // requested the earlier single-card treatment. The article now
  // carries the visible border, background, shadow, radius, and
  // orange left workflow accent. The `.spectre-mc-item-frame` div
  // remains in the DOM as a bare passthrough (for the ResizeObserver
  // `frameRef` + inline min-height baseline behaviour retained
  // from rev-9.2) but draws no chrome.
  it(".spectre-mc-item article owns the visible card chrome", () => {
    const idx = CSS.indexOf(".spectre-mc-item {");
    expect(idx).toBeGreaterThan(0);
    const rule = CSS.slice(idx, idx + CSS.slice(idx).indexOf("}"));
    expect(rule).toMatch(/background:\s*var\(--spectre-surface\)/);
    expect(rule).toMatch(/border:\s*1px solid var\(--spectre-border-hairline\)/);
    expect(rule).toMatch(/border-radius:\s*var\(--spectre-radius-panel\)/);
    expect(rule).toMatch(/box-shadow:\s*var\(--spectre-shadow-subtle\)/);
    expect(rule).toMatch(/padding:\s*\d+px \d+px \d+px \d+px/);
    expect(rule).toMatch(/border-left-width:\s*3px/);
    // Regression guards: the rev-9 bare-wrapper shape must NOT recur.
    expect(rule).not.toMatch(/background:\s*transparent/);
    expect(rule).not.toMatch(/border:\s*0/);
  });
  it(".spectre-mc-item-frame is a bare passthrough (no visible chrome)", () => {
    const idx = CSS.indexOf(".spectre-mc-item-frame {");
    expect(idx, ".spectre-mc-item-frame ruleset must exist (holds frameRef + inline min-height)").toBeGreaterThan(0);
    const rule = CSS.slice(idx, idx + CSS.slice(idx).indexOf("}"));
    expect(rule).toMatch(/background:\s*transparent/);
    expect(rule).toMatch(/border:\s*0/);
    expect(rule).toMatch(/box-shadow:\s*none/);
    expect(rule).toMatch(/padding:\s*0/);
    // Regression guards: rev-9 chrome must NOT recur on the frame.
    expect(rule).not.toMatch(/background:\s*var\(--spectre-surface\)/);
    expect(rule).not.toMatch(/border:\s*1px solid/);
    expect(rule).not.toMatch(/border-radius:\s*var\(--spectre-radius-panel\)/);
  });
  it("state-variant left-accent binds to the ARTICLE (which owns the visible border again)", () => {
    // Match either the base ruleset OR any later override.
    expect(CSS).toMatch(/\.spectre-mc-item\.judgment\s*\{[^}]*border-left-color:\s*var\(--spectre-status-warning\)/);
    expect(CSS).toMatch(/\.spectre-mc-item\.approval\s*\{[^}]*border-left-color:\s*var\(--spectre-status-success\)/);
    expect(CSS).toMatch(/\.spectre-mc-item\.comm\s*\{[^}]*border-left-color:\s*var\(--spectre-status-info\)/);
    // Rev-9's pattern (accent on the frame) must NOT recur.
    expect(CSS).not.toMatch(/\.spectre-mc-item\.judgment\s+\.spectre-mc-item-frame\s*\{[^}]*border-left-color/);
  });
});

describe("Rev-11 CSS — tabs live INSIDE the card at compact rev-7 proportions", () => {
  it("tab strip is a flex row inside the card interior (no protrusion, no bleed)", () => {
    const idx = CSS.indexOf(".spectre-mc-tabs--card {");
    expect(idx).toBeGreaterThan(0);
    const rule = CSS.slice(idx, idx + CSS.slice(idx).indexOf("}"));
    // Regression guards: the rev-9 protruding-tabs mechanics must NOT recur.
    expect(rule).not.toMatch(/display:\s*inline-flex/);
    expect(rule).not.toMatch(/margin:\s*0\s+0\s+-1px\s+12px/);
    expect(rule).not.toMatch(/z-index:\s*1/);
    // Positive assertions: sits inside the card with a hairline
    // separator underneath and 12px of breathing room to the body.
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/margin:\s*0\s+0\s+12px\s+0/);
    expect(rule).toMatch(/border-bottom:\s*1px solid var\(--spectre-border-hairline\)/);
    // Regression guards: no grey rail, no bleed-to-edges.
    expect(rule).not.toMatch(/background:\s*var\(--spectre-surface-hover/);
    expect(rule).not.toMatch(/margin:\s*0\s+-20px/);
  });
  it("each tab is compact rev-7 proportions with transparent-until-active borders", () => {
    const idx = CSS.indexOf(".spectre-mc-tabs--card .spectre-mc-tab {");
    expect(idx).toBeGreaterThan(0);
    const rule = CSS.slice(idx, idx + CSS.slice(idx).indexOf("}"));
    // Rev-7-style proportions retained: font ≤ 12.5 px, hpad ≤ 12 px.
    const fontMatch = rule.match(/font-size:\s*([\d.]+)px/);
    expect(fontMatch).toBeTruthy();
    expect(Number(fontMatch![1]), "compact font-size").toBeLessThanOrEqual(12.5);
    const padMatch = rule.match(/padding:\s*(\d+)px\s+(\d+)px/);
    expect(padMatch, "explicit padding pin").toBeTruthy();
    expect(Number(padMatch![2]), "horizontal padding ≤ 12 px").toBeLessThanOrEqual(12);
    // Inactive tabs have a transparent border so they read as
    // understated text controls, not as boxed buttons.
    expect(rule).toMatch(/border:\s*1px solid transparent/);
    // Tab bottom overlaps the strip's border-bottom by 1 px so the
    // active state's `border-bottom-color: surface` merges cleanly.
    expect(rule).toMatch(/margin-bottom:\s*-1px/);
    // Rounded top corners only.
    expect(rule).toMatch(/border-top-left-radius:\s*\d+px/);
    expect(rule).toMatch(/border-top-right-radius:\s*\d+px/);
    expect(rule).toMatch(/border-bottom-left-radius:\s*0/);
    expect(rule).toMatch(/border-bottom-right-radius:\s*0/);
  });
  it("active tab reads as a subtle bordered box that merges into the card body", () => {
    const idx = CSS.indexOf(".spectre-mc-tabs--card .spectre-mc-tab--active");
    expect(idx).toBeGreaterThan(0);
    const rule = CSS.slice(idx, idx + CSS.slice(idx).indexOf("}"));
    expect(rule).toMatch(/background:\s*var\(--spectre-surface\)/);
    expect(rule).toMatch(/border-color:\s*var\(--spectre-border-hairline\)/);
    // The bottom border matches the surface colour so it disappears
    // into the card interior — completing the tabs-in-card merge.
    expect(rule).toMatch(/border-bottom-color:\s*var\(--spectre-surface\)/);
    // Regression guard: rev-9's box-shadow-merge mechanism is gone.
    expect(rule).not.toMatch(/box-shadow:\s*0\s+1px\s+0\s+0/);
  });
  it("base .spectre-mc-tabs rule is fully scoped away from the --card variant", () => {
    // Preserved rev-9 fix: the base rule must ONLY target
    // .spectre-mc-tabs:not(.spectre-mc-tabs--card), so the card
    // strip's shape is never overridden by cascade order.
    expect(CSS).not.toMatch(/\n\s*\.spectre-mc-tabs\s*\{/);
    expect(CSS).toMatch(/\.spectre-mc-tabs:not\(\.spectre-mc-tabs--card\)\s*\{[^}]*display:\s*flex/);
  });
});

describe("Rev-9 CSS — no global min-height on tab bodies", () => {
  it("the retired rev-8 global 380px baseline is gone", () => {
    // Rev-9 uses a per-card measured baseline applied via INLINE
    // style on `.spectre-mc-item-frame`, not a CSS rule. A global
    // min-height on `.spectre-mc-tab-body` (or the frame) would be
    // the wrong shape — it would force one baseline on every card.
    const bodyIdx = CSS.indexOf(".spectre-mc-tab-body");
    if (bodyIdx > 0) {
      const rule = CSS.slice(bodyIdx, bodyIdx + CSS.slice(bodyIdx).indexOf("}"));
      expect(rule, "no global min-height on .spectre-mc-tab-body").not.toMatch(/min-height:\s*\d+px/);
    }
    const frameIdx = CSS.indexOf(".spectre-mc-item-frame {");
    const frameRule = CSS.slice(frameIdx, frameIdx + CSS.slice(frameIdx).indexOf("}"));
    expect(frameRule, "no static min-height on .spectre-mc-item-frame").not.toMatch(/min-height:\s*\d+px/);
  });
});

describe("Rev-9 component — per-card Summary baseline via ResizeObserver", () => {
  it("EmailIntakeCard imports useLayoutEffect + useRef for the measurement hook", () => {
    expect(CARD).toMatch(/import\s*\{[^}]*useLayoutEffect[^}]*\}\s*from\s*["']react["']/);
    expect(CARD).toMatch(/import\s*\{[^}]*useRef[^}]*\}\s*from\s*["']react["']/);
  });
  it("EmailIntakeCard declares frameRef + summaryBaseline state", () => {
    // Rev-9.2 — the observer targets the FRAME (not the summary
    // shell) because box-sizing:border-box is global, so min-height
    // on the frame is compared against the frame's OUTER rectangle;
    // measuring anything else means applying the wrong number back.
    expect(CARD).toMatch(/const frameRef\s*=\s*useRef</);
    expect(CARD).toMatch(/const\s*\[\s*summaryBaseline\s*,\s*setSummaryBaseline\s*\]\s*=\s*useState/);
  });
  it("EmailIntakeCard wires a ResizeObserver keyed to tab === 'spectre-summary'", () => {
    expect(CARD).toMatch(/if \(tab !== "spectre-summary"\) return;/);
    // Observer must watch the frame, not the summary body/shell.
    expect(CARD).toMatch(/const el\s*=\s*frameRef\.current;/);
    expect(CARD).toMatch(/new ResizeObserver/);
    expect(CARD).toMatch(/obs\.observe\(el\);/);
    expect(CARD).toMatch(/obs\.disconnect\(\);/);
  });
  it("frame receives the measured baseline as inline min-height only when a non-Summary tab is active", () => {
    // Applying it during Summary would freeze Summary against legitimate
    // shrinks — the anti-shrink invariant is only meaningful for
    // Attachments/Conversation.
    expect(CARD).toMatch(/tab !== "spectre-summary" && summaryBaseline !== null/);
    expect(CARD).toMatch(/minHeight:\s*`\$\{summaryBaseline\}px`/);
  });
  it("frame div carries a data-testid so Playwright can measure it directly", () => {
    expect(CARD).toMatch(/className="spectre-mc-item-frame"[\s\S]{0,80}data-testid="card-frame"/);
  });
  it("summaryRef is attached to a wrapper that contains BOTH the summary body and actions row", () => {
    // Rev-9.1 (2026-08-15) — the ref lives on `.card-summary-shell`
    // wrapper so the measured baseline includes the actions row
    // beneath the summary body. If the ref sits on the body alone,
    // the frame min-height applied to non-Summary tabs is short by
    // the actions-row height (~40 px) and Attachments visibly
    // shrinks — the exact defect founder review called out.
    expect(CARD).toMatch(/<div ref=\{summaryRef\} data-testid="card-summary-shell">/);
    // The interior body div still carries its founder-facing testid
    // for Playwright + downstream tests.
    expect(CARD).toMatch(/<div className="spectre-mc-item-body" data-testid="card-summary">/);
  });
});
