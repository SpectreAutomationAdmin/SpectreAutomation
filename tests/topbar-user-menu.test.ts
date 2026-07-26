// TopBar account menu — source-contract tests.
//
// The repo doesn't ship a React renderer for vitest; we follow the
// existing convention (e.g. `monthly-package-publish-states.test.ts`'s
// PublishHeaderButton block) and assert on the component file's
// source. The contract under test:
//
//   • The identity area (name + role + avatar) is a SINGLE
//     interactive button. The whole area opens the menu, not just
//     the avatar.
//   • The button carries proper ARIA (`aria-haspopup="menu"`,
//     `aria-expanded`) and a labelled name.
//   • The dropdown carries `role="menu"`.
//   • Two menu items render: User Settings (Link to the supplied
//     `settingsHref`) and Sign Out (form posting to /api/logout).
//   • The menu closes on outside click, Escape, and item selection.
//   • Keyboard support: Enter / Space / ArrowDown on the trigger
//     opens the menu; ArrowDown / ArrowUp inside the menu wraps;
//     Escape closes and returns focus to the trigger.
//   • Both layouts that mount the TopBar wire a context-appropriate
//     `settingsHref`: admin → /app/admin/settings, member →
//     /app/member/profile.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const TOPBAR = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/TopBar.tsx"),
  "utf8",
);
const ADMIN_LAYOUT = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/admin/layout.tsx"),
  "utf8",
);
const MEMBER_LAYOUT = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/member/layout.tsx"),
  "utf8",
);

describe("TopBar — account menu contract", () => {
  it("is a client component (interaction state lives in the browser)", () => {
    expect(TOPBAR.trim().startsWith('"use client"')).toBe(true);
  });

  it("renders a SINGLE button covering the whole identity area (name + subline + avatar)", () => {
    // The trigger button wraps the right-aligned name/subline div
    // AND the avatar circle. The avatar is intentionally
    // aria-hidden so the button's accessible name comes from
    // `aria-label`, not the initials.
    expect(TOPBAR).toMatch(/data-testid="topbar-user-trigger"/);
    expect(TOPBAR).toMatch(/aria-haspopup="menu"/);
    expect(TOPBAR).toMatch(/aria-expanded=\{open\}/);
    expect(TOPBAR).toMatch(/aria-label=\{`Account menu for \$\{userName\}`\}/);
    // The avatar's initials are decorative — screen readers should
    // read the trigger's aria-label, not "JW".
    expect(TOPBAR).toMatch(/aria-hidden="true"[\s\S]+initials/);
  });

  it("renders the menu only when open, with role=\"menu\" and aria-label", () => {
    expect(TOPBAR).toMatch(/\{open && \(\s*<div[\s\S]+role="menu"[\s\S]+aria-label="Account menu"/);
    expect(TOPBAR).toMatch(/data-testid="topbar-user-menu"/);
  });

  it("renders User Settings as a Link to the prop-supplied settingsHref (hidden when no href)", () => {
    expect(TOPBAR).toMatch(/\{settingsHref && \(\s*<Link\s+href=\{settingsHref\}[\s\S]+role="menuitem"[\s\S]+>\s*User Settings\s*<\/Link>/);
    expect(TOPBAR).toMatch(/data-testid="topbar-user-menu-settings"/);
  });

  it("renders Sign Out as a Link to /api/logout (matches the working sidebar pattern; sidesteps a React form-submit unmount race)", () => {
    // 2026-06-30 fix: a previous form-POST implementation didn't
    // actually submit — the onClick that closed the menu re-rendered
    // and unmounted the form before the browser's submit default
    // action fired (visible in the dev-server log as a missing POST).
    // The route handler accepts GET, so a plain Link navigation
    // works correctly: setOpen(false) and the browser navigation
    // are both clean outcomes of the click and Next.js Link handles
    // the order.
    expect(TOPBAR).toMatch(/<Link[\s\S]+href="\/api\/logout"[\s\S]+role="menuitem"[\s\S]+>\s*Sign Out\s*<\/Link>/);
    expect(TOPBAR).toMatch(/data-testid="topbar-user-menu-signout"/);
    // Defensive: Next.js Link does NOT prefetch API routes, but
    // explicitly disable it so no future Next.js default changes
    // could ever trigger a hover-preload-logout regression.
    expect(TOPBAR).toMatch(/prefetch=\{false\}/);
    // No form anywhere in the menu (the old broken POST shape is gone).
    expect(TOPBAR).not.toMatch(/<form\s+action="\/api\/logout"/);
  });

  it("closes the menu when a menu item is selected (both items have onClick that sets open=false)", () => {
    expect(TOPBAR).toMatch(/data-testid="topbar-user-menu-settings"[\s\S]+onClick=\{\(\) => setOpen\(false\)\}/);
    expect(TOPBAR).toMatch(/data-testid="topbar-user-menu-signout"[\s\S]+onClick=\{\(\) => setOpen\(false\)\}/);
  });

  it("closes on outside click + Escape (document-level listeners while open)", () => {
    // Outside-click: registers a mousedown listener that closes
    // when the click target is NEITHER the trigger nor the menu.
    expect(TOPBAR).toMatch(/document\.addEventListener\("mousedown"/);
    expect(TOPBAR).toMatch(/triggerRef\.current\?\.contains\(target\)/);
    expect(TOPBAR).toMatch(/menuRef\.current\?\.contains\(target\)/);
    // Escape: document-level keydown closes + returns focus to the
    // trigger so keyboard users don't lose their place.
    expect(TOPBAR).toMatch(/e\.key === "Escape"/);
    expect(TOPBAR).toMatch(/triggerRef\.current\?\.focus\(\)/);
  });

  it("keyboard: Enter / Space / ArrowDown on the trigger opens the menu", () => {
    expect(TOPBAR).toMatch(/e\.key === "ArrowDown" \|\| e\.key === "Enter" \|\| e\.key === " "/);
  });

  it("keyboard: ArrowDown / ArrowUp inside the menu walks items with wrap-around", () => {
    expect(TOPBAR).toMatch(/items\[\(idx \+ 1\) % items\.length\]/);
    expect(TOPBAR).toMatch(/items\[\(idx - 1 \+ items\.length\) % items\.length\]/);
  });

  it("focuses the first item when the menu opens", () => {
    expect(TOPBAR).toMatch(/menuRef\.current\?\.querySelector<HTMLElement>\("\[data-menu-item\]"\)[\s\S]+first\?\.focus\(\)/);
  });

  it("hover + focus states match Spectre admin chrome (stone hover, gold focus ring)", () => {
    expect(TOPBAR).toMatch(/hover:bg-stone-50[\s\S]+focus:ring-2[\s\S]+focus:ring-club-gold\/50/);
  });
});

describe("Layouts wire the TopBar with a context-appropriate settingsHref", () => {
  it("admin layout passes settingsHref=\"/app/admin/settings\"", () => {
    expect(ADMIN_LAYOUT).toMatch(/<TopBar[\s\S]+settingsHref="\/app\/admin\/settings"/);
  });

  it("member layout passes settingsHref=\"/app/member/profile\"", () => {
    expect(MEMBER_LAYOUT).toMatch(/<TopBar[\s\S]+settingsHref="\/app\/member\/profile"/);
  });

  it("both layouts still render the TopBar (the menu is the only behaviour change)", () => {
    expect(ADMIN_LAYOUT).toMatch(/import \{ TopBar \} from "@\/components\/TopBar"/);
    expect(MEMBER_LAYOUT).toMatch(/import \{ TopBar \} from "@\/components\/TopBar"/);
  });
});

describe("Sign-out target wires to the existing endpoint", () => {
  it("/api/logout route file exists + handles POST", () => {
    const routePath = path.resolve(process.cwd(), "src/app/api/logout/route.ts");
    expect(fs.existsSync(routePath)).toBe(true);
    const route = fs.readFileSync(routePath, "utf8");
    expect(route).toMatch(/export async function POST/);
    expect(route).toMatch(/clearSession\(\)/);
    // Non-members redirect to /login on sign-out; members redirect
    // to the club's public home. Both targets are the existing
    // contract this menu integrates with.
    expect(route).toMatch(/"\/login"/);
  });
});

describe("Sidebar no longer renders a duplicate Sign Out link", () => {
  const SIDEBAR = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/Sidebar.tsx"),
    "utf8",
  );

  it("neither the member sidebar nor the admin sidebar links to /api/logout (single source of truth lives in the TopBar dropdown)", () => {
    // Strip single-line comments so a documentation reference to
    // /api/logout in a comment doesn't false-positive this guard.
    const codeOnly = SIDEBAR
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/href="\/api\/logout"/);
    expect(codeOnly).not.toMatch(/>Sign out</);
    expect(codeOnly).not.toMatch(/>Sign Out</);
  });
});

describe("Settings targets resolve to existing routes (no orphan links)", () => {
  it("/app/admin/settings page exists", () => {
    expect(
      fs.existsSync(
        path.resolve(process.cwd(), "src/app/app/admin/settings/page.tsx"),
      ),
    ).toBe(true);
  });
  it("/app/member/profile page exists", () => {
    expect(
      fs.existsSync(
        path.resolve(process.cwd(), "src/app/app/member/profile/page.tsx"),
      ),
    ).toBe(true);
  });
});
