// Navigation discoverability tests.
//
// The product principle (CLAUDE.md "Discoverability rule"): every
// user-facing route must be reachable through the UI before its task
// is complete. The Sidebar is the canonical entry point for top-level
// workflows; we read its source as a string and assert the routes
// that matter are present with the right permission gating.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Nav data lives in src/components/sidebar-nav-data.ts (extracted
// from Sidebar.tsx in an earlier refactor so server code + tests
// can read the route configuration without dragging React/JSX
// through the bundler). The Sidebar.tsx file only imports the
// constants now — the data itself is here.
const SIDEBAR = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/sidebar-nav-data.ts"),
  "utf8",
);

function adminSidebarSlice(): string {
  // Everything from ADMIN_SECTIONS down to MEMBER_NAV is the admin nav.
  const start = SIDEBAR.indexOf("ADMIN_SECTIONS");
  const end = SIDEBAR.indexOf("MEMBER_NAV");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SIDEBAR.slice(start, end);
}
function memberSidebarSlice(): string {
  const start = SIDEBAR.indexOf("MEMBER_NAV");
  expect(start).toBeGreaterThan(-1);
  // Member nav ends at the next big declaration / end of file.
  const end = SIDEBAR.indexOf("\nexport ", start + 1);
  return SIDEBAR.slice(start, end > start ? end : undefined);
}

// -----------------------------------------------------------------
// Admin sidebar: Hospitality section + Floor Map link
// -----------------------------------------------------------------
describe("Admin sidebar — Hospitality discoverability", () => {
  const admin = adminSidebarSlice();

  it("contains a Hospitality section", () => {
    expect(admin).toMatch(/label:\s*"Hospitality"/);
  });

  it("contains a Floor Map link to /app/admin/hospitality/reservations/floor", () => {
    expect(admin).toMatch(/href:\s*"\/app\/admin\/hospitality\/reservations\/floor"/);
    expect(admin).toMatch(/label:\s*"Floor Map"/);
  });

  it("contains a Reservations link to /app/admin/hospitality/reservations", () => {
    expect(admin).toMatch(/href:\s*"\/app\/admin\/hospitality\/reservations"/);
    expect(admin).toMatch(/label:\s*"Reservations"/);
  });

  it("contains a Reservation Analytics link", () => {
    expect(admin).toMatch(/href:\s*"\/app\/admin\/hospitality\/reservations\/analytics"/);
    expect(admin).toMatch(/label:\s*"Reservation Analytics"/);
  });

  it("gates the Hospitality section behind reservations:read", () => {
    // Find the Hospitality section block and assert each item has the perm.
    const block = admin.match(/id:\s*"hospitality"[\s\S]*?\]\s*,/);
    expect(block).toBeTruthy();
    const text = block![0];
    // Floor Map + Reservations both require reservations:read.
    const floorLine = text.match(/href:\s*"\/app\/admin\/hospitality\/reservations\/floor"[^}]*\}/);
    expect(floorLine?.[0]).toMatch(/perm:\s*"reservations:read"/);
  });

  it("does not put admin routes in the member nav", () => {
    const member = memberSidebarSlice();
    expect(member).not.toMatch(/\/app\/admin\//);
  });
});

// -----------------------------------------------------------------
// Member sidebar: Dining Reservations is linked
// -----------------------------------------------------------------
describe("Member sidebar — Dining Reservations discoverability", () => {
  const member = memberSidebarSlice();

  it("contains a Dining Reservations link", () => {
    expect(member).toMatch(/href:\s*"\/app\/member\/reservations"/);
    expect(member).toMatch(/label:\s*"Dining Reservations"/);
  });

  it("does not surface admin-only routes", () => {
    expect(member).not.toMatch(/\/app\/admin\//);
    expect(member).not.toMatch(/perm:\s*"reservations:settings"/);
  });
});

// -----------------------------------------------------------------
// Admin sidebar: POS entry points (P0-1 + P0-4 resolution)
// -----------------------------------------------------------------
describe("Admin sidebar — POS entry-point clarity", () => {
  const admin = adminSidebarSlice();

  it("sidebar 'Point of Sale' routes to the floor map, NOT the legacy tableless LoungePOS", () => {
    // Match: { href: "/app/admin/hospitality/reservations/floor", label: "Point of Sale", … }
    const re = /\{\s*href:\s*"\/app\/admin\/hospitality\/reservations\/floor"\s*,\s*label:\s*"Point of Sale"/;
    expect(admin).toMatch(re);
  });

  it("sidebar surfaces the legacy LoungePOS only as 'Quick Sale / Bar' (secondary)", () => {
    // The link to /app/admin/ops/pos/lounge MUST be labelled "Quick Sale / Bar".
    const loungeEntry = admin.match(/\{\s*href:\s*"\/app\/admin\/ops\/pos\/lounge"\s*,\s*label:\s*"([^"]+)"/);
    expect(loungeEntry).toBeTruthy();
    expect(loungeEntry![1]).toBe("Quick Sale / Bar");
  });

  it("does not present LoungePOS as the primary 'Point of Sale' anywhere in the sidebar", () => {
    // Make sure no sidebar entry pairs the legacy LoungePOS URL with the
    // "Point of Sale" label — that would re-introduce the wrong-entry-point
    // problem this resolution fixed.
    const wrong = /\{\s*href:\s*"\/app\/admin\/ops\/pos\/lounge"\s*,\s*label:\s*"Point of Sale"/;
    expect(admin).not.toMatch(wrong);
  });

  it("does not present the legacy LoungePOS under the misleading 'Lounge POS' label", () => {
    // "Lounge POS" implies it IS the lounge POS workflow, which is no
    // longer true after P0-4 (it's now the bar / to-go quick-sale path).
    const wrong = /\{\s*href:\s*"\/app\/admin\/ops\/pos\/lounge"\s*,\s*label:\s*"Lounge POS"/;
    expect(admin).not.toMatch(wrong);
  });

  it("floor map is discoverable from BOTH the Operations and Hospitality sections", () => {
    // Operations section's "Point of Sale" link AND Hospitality section's
    // "Floor Map" link both target the floor route. Two entry points are
    // intentional — Operations is the server's primary path; Hospitality
    // is where a host would expect to find it.
    const floorRefs = admin.match(/href:\s*"\/app\/admin\/hospitality\/reservations\/floor"/g) ?? [];
    expect(floorRefs.length).toBeGreaterThanOrEqual(2);
  });
});

// -----------------------------------------------------------------
// POS hub page: primary Floor Map POS + secondary Quick Sale cards
// -----------------------------------------------------------------
describe("POS sales-history hub — primary/secondary entry cards", () => {
  const hub = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/ops/pos/page.tsx"),
    "utf8",
  );

  it("renders a primary 'Floor Map POS' card pointing at the floor map", () => {
    expect(hub).toMatch(/href="\/app\/admin\/hospitality\/reservations\/floor"/);
    expect(hub).toMatch(/Floor Map POS/);
    expect(hub).toMatch(/Primary workflow/);
  });

  it("renders a secondary 'Quick Sale / Bar' card pointing at the legacy LoungePOS", () => {
    expect(hub).toMatch(/href="\/app\/admin\/ops\/pos\/lounge"/);
    expect(hub).toMatch(/Quick Sale \/ Bar/);
    expect(hub).toMatch(/Secondary/);
  });

  it("does NOT re-introduce the old 'Open Lounge POS →' header link", () => {
    expect(hub).not.toMatch(/Open Lounge POS/);
  });
});

// -----------------------------------------------------------------
// Operations hub: Point of Sale (Floor Map) + Quick Sale / Bar
// -----------------------------------------------------------------
describe("Operations hub — POS card disambiguation", () => {
  const ops = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/ops/page.tsx"),
    "utf8",
  );

  it("has a 'Point of Sale (Floor Map)' card → floor map", () => {
    expect(ops).toMatch(/href="\/app\/admin\/hospitality\/reservations\/floor"\s+title="Point of Sale \(Floor Map\)"/);
  });

  it("has a 'Quick Sale / Bar' card → legacy LoungePOS", () => {
    expect(ops).toMatch(/href="\/app\/admin\/ops\/pos\/lounge"\s+title="Quick Sale \/ Bar"/);
  });

  it("does NOT label the legacy LoungePOS URL as 'Lounge POS' anywhere on the ops hub", () => {
    expect(ops).not.toMatch(/href="\/app\/admin\/ops\/pos\/lounge"\s+title="Lounge POS"/);
  });
});

// -----------------------------------------------------------------
// AdminShell POS-mode header
// -----------------------------------------------------------------
describe("AdminShell — POS-mode chrome reflects the relabel", () => {
  const shell = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/admin/AdminShell.tsx"),
    "utf8",
  );

  it("renames the lounge ringup pill from 'Floor' to 'Quick sale'", () => {
    expect(shell).not.toMatch(/label="Floor"\s+pathname/);
    expect(shell).toMatch(/label="Quick sale"\s+pathname/);
  });

  it("surfaces a Floor Map POS escape hatch from the POS-mode header", () => {
    expect(shell).toMatch(/Floor Map POS/);
    expect(shell).toMatch(/href="\/app\/admin\/hospitality\/reservations\/floor"/);
  });
});

// -----------------------------------------------------------------
// Audit doc + nav script
// -----------------------------------------------------------------
describe("Discoverability documentation + tooling", () => {
  it("docs/navigation-audit.md exists and explains the URL-only contract", () => {
    const doc = fs.readFileSync(path.resolve(process.cwd(), "docs/navigation-audit.md"), "utf8");
    expect(doc).toMatch(/URL-only/i);
    expect(doc).toMatch(/nav:audit/);
  });

  it("CLAUDE.md states the discoverability rule", () => {
    const claude = fs.readFileSync(path.resolve(process.cwd(), "CLAUDE.md"), "utf8");
    expect(claude).toMatch(/Discoverability rule/);
    expect(claude).toMatch(/nav:audit/);
  });

  it("package.json exposes npm run nav:audit", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
    expect(pkg.scripts["nav:audit"]).toBeTruthy();
  });
});
