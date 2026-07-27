// Sprint 3 · Checkpoint 15N (2026-07-27) — source-contract locks for
// the Variant D sidebar icon rollout.
//
// The founder-approved reference is
// public/design-concepts/mission-control/variant-d-instrument.html
// which specifies:
//   • icon size          15 × 15
//   • stroke-width       1.9
//   • viewBox            0 0 24 24
//   • stroke-linecap     round
//   • stroke-linejoin    round
//   • colour             currentColor (muted default, accent when active)
//
// This test locks that:
//   • Every visible nav item / section / personal item carries a
//     typed NavigationIconKey.
//   • Every declared key resolves to an actual SVG in SidebarIcon.
//   • The icon component honours the reference spec verbatim.
//   • Hospitality uses the wine-glass glyph.
//   • Reporting routes are still stripped of the operational sidebar
//     (Checkpoint 15N does not touch that boundary).
//   • The 15M navigation decisions (Mission Control label, single
//     Search, no Connected Accounts) are preserved.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN_TOP_LEVEL,
  ADMIN_SECTIONS,
  ADMIN_PERSONAL,
} from "@/components/sidebar-nav-data";

// SidebarIcon lives in a .tsx file — importing it inside a plain
// vitest module trips the vite JSX transform in the current test
// environment. Every assertion below reads the source instead.
type NavigationIconKey =
  | "mission-control" | "search" | "membership" | "finance"
  | "accounts-payable" | "operations" | "hospitality"
  | "governance-reporting" | "analytics" | "communications"
  | "data" | "configuration" | "security" | "settings"
  | "mfa" | "design-system";

function read(p: string) { return readFileSync(join(process.cwd(), p), "utf8"); }

const ICON_FILE  = read("src/components/spectre/SidebarIcon.tsx");
const NAV_DATA   = read("src/components/sidebar-nav-data.ts");
const SIDEBAR    = read("src/components/spectre/SpectreSidebar.tsx");
const GLOBALS    = read("src/app/globals.css");
const ADMIN_SHELL = read("src/components/admin/AdminShell.tsx");

// ---------------------------------------------------------------------------
// Reference spec (from variant-d-instrument.html §.nav-item svg)
// ---------------------------------------------------------------------------

describe("15N — icon component honours the Variant D reference spec", () => {
  it("every SVG uses viewBox 0 0 24 24, stroke 1.9, round caps, currentColor", () => {
    // The base props object is a single source of truth; assert its
    // literal values so a future edit can't drift silently.
    expect(ICON_FILE).toMatch(/viewBox: "0 0 24 24"/);
    expect(ICON_FILE).toMatch(/strokeWidth: 1\.9/);
    expect(ICON_FILE).toMatch(/strokeLinecap: "round" as const/);
    expect(ICON_FILE).toMatch(/strokeLinejoin: "round" as const/);
    expect(ICON_FILE).toMatch(/stroke: "currentColor"/);
    expect(ICON_FILE).toMatch(/fill: "none"/);
  });
  it("default size is 15 (matching the reference)", () => {
    expect(ICON_FILE).toMatch(/size = 15/);
  });
  it("icons are aria-hidden (label carries the accessible name)", () => {
    expect(ICON_FILE).toMatch(/"aria-hidden": true/);
    expect(ICON_FILE).toMatch(/focusable: false/);
  });
  it("sidebar CSS pins the icon to 15px + drops opacity for muted default + tints to accent when active", () => {
    expect(GLOBALS).toMatch(/\.spectre-nav-item \.spectre-nav-icon \{[\s\S]{0,200}width: 15px;[\s\S]{0,200}height: 15px/);
    expect(GLOBALS).toMatch(/\.spectre-nav-item\.spectre-nav-item--active \.spectre-nav-icon \{[\s\S]{0,150}color: var\(--spectre-accent\)/);
  });
});

// ---------------------------------------------------------------------------
// Coverage — every nav entry has an icon key
// ---------------------------------------------------------------------------

describe("15N — every top-level, section, and personal item has an icon key", () => {
  it("ADMIN_TOP_LEVEL entries all declare an `icon`", () => {
    expect(ADMIN_TOP_LEVEL.length).toBeGreaterThan(0);
    for (const item of ADMIN_TOP_LEVEL) {
      expect(item.icon, `top-level "${item.label}" has no icon key`).toBeTruthy();
    }
  });
  it("ADMIN_SECTIONS entries all declare an `icon`", () => {
    expect(ADMIN_SECTIONS.length).toBeGreaterThan(0);
    for (const s of ADMIN_SECTIONS) {
      expect(s.icon, `section "${s.label}" has no icon key`).toBeTruthy();
    }
  });
  it("ADMIN_PERSONAL entries all declare an `icon`", () => {
    for (const item of ADMIN_PERSONAL) {
      expect(item.icon, `personal item "${item.label}" has no icon key`).toBeTruthy();
    }
  });
  it("every declared icon key exists in SidebarIcon's typed union", () => {
    // Every key that appears in nav data must be in the
    // NavigationIconKey union — otherwise TypeScript would have
    // already failed. But we also want to know that the SVG BRANCH
    // exists in the switch — a key without a case would render
    // undefined. The switch is exhaustive; TS enforces that. Guard
    // it explicitly by asserting each case label is present in the
    // source.
    const declared: NavigationIconKey[] = [
      ...ADMIN_TOP_LEVEL.map((i) => i.icon).filter(Boolean) as NavigationIconKey[],
      ...ADMIN_SECTIONS.map((s) => s.icon).filter(Boolean) as NavigationIconKey[],
      ...ADMIN_PERSONAL.map((i) => i.icon).filter(Boolean) as NavigationIconKey[],
    ];
    expect(declared.length).toBeGreaterThan(0);
    for (const key of declared) {
      expect(ICON_FILE, `SidebarIcon has no case for "${key}"`).toMatch(new RegExp(`case "${key}":`));
    }
  });
});

// ---------------------------------------------------------------------------
// Icon assignment audit — every founder-named section resolves correctly
// ---------------------------------------------------------------------------

describe("15N — founder-required icon mapping", () => {
  const expected: Array<{ label: string; icon: NavigationIconKey }> = [
    { label: "Mission Control",         icon: "mission-control" },
    { label: "Membership",              icon: "membership" },
    { label: "Finance",                 icon: "finance" },
    { label: "Accounts Payable",        icon: "accounts-payable" },
    { label: "Operations",              icon: "operations" },
    { label: "Hospitality",             icon: "hospitality" },
    { label: "Governance & Reporting",  icon: "governance-reporting" },
    { label: "Analytics",               icon: "analytics" },
    { label: "Communications",          icon: "communications" },
    { label: "Data",                    icon: "data" },
    { label: "Configuration",           icon: "configuration" },
  ];
  for (const e of expected) {
    it(`"${e.label}" is assigned icon "${e.icon}"`, () => {
      const match =
        ADMIN_TOP_LEVEL.find((i) => i.label === e.label)
        ?? ADMIN_SECTIONS.find((s) => s.label === e.label)
        ?? ADMIN_PERSONAL.find((i) => i.label === e.label);
      expect(match, `nav entry "${e.label}" not found`).toBeTruthy();
      expect(match?.icon).toBe(e.icon);
    });
  }
  it("Hospitality's SVG is a wine glass (bowl + stem + base), NOT the reference tray glyph", () => {
    // The Variant D reference file uses a serving-tray glyph for
    // Hospitality; the founder's checkpoint brief explicitly
    // required a wine-glass. Assert the bowl shape (curved cup
    // narrowing into a stem) is in the case body.
    const region = ICON_FILE.slice(ICON_FILE.indexOf(`case "hospitality":`), ICON_FILE.indexOf(`case "governance-reporting":`));
    // Bowl.
    expect(region).toMatch(/<path d="M8 3h8l-1 6a3 3 0 0 1-6 0z"/);
    // Stem.
    expect(region).toMatch(/<path d="M12 15v6"/);
    // Base.
    expect(region).toMatch(/<path d="M8 21h8"/);
  });
});

// ---------------------------------------------------------------------------
// Sidebar wiring — the component consumes the typed icon key
// ---------------------------------------------------------------------------

describe("15N — SpectreSidebar renders the typed SidebarIcon", () => {
  it("imports SidebarIcon + type from the centralized module", () => {
    expect(SIDEBAR).toMatch(/import SidebarIcon, \{ type NavigationIconKey \} from "\.\/SidebarIcon"/);
  });
  it("renderNavIcon prefers the explicit icon key, with a URL-shape fallback for legacy entries", () => {
    expect(SIDEBAR).toMatch(/function renderNavIcon\(item: \{ href: string; icon\?: NavigationIconKey \}\)/);
    expect(SIDEBAR).toMatch(/if \(item\.icon\) return <SidebarIcon name=\{item\.icon\} className="spectre-nav-icon" \/>/);
  });
  it("section headers render their icon left of the label, chevron right (Variant D alignment)", () => {
    // Section header lede wraps the icon + label together so the
    // chevron stays right-aligned via justify-between.
    expect(SIDEBAR).toMatch(/<span className="spectre-nav-section-header-lede">/);
    expect(SIDEBAR).toMatch(/section\.icon \? \(\s+<SidebarIcon\s+name=\{section\.icon\}/);
  });
  it("collapsed mode uses the section's icon as a per-row fallback so nothing is icon-less", () => {
    expect(SIDEBAR).toMatch(/renderNavIcon\(\{ href: item\.href, icon: item\.icon \?\? section\.icon \}\)/);
  });
  it("chevron expand does not shift the icon (icon is inside the lede span; chevron is a sibling)", () => {
    // Assert the header's flex-parent uses justify-between: icon+label
    // to the left, chevron to the right. Expanding the section
    // rotates the chevron transform only; the icon stays put.
    expect(SIDEBAR).toMatch(/className=\{cn\(\s+"spectre-nav-section-header w-full flex items-center justify-between"/);
    expect(SIDEBAR).toMatch(/transform: isOpen \? "rotate\(90deg\)" : "rotate\(0deg\)"/);
  });
});

// ---------------------------------------------------------------------------
// 15M navigation decisions preserved
// ---------------------------------------------------------------------------

describe("15N — 15M navigation decisions preserved", () => {
  it("Dashboard label is NOT reintroduced", () => {
    expect(NAV_DATA).not.toMatch(/label: "Dashboard"/);
  });
  it("Mission Control label remains at /app/admin", () => {
    expect(NAV_DATA).toMatch(/href: "\/app\/admin", label: "Mission Control"/);
  });
  it("duplicate top-level Search entry is NOT reintroduced (single search lives in SpectreSidebar)", () => {
    const topBlock = NAV_DATA.slice(NAV_DATA.indexOf("ADMIN_TOP_LEVEL"), NAV_DATA.indexOf("ADMIN_SECTIONS"));
    expect(topBlock).not.toMatch(/label: "Search"/);
  });
  it("Connected accounts is NOT reintroduced in the sidebar", () => {
    const personalBlock = NAV_DATA.slice(NAV_DATA.indexOf("ADMIN_PERSONAL"), NAV_DATA.length);
    expect(personalBlock).not.toMatch(/label: "Connected accounts"/);
  });
});

// ---------------------------------------------------------------------------
// Reporting exclusion — AdminShell still strips the operational sidebar
// for /app/admin/reporting/**
// ---------------------------------------------------------------------------

describe("15N — reporting exclusion", () => {
  it("REPORTING_MODE_PREFIXES still contains /app/admin/reporting so sidebar changes never render there", () => {
    expect(ADMIN_SHELL).toMatch(/const REPORTING_MODE_PREFIXES = \["\/app\/admin\/reporting"\]/);
  });
  it("SidebarIcon file does not reference any club-cream / club-green / reporting classes", () => {
    // Sanity guard against accidentally coupling sidebar icons to
    // the reporting-package palette. The reporting shell uses the
    // `club-*` Tailwind classes; the sidebar must not.
    expect(ICON_FILE).not.toMatch(/club-cream|club-green|club-gold|bg-club|text-club|border-club/);
  });
});

// ---------------------------------------------------------------------------
// The <SidebarIcon /> switch is exhaustive — every declared key has
// a case body with real SVG markup (guards against a missing case
// that would render undefined at runtime).
// ---------------------------------------------------------------------------

describe("15N — SidebarIcon switch is exhaustive for every declared key", () => {
  const declared: NavigationIconKey[] = [
    "mission-control", "search", "membership", "finance",
    "accounts-payable", "operations", "hospitality",
    "governance-reporting", "analytics", "communications",
    "data", "configuration", "security", "settings",
    "mfa", "design-system",
  ];
  for (const key of declared) {
    it(`case "${key}" exists and returns an <svg> tag`, () => {
      const idx = ICON_FILE.indexOf(`case "${key}":`);
      expect(idx, `case "${key}" not found in SidebarIcon.tsx`).toBeGreaterThan(0);
      // Grab the region up to the next `case ` or the switch close
      // and assert an <svg> tag lives inside — not a bare `return null`
      // that would leave the icon slot empty.
      const nextCase = ICON_FILE.indexOf("case \"", idx + 1);
      const end = nextCase > 0 ? nextCase : ICON_FILE.indexOf("}\n}", idx);
      const region = ICON_FILE.slice(idx, end);
      expect(region, `case "${key}" has no <svg> tag`).toMatch(/<svg\s+\{\.\.\.common\}/);
    });
  }
});
