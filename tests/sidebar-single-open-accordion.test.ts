// Founder rule 2026-07-10: the left-hand admin sidebar behaves
// as a single-open accordion — only ONE section is expanded at
// a time. Opening any section collapses every other. Clicking
// the open section's header collapses it. Navigation auto-opens
// the section containing the new active route. A "you are here"
// dot stays on the section header when its child is active,
// even when the section is collapsed.
//
// Source-contract tests (matches the repo's existing convention
// for sidebar / page-level UI work). The component itself is a
// "use client" file we read as text.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SIDEBAR = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/Sidebar.tsx"),
  "utf8",
);

const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/*") && !l.trim().startsWith("*"))
    .join("\n");

describe("Single-open accordion — state model", () => {
  it("the legacy multi-open `collapsed: Set<string>` state is gone", () => {
    const c = codeOnly(SIDEBAR);
    // The old shape was `useState<Set<string>>(new Set())` for
    // `collapsed`. The new shape stores a single nullable id.
    expect(c).not.toMatch(/useState<Set<string>>\(new Set\(\)\)/);
    expect(c).not.toMatch(/loadCollapsed\(\)/);
    expect(c).not.toMatch(/saveCollapsed\(/);
    expect(c).not.toMatch(/COLLAPSED_STORAGE_KEY/);
  });

  it("uses a single `openSectionId: string | null` state for the open accordion", () => {
    expect(SIDEBAR).toContain("useState<string | null>(activeSectionId)");
    expect(SIDEBAR).toContain("openSectionId");
  });

  it("toggle handler: same id → null; different id → that id (opens it, closes any other)", () => {
    expect(SIDEBAR).toMatch(
      /setOpenSectionId\(\(prev\) => \(prev === id \? null : id\)\)/,
    );
  });

  it("section render reads `openSectionId === section.id` — at most one section can be open", () => {
    expect(SIDEBAR).toMatch(/const isOpen = openSectionId === section\.id/);
  });
});

describe("Active route → auto-open the containing section on navigation", () => {
  it("derives activeSectionId from findSectionForHref(activeHref, visibleSections)", () => {
    expect(SIDEBAR).toContain("function findSectionForHref(");
    expect(SIDEBAR).toMatch(/findSectionForHref\(activeHref, visibleSections\)/);
  });

  it("effect on activeSectionId change opens the matching section (no-op when there's no active section)", () => {
    const c = codeOnly(SIDEBAR);
    expect(c).toMatch(/useEffect\([\s\S]*?if \(activeSectionId !== null\) setOpenSectionId\(activeSectionId\);[\s\S]*?\}, \[activeSectionId\]\)/);
  });
});

describe("Active highlight survives an unrelated section being open", () => {
  it("active-item highlight is driven by activeHref (independent of openSectionId)", () => {
    // The `active` flag on each item is computed from activeHref,
    // not from openSectionId. So even if the user opens a
    // different section, the active route's badge / highlight
    // still reflects the URL correctly.
    expect(SIDEBAR).toMatch(/const active = item\.href === activeHref/);
    // The class only changes on `active`, not on section state.
    expect(SIDEBAR).toMatch(/active\s*\?\s*"bg-club-green-50/);
  });

  it("section header carries a 'you are here' dot when activeSectionId === section.id", () => {
    expect(SIDEBAR).toMatch(/const containsActive = activeSectionId === section\.id/);
    expect(SIDEBAR).toMatch(/data-testid=\{`nav-section-active-dot-\$\{section\.id\}`\}/);
    // Dot is rendered conditionally.
    expect(SIDEBAR).toMatch(/\{containsActive && \(/);
  });
});

describe("Accessibility + testability", () => {
  it("each section header button exposes aria-expanded matching isOpen", () => {
    expect(SIDEBAR).toMatch(/aria-expanded=\{isOpen\}/);
  });

  it("section header carries aria-controls pointing at the body's id", () => {
    expect(SIDEBAR).toMatch(/aria-controls=\{`nav-section-\$\{section\.id\}`\}/);
    expect(SIDEBAR).toMatch(/id=\{`nav-section-\$\{section\.id\}`\}/);
  });

  it("toggle button + body carry stable testids for e2e", () => {
    expect(SIDEBAR).toMatch(/data-testid=\{`nav-section-toggle-\$\{section\.id\}`\}/);
    expect(SIDEBAR).toMatch(/data-testid=\{`nav-section-body-\$\{section\.id\}`\}/);
  });

  it("toggle button exposes data-open + data-contains-active for cheap state inspection", () => {
    expect(SIDEBAR).toMatch(/data-open=\{isOpen \? "true" : "false"\}/);
    expect(SIDEBAR).toMatch(/data-contains-active=\{containsActive \? "true" : "false"\}/);
  });
});

describe("Layout / no scroll-reset implications", () => {
  it("only one section's body renders at a time — collapsing happens via React reconciliation, not CSS hiding", () => {
    // `{isOpen && <div ...>...</div>}` is the existing pattern; we
    // confirm it's still the conditional render so the layout-
    // above-this-section is unaffected when a section toggles.
    expect(SIDEBAR).toMatch(/\{isOpen && \(/);
    // We must NOT have switched to a CSS-hidden body (which would
    // shift focus / scroll surprisingly).
    expect(SIDEBAR).not.toMatch(/className=\{[^}]*display-none/);
    expect(SIDEBAR).not.toMatch(/hidden=\{!isOpen\}/);
  });
});
