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
