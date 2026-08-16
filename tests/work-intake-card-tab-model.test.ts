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
  it("state-variant accent binds to the ARTICLE (which owns the visible border again)", () => {
    // Rev-11 required `border-left-color: <state>` directly on each
    // state class. Rev-12 routes the accent through the
    // `--card-accent` CSS variable instead — the base rule sets
    // `border-left-color: var(--card-accent)` once and each state
    // sets the variable. Accept EITHER shape so the pin doesn't
    // regress a valid refactor.
    expect(CSS).toMatch(/\.spectre-mc-item\.judgment\s*\{[^}]*(border-left-color|--card-accent):\s*var\(--spectre-status-warning\)/);
    expect(CSS).toMatch(/\.spectre-mc-item\.approval\s*\{[^}]*(border-left-color|--card-accent):\s*var\(--spectre-status-success\)/);
    expect(CSS).toMatch(/\.spectre-mc-item\.comm\s*\{[^}]*(border-left-color|--card-accent):\s*var\(--spectre-status-info\)/);
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

describe("Rev-12 CSS — unread cue is the existing accent thicker, not a green dot", () => {
  // Phase 4R rev-12 (2026-08-16) — founder brief §9 explicitly
  // retires the green ::after unread dot (it added a colour
  // orthogonal to the semantic palette and conflated unread with
  // a work-type). Rev-12 uses one signal: the LEFT-EDGE ACCENT
  // WIDENS while unread, from 3 px to 6 px, keeping the same
  // semantic colour. Layout is preserved by compensating
  // padding-left so total content-area offset is unchanged.
  it("no green ::after unread dot exists on the article or the frame", () => {
    // The dot lived on .spectre-mc-item--unread::after (rev-11) or
    // .spectre-mc-item-frame::after (rev-10). Both must be gone.
    expect(CSS).not.toMatch(/\.spectre-mc-item--unread::after/);
    expect(CSS).not.toMatch(/\.spectre-mc-item--unread\s+\.spectre-mc-item-frame::after/);
    // Guard against the ::after rule being kept with a different
    // shape: the green status-success dot pattern.
    expect(CSS).not.toMatch(/content:\s*""[\s\S]{0,200}background:\s*var\(--spectre-status-success\)[\s\S]{0,200}border-radius:\s*50%/);
  });
  it(".spectre-mc-item declares --card-accent CSS var and border-left-color reads it", () => {
    const idx = CSS.indexOf(".spectre-mc-item {");
    expect(idx).toBeGreaterThan(0);
    const rule = CSS.slice(idx, idx + CSS.slice(idx).indexOf("}"));
    expect(rule).toMatch(/--card-accent:\s*var\(--spectre-border-strong\)/);
    expect(rule).toMatch(/border-left-color:\s*var\(--card-accent\)/);
  });
  it("state variants set --card-accent (not a direct border-left-color)", () => {
    // Semantic accent is applied via the CSS variable so both the
    // read border-left and the (potential) unread reinforcement
    // reference one source of truth.
    expect(CSS).toMatch(/\.spectre-mc-item\.judgment\s*\{[^}]*--card-accent:\s*var\(--spectre-status-warning\)/);
    expect(CSS).toMatch(/\.spectre-mc-item\.approval\s*\{[^}]*--card-accent:\s*var\(--spectre-status-success\)/);
    expect(CSS).toMatch(/\.spectre-mc-item\.comm\s*\{[^}]*--card-accent:\s*var\(--spectre-status-info\)/);
    // .done and .info-item also set the variable (they may also
    // override padding, tolerated here).
    expect(CSS).toMatch(/\.spectre-mc-item\.done\s*\{[^}]*--card-accent:/);
    expect(CSS).toMatch(/\.spectre-mc-item\.info-item\s*\{[^}]*--card-accent:/);
  });
  it("unread thickens the accent (border-left-width 6px) AND compensates padding-left (17px)", () => {
    const idx = CSS.indexOf(".spectre-mc-item--unread {");
    expect(idx).toBeGreaterThan(0);
    const rule = CSS.slice(idx, idx + CSS.slice(idx).indexOf("}"));
    // Thicker accent — noticeable but restrained (founder brief §11).
    expect(rule).toMatch(/border-left-width:\s*6px/);
    // Padding compensation preserves content position (§13).
    expect(rule).toMatch(/padding-left:\s*17px/);
    // Regression: rev-11's darker background was overwrought;
    // rev-12 drops the surface tint so the accent thickness is
    // the primary unread signal.
    expect(rule).not.toMatch(/background:\s*color-mix/);
  });
  it("unread bolder title cue retained (secondary reinforcement)", () => {
    expect(CSS).toMatch(/\.spectre-mc-item--unread h3\s*\{[^}]*font-weight:\s*700/);
  });
  it(".done + --unread and .info-item + --unread also compensate padding-left", () => {
    // Both state variants override padding to 10px 20px. When
    // combined with unread the same 3px padding-left reduction
    // is needed to preserve content position.
    expect(CSS).toMatch(/\.spectre-mc-item\.done\.spectre-mc-item--unread[\s\S]{0,80}\.spectre-mc-item\.info-item\.spectre-mc-item--unread\s*\{[^}]*padding-left:\s*17px/);
  });
});

describe("Rev-12 loader — Outlook is canonical for email-backed items (no OR-latch)", () => {
  const LOADER = read("src/lib/mission-control/index.ts");
  it("applyViewerReadState splits behaviour by whether the item has a PRIMARY email origin", () => {
    // A single fetch that produces (a) which items have any PRIMARY
    // email and (b) which have any PRIMARY email whose isRead=false.
    expect(LOADER).toMatch(/const primaryOrigins\s*=\s*await prisma\.emailWorkIntakeOrigin\.findMany/);
    expect(LOADER).toMatch(/role:\s*"PRIMARY"/);
    expect(LOADER).toMatch(/const hasPrimaryEmail\s*=\s*new Set<string>/);
    expect(LOADER).toMatch(/const anyPrimaryUnread\s*=\s*new Set<string>/);
    // Explicit check that isRead === false (not truthiness — matches founder brief §6).
    expect(LOADER).toMatch(/origin\.emailMessage\.isRead === false/);
  });
  it("email-backed items: isUnread comes ONLY from Outlook (viewer's per-user row is ignored)", () => {
    // Guard: the assignment must reference `anyPrimaryUnread`, NOT
    // the per-user readSet, for the email-backed branch.
    expect(LOADER).toMatch(/if \(hasPrimaryEmail\.has\(item\.workIntakeItemId\)\) \{[\s\S]{0,400}item\.isUnread\s*=\s*anyPrimaryUnread\.has\(item\.workIntakeItemId\);/);
    // Explicit anti-regression: the old OR-latch formula must NOT
    // survive anywhere in the loader.
    expect(LOADER).not.toMatch(/!item\.viewerHasRead && !outlookAlreadyRead/);
    expect(LOADER).not.toMatch(/viewerHasRead \|\| outlookAlreadyRead/);
  });
  it("non-email items: isUnread comes from per-user WorkIntakeItemRead (pre-rev-10 behaviour)", () => {
    expect(LOADER).toMatch(/\} else \{[\s\S]{0,300}item\.isUnread\s*=\s*!viewerHasRead;/);
  });
});

describe("Rev-12 component — optimistic UI, no permanent latch", () => {
  it("readLocal is initialised from data.isUnread AND kept in sync via useEffect", () => {
    // Founder brief root-cause pinning: the pre-rev-12 useState
    // initialiser was NEVER re-read on prop change, so a card that
    // was clicked once stayed 'read' locally even after the server
    // re-projected `isUnread: true`. Rev-12 adds a useEffect that
    // resets readLocal whenever the server flips data.isUnread.
    expect(CARD).toMatch(/useState\(!data\.isUnread\)/);
    expect(CARD).toMatch(/useEffect\(\(\) => \{[\s\S]{0,300}setReadLocal\(!data\.isUnread\);[\s\S]{0,100}\}, \[data\.isUnread\]\);/);
  });
});

describe("Rev-12 mark-read worker — stale-mutation guard", () => {
  const MARK_READ = read("src/lib/mailbox/mark-read.ts");
  it("selects lastSyncedAt on the email so the guard can compare timestamps", () => {
    expect(MARK_READ).toMatch(/lastSyncedAt:\s*true/);
  });
  it("skips the PATCH (NOT_REQUIRED) if a sync ran after the mutation was queued AND the mirror is still unread", () => {
    // Rev-13: guard now scopes to THIS specific mutation row's
    // createdAt (each generation has its own row).
    expect(MARK_READ).toMatch(/lastSyncedAt\s*>\s*mutationRow\.createdAt/);
    // Records SUPERSEDED status so future observability shows the
    // guard triggered (not a silent skip).
    expect(MARK_READ).toMatch(/status:\s*"SUPERSEDED"/);
    expect(MARK_READ).toMatch(/superseded_by_outlook_unread/);
  });
});

describe("Rev-13 mark-read worker — retires permanent SUCCEEDED latch", () => {
  const MARK_READ = read("src/lib/mailbox/mark-read.ts");
  const ACTIONS = read("src/lib/work-intake/actions.ts");
  it("worker takes markReadMutationId from payload and does NOT lookup by (mailbox, email)", () => {
    // The retired pattern: `where: { mailboxConnectionId_emailMessageId: { ... } }`
    // was the source of the permanent latch. Rev-13 loads a specific
    // mutation row by ID (or creates one for backward-compat).
    expect(MARK_READ).not.toMatch(/mailboxConnectionId_emailMessageId/);
    expect(MARK_READ).toMatch(/markReadMutationId\?:\s*string/);
    expect(MARK_READ).toMatch(/payload\.markReadMutationId/);
  });
  it("worker has NO short-circuit on mutation.status === 'SUCCEEDED'", () => {
    // Rev-10's smoking-gun bug: worker returned early if it found a
    // historical SUCCEEDED row for (mailbox, email). Rev-13 uses
    // per-generation rows and MUST NOT have that check as executable
    // code. A comment explaining the retirement is fine — strip
    // comments before scanning.
    const codeOnly = MARK_READ
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/\.status === "SUCCEEDED"/);
    expect(codeOnly).not.toMatch(/status:\s*"SUCCEEDED"\s*\}\s*\)\s*\{/);
  });
  it("enqueue site (actions.ts) creates a new mutation row per interaction", () => {
    expect(ACTIONS).toMatch(/outlookMarkReadMutation\.create/);
    // The row's ID is threaded into the payload so worker + enqueue
    // agree on which generation is executing.
    expect(ACTIONS).toMatch(/markReadMutationId:\s*mutation\.id/);
    // generationCursor captures the email's updatedAt at enqueue
    // time for audit provenance.
    expect(ACTIONS).toMatch(/generationCursor:\s*email\.updatedAt\.toISOString/);
  });
  it("enqueue site dedupes ONLY active intents (PENDING/RUNNING/RETRYABLE)", () => {
    // Historical statuses (SUCCEEDED, FAILED_TERMINAL, NOT_REQUIRED,
    // SUPERSEDED) must NOT block a fresh generation.
    expect(ACTIONS).toMatch(/ACTIVE_STATUSES\s*=\s*\["PENDING",\s*"RUNNING",\s*"RETRYABLE"\]/);
    expect(ACTIONS).toMatch(/status:\s*\{\s*in:\s*\[\.\.\.ACTIVE_STATUSES\]/);
    // Log statement when dedupe fires — proves the guard is
    // observable, not silent.
    expect(ACTIONS).toMatch(/active-intent-dedupe/);
  });
  it("Prisma schema has NO @@unique on (mailboxConnectionId, emailMessageId)", () => {
    const postgresSchema = read("prisma-postgres/schema.prisma");
    // The @@unique that latched a message for life is retired. New
    // composite index preserves query performance for the active-
    // intent dedupe. Find the model block ending at the FIRST
    // top-of-line `}`. Strip Prisma `//` line comments before
    // scanning so a comment mentioning the retired constraint
    // doesn't false-positive the pin.
    const modelStart = postgresSchema.indexOf("model OutlookMarkReadMutation {");
    const rest = postgresSchema.slice(modelStart);
    const closingRel = rest.search(/\n\}/);
    const rawBlock = rest.slice(0, closingRel + 2);
    const block = rawBlock.replace(/\/\/.*$/gm, "");
    expect(block).not.toMatch(/@@unique\(\[mailboxConnectionId,\s*emailMessageId\]\)/);
    // Rev-13 audit column + composite index for active-intent queries.
    expect(block).toMatch(/generationCursor\s+String\?/);
    expect(block).toMatch(/@@index\(\[mailboxConnectionId,\s*emailMessageId,\s*status\]\)/);
  });
});

describe("Rev-13 sync — tri-state isRead + hasAttachments (missing != false)", () => {
  const NORMALIZE = read("src/lib/mailbox/normalize.ts");
  const SYNC = read("src/lib/mailbox/sync.ts");
  it("NormalizedEmail types isRead + hasAttachments as boolean | undefined", () => {
    expect(NORMALIZE).toMatch(/isRead:\s*boolean\s*\|\s*undefined/);
    expect(NORMALIZE).toMatch(/hasAttachments:\s*boolean\s*\|\s*undefined/);
  });
  it("normalize preserves undefined for absent Graph properties (not `?? false`)", () => {
    // The lethal coercion was `raw.isRead ?? false` — it corrupted
    // `undefined` (Graph didn't send) into `false` (unread).
    // Rev-13 uses `typeof === 'boolean'` guards which propagate
    // undefined faithfully.
    expect(NORMALIZE).toMatch(/isRead:\s*typeof\s+raw\.isRead\s*===\s*"boolean"\s*\?\s*raw\.isRead\s*:\s*undefined/);
    expect(NORMALIZE).toMatch(/hasAttachments:\s*typeof\s+raw\.hasAttachments\s*===\s*"boolean"\s*\?\s*raw\.hasAttachments\s*:\s*undefined/);
    // The retired coercion pattern must not recur:
    expect(NORMALIZE).not.toMatch(/isRead:\s*raw\.isRead\s*\?\?\s*false/);
    expect(NORMALIZE).not.toMatch(/hasAttachments:\s*raw\.hasAttachments\s*\?\?\s*false/);
  });
  it("sync includes isRead in UPDATE data only when normalized value is a boolean", () => {
    // Conditional assignment on the update DTO.
    expect(SYNC).toMatch(/if \(typeof norm\.isRead === "boolean"\) updateData\.isRead = norm\.isRead;/);
    expect(SYNC).toMatch(/if \(typeof norm\.hasAttachments === "boolean"\) updateData\.hasAttachments = norm\.hasAttachments;/);
  });
  it("sync CREATE branch still supplies a boolean default for new rows", () => {
    // First-seen records need a concrete seed value; false is safe
    // until the next full-property delta arrives.
    expect(SYNC).toMatch(/isRead:\s*typeof norm\.isRead === "boolean" \? norm\.isRead : false/);
    expect(SYNC).toMatch(/hasAttachments:\s*typeof norm\.hasAttachments === "boolean" \? norm\.hasAttachments : false/);
  });
});

describe("Rev-13 manual Feed Sync — actual mailbox sync barrier", () => {
  const CTX = read("src/components/mission-control/LiveRefreshContext.tsx");
  it("manual refresh POSTs to /api/mission-control/refresh-mailbox (enqueue barrier)", () => {
    expect(CTX).toMatch(/fetch\("\/api\/mission-control\/refresh-mailbox",\s*\{\s*method:\s*"POST"\s*\}/);
  });
  it("manual refresh polls /refresh-mailbox/status until every job is terminal OR timeout", () => {
    expect(CTX).toMatch(/\/api\/mission-control\/refresh-mailbox\/status\?jobIds=/);
    expect(CTX).toMatch(/allTerminal:\s*boolean;\s*anyFailed:\s*boolean/);
    expect(CTX).toMatch(/statusBody\.allTerminal/);
    // 30-second wall-clock timeout.
    expect(CTX).toMatch(/MANUAL_SYNC_TIMEOUT_MS\s*=\s*30_000/);
  });
  it("manual refresh sets error 'sync_failed' when any polled job ended in a failed status", () => {
    expect(CTX).toMatch(/setError\("sync_failed"\)/);
    expect(CTX).toMatch(/setError\("sync_timeout"\)/);
    expect(CTX).toMatch(/setError\("no_mailbox"\)/);
  });
  it("background refresh path remains SILENT — no sync barrier, no visible error state", () => {
    // doBackgroundRefresh hits the snapshot-summary GET only, never
    // enqueues a mailbox sync. Founder brief §13.
    expect(CTX).toMatch(/const doBackgroundRefresh\s*=\s*useCallback/);
    // Extract the background function body — it must NOT reference
    // the refresh-mailbox endpoint.
    const bgIdx = CTX.indexOf("const doBackgroundRefresh");
    const bgEnd = CTX.indexOf("}, [anyPaneExpanded, router]);", bgIdx);
    expect(bgIdx).toBeGreaterThan(0);
    expect(bgEnd).toBeGreaterThan(bgIdx);
    const bgBody = CTX.slice(bgIdx, bgEnd);
    expect(bgBody, "background refresh must NOT enqueue a mailbox sync").not.toMatch(/refresh-mailbox/);
  });
});

describe("Rev-13 refresh-mailbox API — barrier + status endpoints", () => {
  const POST = read("src/app/api/mission-control/refresh-mailbox/route.ts");
  const STATUS = read("src/app/api/mission-control/refresh-mailbox/status/route.ts");
  it("POST enqueues MAILBOX_INITIAL_SYNC on manual refresh (delta stream is unreliable for isRead flips)", () => {
    // Rev-13 acceptance discovered that Microsoft Graph's inbox
    // delta stream does not always surface isRead-flag flips made
    // by Outlook clients (staging: 3 delta polls returned
    // messagesExamined=0 while Graph reported isRead=false for
    // the same message). Manual refresh MUST re-enumerate the
    // inbox with current values to satisfy the founder-facing
    // "make Spectre agree with Outlook" contract.
    expect(POST).toMatch(/MAILBOX_INITIAL_SYNC/);
    expect(POST).toMatch(/const kind = "MAILBOX_INITIAL_SYNC"/);
    // Regression guard: no MAILBOX_DELTA_SYNC path in the manual
    // refresh endpoint.
    const codeOnly = POST.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/MAILBOX_DELTA_SYNC/);
  });
  it("POST returns 202 with jobIds so the client can poll status", () => {
    expect(POST).toMatch(/jobIds:\s*string\[\]/);
    expect(POST).toMatch(/status:\s*202/);
  });
  it("status endpoint distinguishes terminal vs failed job states", () => {
    expect(STATUS).toMatch(/TERMINAL_JOB_STATUSES\s*=\s*new Set\(\["COMPLETED",\s*"DEAD_LETTER",\s*"CANCELLED"\]\)/);
    expect(STATUS).toMatch(/allTerminal/);
    expect(STATUS).toMatch(/anyFailed/);
  });
  it("POST re-verifies each open Work Intake email directly via Graph (per-message GET) — inbox sync alone is insufficient", () => {
    // Second live finding: inbox delta/list won't return messages
    // moved out of the inbox (Spectre archives, Outlook moves), so
    // the manual refresh must ALSO re-fetch isRead for each visible
    // Work Intake's linked email. Bounded to ≤50 items per club.
    expect(POST).toMatch(/reverifiedCount/);
    expect(POST).toMatch(/workIntakeItem\.findMany/);
    expect(POST).toMatch(/emailOrigins:\s*\{\s*some:\s*\{\s*role:\s*"PRIMARY"\s*\}\s*\}/);
    expect(POST).toMatch(/status:\s*\{\s*in:\s*\["OPEN",\s*"IN_PROGRESS",\s*"DEFERRED",\s*"INFORMATIONAL"\]\s*\}/);
    // Bounded and grouped by mailbox for one token per connection.
    expect(POST).toMatch(/take:\s*50/);
    expect(POST).toMatch(/byMailbox\.set/);
    // Per-message Graph GET with $select=isRead.
    expect(POST).toMatch(/\/v1\.0\/me\/messages\/\$\{encodeURIComponent\(e\.graphMessageId\)\}/);
    expect(POST).toMatch(/\?\$select=isRead/);
    // If Graph value differs from mirror, WRITE the new value with
    // fresh lastSyncedAt.
    expect(POST).toMatch(/data:\s*\{\s*isRead:\s*body\.isRead,\s*lastSyncedAt:\s*new Date\(\)\s*\}/);
  });
});
