// HR-2C Portal Refinement (2026-08-24 / expanded 2026-08-28) — Portal
// Profile self-service behavioural + boundary regression + source-
// contract for shell + user menu + widget geometry.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  updateSelfPersonalContact,
  upsertSelfPrimaryEmergencyContact,
  getSelfPrimaryEmergencyContact,
  updateSelfHomeAddress,
  getSelfHomeAddress,
  submitSelfBankReplacement,
  getSelfBankMasked,
} from "@/lib/hr/portal-self-service-profile";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";

async function makeEmployee(fx: AdminHrFixture): Promise<{
  employeeId: string; actor: EmployeePortalPrincipal;
}> {
  const emp = await prisma.employee.create({
    data: {
      clubId: fx.club.id,
      employeeNumber: `E-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "A", lastName: "B",
      personalEmail: `a-${Date.now()}-${Math.floor(Math.random() * 9999)}@x.test`,
    },
  });
  return {
    employeeId: emp.id,
    actor: {
      employeeId: emp.id, clubId: emp.clubId,
      generation: 1, establishedAt: new Date().toISOString(),
    },
  };
}

describe("HR-2C Portal Refinement · profile self-service", () => {
  let fx: AdminHrFixture;
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("HR2CPortalProf");
  }, 60_000);

  // -------------------------------------------------------------------------
  // Personal contact
  // -------------------------------------------------------------------------

  it("employee can update their own personal email + mobile phone", async () => {
    const { employeeId, actor } = await makeEmployee(fx);
    await updateSelfPersonalContact(actor, {
      personalEmail: "New.Address@Example.COM",
      mobilePhone: "(403) 555-0100",
    });
    const row = await prisma.employee.findUnique({
      where: { id: employeeId }, select: { personalEmail: true, mobilePhone: true },
    });
    expect(row!.personalEmail).toBe("new.address@example.com");
    expect(row!.mobilePhone).toBe("(403) 555-0100");
  });

  it("invalid email refused; row unchanged", async () => {
    const { employeeId, actor } = await makeEmployee(fx);
    const before = await prisma.employee.findUnique({
      where: { id: employeeId }, select: { personalEmail: true },
    });
    await expect(updateSelfPersonalContact(actor, { personalEmail: "not-an-email" }))
      .rejects.toBeInstanceOf(ValidationError);
    const after = await prisma.employee.findUnique({
      where: { id: employeeId }, select: { personalEmail: true },
    });
    expect(after!.personalEmail).toBe(before!.personalEmail);
  });

  it("invalid phone refused", async () => {
    const { actor } = await makeEmployee(fx);
    await expect(updateSelfPersonalContact(actor, { mobilePhone: "abc" }))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it("cross-Club actor → NotFoundError, row unchanged", async () => {
    const { employeeId, actor } = await makeEmployee(fx);
    const before = await prisma.employee.findUnique({
      where: { id: employeeId }, select: { personalEmail: true },
    });
    const crossClub: EmployeePortalPrincipal = { ...actor, clubId: fx.foreignClub.id };
    await expect(updateSelfPersonalContact(crossClub, { personalEmail: "x@x.test" }))
      .rejects.toBeInstanceOf(NotFoundError);
    const after = await prisma.employee.findUnique({
      where: { id: employeeId }, select: { personalEmail: true },
    });
    expect(after!.personalEmail).toBe(before!.personalEmail);
  });

  // -------------------------------------------------------------------------
  // Home address
  // -------------------------------------------------------------------------

  it("initial address read: all six fields null", async () => {
    const { actor } = await makeEmployee(fx);
    const a = await getSelfHomeAddress(actor);
    expect(a).toEqual({
      homeAddressLine1: null, homeAddressLine2: null, homeCity: null,
      homeProvince: null, homePostalCode: null, homeCountry: null,
    });
  });

  it("employee can save a full address; province + country + postal are upper-cased", async () => {
    const { employeeId, actor } = await makeEmployee(fx);
    await updateSelfHomeAddress(actor, {
      homeAddressLine1: "  123 Fairway Dr  ",
      homeCity: "Calgary",
      homeProvince: "ab",
      homePostalCode: "t2p 3n4",
      homeCountry: "ca",
    });
    const row = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        homeAddressLine1: true, homeCity: true, homeProvince: true,
        homePostalCode: true, homeCountry: true,
      },
    });
    expect(row!.homeAddressLine1).toBe("123 Fairway Dr");
    expect(row!.homeCity).toBe("Calgary");
    expect(row!.homeProvince).toBe("AB");
    expect(row!.homePostalCode).toBe("T2P 3N4");
    expect(row!.homeCountry).toBe("CA");
  });

  it("invalid country (non-ISO) refused", async () => {
    const { actor } = await makeEmployee(fx);
    await expect(updateSelfHomeAddress(actor, { homeCountry: "Canada" }))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it("cross-Club address write refused; source row untouched", async () => {
    const { employeeId, actor } = await makeEmployee(fx);
    const crossClub: EmployeePortalPrincipal = { ...actor, clubId: fx.foreignClub.id };
    await expect(updateSelfHomeAddress(crossClub, { homeAddressLine1: "attack" }))
      .rejects.toBeInstanceOf(NotFoundError);
    const row = await prisma.employee.findUnique({
      where: { id: employeeId }, select: { homeAddressLine1: true },
    });
    expect(row!.homeAddressLine1).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Emergency contact
  // -------------------------------------------------------------------------

  it("first upsert creates a primary emergency contact row", async () => {
    const { employeeId, actor } = await makeEmployee(fx);
    const initial = await getSelfPrimaryEmergencyContact(actor);
    expect(initial).toBeNull();
    await upsertSelfPrimaryEmergencyContact(actor, {
      name: "Jamie Smith", relation: "Spouse", phone: "(403) 555-0111",
    });
    const after = await getSelfPrimaryEmergencyContact(actor);
    expect(after).not.toBeNull();
    expect(after!.name).toBe("Jamie Smith");
    const rows = await prisma.employeeEmergencyContact.findMany({ where: { employeeId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isPrimary).toBe(true);
  });

  it("second upsert updates the SAME primary row (no duplicates)", async () => {
    const { employeeId, actor } = await makeEmployee(fx);
    await upsertSelfPrimaryEmergencyContact(actor, {
      name: "Jamie", relation: "Spouse", phone: "1111111111",
    });
    await upsertSelfPrimaryEmergencyContact(actor, {
      name: "Jamie Smith", relation: "Spouse", phone: "2222222222", email: "jamie@x.test",
    });
    const rows = await prisma.employeeEmergencyContact.findMany({ where: { employeeId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Jamie Smith");
    expect(rows[0]!.phone).toBe("2222222222");
  });

  it("cross-Club emergency-contact write refused", async () => {
    const { actor } = await makeEmployee(fx);
    const crossClub: EmployeePortalPrincipal = { ...actor, clubId: fx.foreignClub.id };
    await expect(upsertSelfPrimaryEmergencyContact(crossClub, {
      name: "X", relation: "Y", phone: "1234567890",
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("employee A cannot mutate employee B's emergency contact", async () => {
    const { actor: actorA, employeeId: aId } = await makeEmployee(fx);
    const { actor: actorB, employeeId: bId } = await makeEmployee(fx);
    await upsertSelfPrimaryEmergencyContact(actorA, {
      name: "A's contact", relation: "Sibling", phone: "1111111111",
    });
    await upsertSelfPrimaryEmergencyContact(actorB, {
      name: "B's contact", relation: "Sibling", phone: "2222222222",
    });
    const aRows = await prisma.employeeEmergencyContact.findMany({ where: { employeeId: aId } });
    const bRows = await prisma.employeeEmergencyContact.findMany({ where: { employeeId: bId } });
    expect(aRows).toHaveLength(1);
    expect(aRows[0]!.name).toBe("A's contact");
    expect(bRows).toHaveLength(1);
    expect(bRows[0]!.name).toBe("B's contact");
  });

  // -------------------------------------------------------------------------
  // Direct deposit — canonical HR-1H writer, from the portal
  // -------------------------------------------------------------------------

  it("first submit creates PENDING_PENNY_TEST row with masked last-4", async () => {
    const { employeeId, actor } = await makeEmployee(fx);
    const before = await getSelfBankMasked(actor);
    expect(before).toBeNull();
    await submitSelfBankReplacement(actor, {
      holderName: "Chris Turcato",
      institutionNumber: "001",
      transitNumber: "12345",
      accountNumber: "1234567",
    });
    const rows = await prisma.employeeBankAccount.findMany({ where: { employeeId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("PENDING_PENNY_TEST");
    expect(rows[0]!.accountLastFour).toBe("4567");
    // Employee CANNOT set VERIFIED — the writer refuses to fabricate
    // the grant; DB partial-unique also enforces the invariant.
    const masked = await getSelfBankMasked(actor);
    expect(masked).not.toBeNull();
    expect(masked!.status).toBe("PENDING_PENNY_TEST");
  });

  it("VERIFIED → INACTIVE + new PENDING (history preserved by canonical writer)", async () => {
    const { employeeId, actor } = await makeEmployee(fx);
    // Prime with a submitted row then hand-verify to simulate the
    // admin approving the first submission.
    await submitSelfBankReplacement(actor, {
      holderName: "Chris Turcato",
      institutionNumber: "001", transitNumber: "12345", accountNumber: "1234567",
    });
    const seed = await prisma.employeeBankAccount.findFirstOrThrow({ where: { employeeId } });
    await prisma.employeeBankAccount.update({
      where: { id: seed.id }, data: { status: "VERIFIED", activatedAt: new Date() },
    });
    // Now employee replaces.
    await submitSelfBankReplacement(actor, {
      holderName: "Chris Turcato",
      institutionNumber: "002", transitNumber: "67890", accountNumber: "9998887",
    });
    const rows = await prisma.employeeBankAccount.findMany({
      where: { employeeId }, orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe("INACTIVE");     // old preserved
    expect(rows[1]!.status).toBe("PENDING_PENNY_TEST"); // new
    expect(rows[1]!.accountLastFour).toBe("8887");
  });

  it("invalid banking (short account) refused; no row created", async () => {
    const { employeeId, actor } = await makeEmployee(fx);
    await expect(submitSelfBankReplacement(actor, {
      holderName: "Chris", institutionNumber: "001", transitNumber: "12345", accountNumber: "12",
    })).rejects.toBeInstanceOf(ValidationError);
    const rows = await prisma.employeeBankAccount.findMany({ where: { employeeId } });
    expect(rows).toHaveLength(0);
  });

  it("employee A submitting banking cannot touch employee B's row", async () => {
    const { actor: actorA, employeeId: aId } = await makeEmployee(fx);
    const { actor: actorB, employeeId: bId } = await makeEmployee(fx);
    await submitSelfBankReplacement(actorA, {
      holderName: "Alice A", institutionNumber: "001", transitNumber: "12345", accountNumber: "1111111",
    });
    await submitSelfBankReplacement(actorB, {
      holderName: "Bob B", institutionNumber: "002", transitNumber: "67890", accountNumber: "2222222",
    });
    const aRows = await prisma.employeeBankAccount.findMany({ where: { employeeId: aId } });
    const bRows = await prisma.employeeBankAccount.findMany({ where: { employeeId: bId } });
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0]!.holderName).toBe("Alice A");
    expect(bRows[0]!.holderName).toBe("Bob B");
  });
});

// ---------------------------------------------------------------------------
// User-menu + top-bar + shell source contract
// ---------------------------------------------------------------------------

describe("HR-2C Portal Refinement · shell + user-menu source contract", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");
  const userMenu = read("src/components/employee/EmployeePortalUserMenu.tsx");
  const topBar = read("src/components/employee/EmployeePortalTopBar.tsx");
  const sidebar = read("src/components/employee/EmployeePortalSidebar.tsx");
  const mobileNav = read("src/components/employee/EmployeePortalMobileNav.tsx");
  const layout = read("src/app/employee/(authed)/layout.tsx");
  const navData = read("src/components/sidebar-nav-data.ts");
  const home = read("src/app/employee/(authed)/page.tsx");

  it("account control shows FULL name (givenName + lastName), not first name only", () => {
    // The layout builds `displayName` from givenName + lastName and
    // passes it into the user menu. Regression: previously only
    // `preferredName ?? firstName` was passed, so "Chris Turcato"
    // rendered as "Chris".
    expect(layout).toMatch(/employee\.lastName/);
    expect(layout).toMatch(/`\$\{givenName\} \$\{employee\.lastName\.trim\(\)\}`/);
  });

  it("dropdown items: Help + Take portal tour + Sign out (Profile deliberately NOT in dropdown — it's a top-level nav item)", () => {
    expect(userMenu).toMatch(/data-testid="portal-user-menu-help"/);
    expect(userMenu).toMatch(/data-testid="portal-user-menu-take-tour"/);
    expect(userMenu).toMatch(/data-testid="portal-user-menu-signout"/);
    expect(userMenu).toMatch(/action="\/employee\/logout"/);
    // Profile is intentionally absent from the dropdown.
    expect(userMenu).not.toMatch(/data-testid="portal-user-menu-profile"/);
  });

  it("no admin routes (/app/**) or User Settings text in the portal menu (comments stripped)", () => {
    const stripped = userMenu
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(stripped).not.toMatch(/\/app\//);
    expect(stripped).not.toMatch(/User Settings/);
  });

  it("standalone Help + Sign out buttons removed from EmployeePortalTopBar", () => {
    expect(topBar).not.toMatch(/EmployeePortalHelpMenu/);
    expect(topBar).not.toMatch(/portal-signout/);
    // Header height is h-16 for alignment with the sidebar identity block.
    expect(topBar).toMatch(/h-16/);
  });

  it("standalone Help + Sign out buttons removed from EmployeePortalMobileNav", () => {
    expect(mobileNav).not.toMatch(/portal-mobile-signout/);
    expect(mobileNav).toMatch(/EmployeePortalUserMenu/);
  });

  it("sidebar identity block matches top-bar height so the top chrome forms one continuous horizontal band", () => {
    expect(sidebar).toMatch(/h-16/);
  });

  it("initials fallback exists when no photo; photo route is the same-origin portal route", () => {
    expect(userMenu).toMatch(/initialsFor/);
    expect(userMenu).toMatch(/\/api\/employee\/self\/profile-photo/);
  });

  it("EMPLOYEE_NAV is exactly Home + Profile (no Schedule / Availability / Pay / Safety & Training / Documents)", () => {
    const forbidden = ["/employee/schedule", "/employee/availability", "/employee/pay", "/employee/safety-training", "/employee/documents"];
    for (const href of forbidden) {
      // The literal string may appear in comments; strip block + line
      // comments before checking.
      const stripped = navData
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      const escaped = href.replace(/[/]/g, "\\/");
      const re = new RegExp(`href:\\s*"${escaped}"`);
      expect(stripped).not.toMatch(re);
    }
    expect(navData).toMatch(/href: "\/employee",\s+label: "Home"/);
    expect(navData).toMatch(/href: "\/employee\/profile"/);
  });
});

describe("HR-2C Portal Refinement · Home widgets source contract", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), "utf8");
  const home = read("src/app/employee/(authed)/page.tsx");

  it("six widgets in the exact DOM order the founder brief mandates", () => {
    const order = ["scheduling", "paystubs", "time-off-requests", "forms", "training", "clocking-in-out"];
    let pos = -1;
    for (const key of order) {
      const at = home.indexOf(`key: "${key}"`);
      expect(at, `widget ${key} present in DOM order`).toBeGreaterThan(pos);
      pos = at;
    }
  });

  it("Time Off Requests uses the suitcase icon (rect body + handle path)", () => {
    // Anchor to the rect + handle path unique to the suitcase silhouette.
    // Previous airplane silhouette used a runway line at y=20.5 —
    // that MUST NOT be present anymore.
    expect(home).not.toMatch(/runway/i);
    expect(home).not.toMatch(/y1="20\.5" x2="21" y2="20\.5"/);
    // Suitcase-specific markers:
    expect(home).toMatch(/function IconTimeOff\(\)/);
    expect(home).toMatch(/Handle/);
    expect(home).toMatch(/Body of the case/);
  });

  it("Training uses the graduation-cap silhouette (mortarboard path + tassel)", () => {
    // Graduation cap: the top polygon "M2.5 9.5 12 5l9.5 4.5L12 14 2.5 9.5z"
    expect(home).toMatch(/function IconTraining\(\)/);
    expect(home).toMatch(/M2\.5 9\.5 12 5l9\.5 4\.5L12 14 2\.5 9\.5z/);
    // Shield primitives from the previous icon MUST NOT survive.
    const stripped = home
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(stripped).not.toMatch(/M12 3l7 3v6c0 4\.5-3 8-7 9/);
  });

  it("Clocking In / Out uses a clock face (circle + hour+minute polyline)", () => {
    expect(home).toMatch(/function IconClock\(\)/);
    expect(home).toMatch(/<circle cx="12" cy="12" r="8\.5"/);
    // Must NOT reuse the calendar/scheduling shape.
    const clockBlock = home.slice(home.indexOf("function IconClock"), home.indexOf("function IconClock") + 500);
    expect(clockBlock).not.toMatch(/rect x="3\.5" y="5"/);
  });
});
