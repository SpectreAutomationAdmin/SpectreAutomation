// HR-2C Shell Refinement (2026-08-24) — Source-contract + boundary.
//
// Pins the founder-required shell shape so a later refactor can't
// silently undo it:
//   §5 left nav is Home + Profile only;
//   §3-4 Club name lives in top header; sidebar identity is
//        "Employee Portal" only;
//   §2 top header renders the circular avatar + name + employee #;
//   §9-11 widget icons swapped (airplane / graduation cap) + upsized;
//   §17 stable data-tour-target attributes on widgets + Profile;
//   §21 portal self-photo route: portal principal reads own photo;
//        cross-employee / cross-club / no-principal all 404 same-shape;
//   §23 route removal from nav did NOT remove server auth from the
//        underlying pages.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";
import { _resetMemoryDocumentStorage_TEST_ONLY, resolveDocumentStorage } from "@/lib/documents/storage";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}
function code(rel: string): string {
  return src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ---------------------------------------------------------------------------
// Source-contract pins
// ---------------------------------------------------------------------------

describe("HR-2C Shell Refinement · source-contract", () => {
  const navData = src("src/components/sidebar-nav-data.ts");
  const sidebar = src("src/components/employee/EmployeePortalSidebar.tsx");
  const header = src("src/components/employee/EmployeePortalTopBar.tsx");
  const layout = src("src/app/employee/(authed)/layout.tsx");
  const home = src("src/app/employee/(authed)/page.tsx");
  const widgets = src("src/app/employee/(authed)/_home/HomeWidgetGrid.tsx");
  const tour = src("src/components/employee/EmployeeTourOnFirstLogin.tsx");

  it("§5 — EMPLOYEE_NAV contains Home + Profile ONLY (functional destinations removed from left rail)", () => {
    // Home is present.
    expect(navData).toMatch(/href:\s*"\/employee"\s*,\s*label:\s*"Home"/);
    // Profile is present.
    expect(navData).toMatch(/href:\s*"\/employee\/profile"\s*,\s*label:\s*"Profile"/);
    // Scope the "removed" check to just the EMPLOYEE_NAV block (the
    // admin sidebar still legitimately has these labels).
    const navCode = code("src/components/sidebar-nav-data.ts");
    const empNavStart = navCode.indexOf("EMPLOYEE_NAV");
    expect(empNavStart).toBeGreaterThan(-1);
    const empNavEnd = navCode.indexOf("];", empNavStart);
    const empNavBlock = navCode.slice(empNavStart, empNavEnd);
    for (const removed of ["Schedule", "Availability", '"Pay"', "Safety & Training", "Documents"]) {
      const re = new RegExp(`label:\\s*${removed.startsWith('"') ? removed : `"${removed}"`}`);
      expect(empNavBlock, `EMPLOYEE_NAV must not contain ${removed}`).not.toMatch(re);
    }
  });

  it("§4 — sidebar identity block is 'Employee Portal' only; Club name has been removed", () => {
    // No clubName prop on the sidebar.
    expect(sidebar).not.toMatch(/clubName/);
    // Eyebrow present.
    expect(sidebar).toMatch(/data-testid="portal-sidebar-eyebrow"/);
    expect(sidebar).toMatch(/Employee Portal/);
    // portal-club-name testid no longer in the sidebar.
    expect(sidebar).not.toMatch(/portal-club-name/);
  });

  it("§3 — top header renders Club name + user-menu (avatar + name + employee #) via EmployeePortalUserMenu", () => {
    // HR-2C Portal Refinement (2026-08-24, founder-accepted): the
    // top header composes EmployeePortalUserMenu on the right side.
    // The avatar / name / employee-number testids live on the user
    // menu now (portal-user-menu-*), not directly on the header
    // (portal-header-avatar-*).
    const userMenu = src("src/components/employee/EmployeePortalUserMenu.tsx");
    // Header hosts the Club name + delegates to the UserMenu.
    expect(header).toMatch(/data-testid="portal-header-club-name"/);
    expect(header).toMatch(/import EmployeePortalUserMenu/);
    expect(header).toMatch(/<EmployeePortalUserMenu/);
    // UserMenu carries avatar (photo OR initials) + name + employee #.
    expect(userMenu).toMatch(/data-testid="portal-user-menu-photo"/);
    expect(userMenu).toMatch(/data-testid="portal-user-menu-initials"/);
    expect(userMenu).toMatch(/data-testid="portal-topbar-name"/);
    expect(userMenu).toMatch(/data-testid="portal-topbar-employee-number"/);
    // Photo source is the canonical portal self-photo route.
    expect(userMenu).toMatch(/\/api\/employee\/self\/profile-photo/);
    // Round + object-cover.
    expect(userMenu).toMatch(/rounded-full/);
    expect(userMenu).toMatch(/object-cover/);
    // Layout carries clubName + photoVersion into the header + user menu.
    expect(layout).toMatch(/clubName=\{clubName\}/);
    expect(layout).toMatch(/photoVersion=\{photoVersion\}/);
  });

  it("§9-11 — Home widgets: airplane icon for Time Off, graduation cap for Training, 56px icons", () => {
    // Icon size raised to 56.
    const iconMatches = home.match(/width="56" height="56"/g) ?? [];
    expect(iconMatches.length).toBeGreaterThanOrEqual(5);
    // IconTimeOff no longer uses the sun-with-rays geometry (circle
    // at 12,12 r=4 + four cardinal + four diagonal rays).
    const timeOffFn = home.slice(home.indexOf("function IconTimeOff"));
    const timeOffBody = timeOffFn.slice(0, timeOffFn.indexOf("\n}"));
    expect(timeOffBody).not.toMatch(/circle cx="12" cy="12" r="4"/);
    // IconTraining now uses a graduation cap (no shield-with-check).
    const trainFn = home.slice(home.indexOf("function IconTraining"));
    const trainBody = trainFn.slice(0, trainFn.indexOf("\n}"));
    expect(trainBody).not.toMatch(/polyline points="9 12 11.2 14.2 15 10.5"/);
    // Tile min-height unchanged (widget dimensions preserved).
    expect(widgets).toMatch(/min-h-\[132px\]/);
  });

  it("§17 — every widget definition carries a stable tourTarget slug", () => {
    for (const slug of ["scheduling", "paystubs", "time-off", "forms", "training"]) {
      expect(home).toMatch(new RegExp(`tourTarget:\\s*"${slug}"`));
    }
    // Widget tile renders data-tour-target attribute.
    expect(widgets).toMatch(/data-tour-target=\{w\.tourTarget\}/);
    // Profile nav item carries tourTarget="profile" (existing nav-data
    // reduction test above already asserts the Profile entry).
    expect(navData).toMatch(/tourTarget:\s*"profile"/);
  });

  it("§16 — tour steps anchor to widgets (not removed sidebar links)", () => {
    // Removed sidebar targets no longer referenced.
    for (const removed of ["portal-nav-schedule", "portal-nav-availability", "portal-nav-pay", "portal-nav-documents", "portal-nav-safety"]) {
      expect(tour).not.toContain(removed);
    }
    // Widget targets present.
    for (const slug of ["scheduling", "paystubs", "time-off", "forms", "training"]) {
      expect(tour).toMatch(new RegExp(`data-tour-target="${slug}"`));
    }
    // Profile step still anchors to the persistent nav item.
    expect(tour).toMatch(/data-tour-target="profile"/);
  });

  it("§23 — route removal from nav did NOT remove server auth from the underlying pages", () => {
    for (const rel of [
      "src/app/employee/(authed)/schedule/page.tsx",
      "src/app/employee/(authed)/availability/page.tsx",
      "src/app/employee/(authed)/pay/page.tsx",
      "src/app/employee/(authed)/safety-training/page.tsx",
      "src/app/employee/(authed)/documents/page.tsx",
    ]) {
      const s = src(rel);
      expect(s, `${rel} must still guard on the portal principal`).toMatch(
        /getEmployeePortalPrincipal/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Portal self-photo route boundary — §21
// ---------------------------------------------------------------------------

let currentPortal: EmployeePortalPrincipal | null = null;
vi.mock("@/lib/employee-portal-session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/employee-portal-session")>(
    "@/lib/employee-portal-session",
  );
  return {
    ...actual,
    getEmployeePortalPrincipal: async () => currentPortal,
  };
});

// eslint-disable-next-line import/first
import { GET as selfPhotoGET } from "@/app/api/employee/self/profile-photo/route";
// eslint-disable-next-line import/first
import { uploadEmployeeDocument } from "@/lib/hr/documents";
// eslint-disable-next-line import/first
import { setProfilePhoto } from "@/lib/hr/employees";
import { createHash } from "node:crypto";

async function seedEmployeeWithPhoto(
  fx: AdminHrFixture,
  bytes: Buffer,
): Promise<{ employeeId: string; actor: EmployeePortalPrincipal }> {
  const emp = await prisma.employee.create({
    data: {
      clubId: fx.club.id,
      employeeNumber: `E-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "A", lastName: "B",
      personalEmail: `a-${Date.now()}-${Math.floor(Math.random() * 9999)}@x.test`,
    },
  });
  const storage = await resolveDocumentStorage({ clubId: fx.club.id });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storageKey = `clubs/${fx.club.id}/documents/${sha256}`;
  await storage.put({ storageKey, body: bytes, mimeType: "image/jpeg" });
  const doc = await uploadEmployeeDocument(fx.clubAdmin, emp.id, {
    category: "profile_photo",
    storageKey,
    contentSha256: sha256,
    sizeBytes: bytes.length,
    mimeType: "image/jpeg",
    displayName: "avatar.jpg",
  });
  await setProfilePhoto(fx.clubAdmin, emp.id, doc.id);
  const actor: EmployeePortalPrincipal = {
    employeeId: emp.id,
    clubId: fx.club.id,
    generation: 1,
    establishedAt: new Date().toISOString(),
  };
  return { employeeId: emp.id, actor };
}

function req() {
  return new NextRequest("http://test.local/api/employee/self/profile-photo");
}

describe("HR-2C Shell Refinement · portal self-photo boundary", () => {
  let fx: AdminHrFixture;
  const BYTES = Buffer.from(new Array(1024).fill(42));

  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("HR2CShell");
    _resetMemoryDocumentStorage_TEST_ONLY();
    currentPortal = null;
  }, 60_000);

  it("no session → 404 same-shape", async () => {
    const res = await selfPhotoGET(req());
    expect(res.status).toBe(404);
  });

  it("employee with a photo → 200 + image bytes; content-type preserved", async () => {
    const { actor } = await seedEmployeeWithPhoto(fx, BYTES);
    currentPortal = actor;
    const res = await selfPhotoGET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const returned = Buffer.from(await res.arrayBuffer());
    expect(returned.length).toBe(BYTES.length);
  });

  it("employee with NO photo → 404 (no fabrication, no leakage)", async () => {
    const emp = await prisma.employee.create({
      data: {
        clubId: fx.club.id, employeeNumber: "E-01",
        firstName: "X", lastName: "Y",
        personalEmail: `x-${Date.now()}@x.test`,
      },
    });
    currentPortal = {
      employeeId: emp.id, clubId: fx.club.id, generation: 1,
      establishedAt: new Date().toISOString(),
    };
    const res = await selfPhotoGET(req());
    expect(res.status).toBe(404);
  });

  it("cross-Club portal principal (session says clubId != Employee.clubId) → 404 (no leakage)", async () => {
    const { employeeId } = await seedEmployeeWithPhoto(fx, BYTES);
    // Craft a portal principal that claims the foreign club — the
    // employee row lives in fx.club, so the query returns null.
    currentPortal = {
      employeeId, clubId: fx.foreignClub.id, generation: 1,
      establishedAt: new Date().toISOString(),
    };
    const res = await selfPhotoGET(req());
    expect(res.status).toBe(404);
  });

  it("cross-employee: portal principal for a different employee cannot read this photo (route only reads principal.employeeId)", async () => {
    const withPhoto = await seedEmployeeWithPhoto(fx, BYTES);
    const otherEmp = await prisma.employee.create({
      data: {
        clubId: fx.club.id, employeeNumber: "E-02",
        firstName: "Q", lastName: "R",
        personalEmail: `q-${Date.now()}@x.test`,
      },
    });
    currentPortal = {
      employeeId: otherEmp.id, clubId: fx.club.id, generation: 1,
      establishedAt: new Date().toISOString(),
    };
    const res = await selfPhotoGET(req());
    // Other employee has no photo of their own → 404, and the
    // route DID NOT return the seeded-with-photo bytes.
    expect(res.status).toBe(404);
    void withPhoto;
  });
});
