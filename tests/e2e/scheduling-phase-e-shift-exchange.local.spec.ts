// Scheduling Foundation · Phase E (2026-09-07) — multi-user
// shift-exchange end-to-end acceptance.
//
// Full lifecycle:
//   Employee A signs in → My Schedule → opens shift → Give Up →
//   sees SHIFT OFFERED / waiting
//   Employee B signs in → FORE! Shift Opportunities → sees offer →
//   Pick Up Shift → success toast on My Schedule
//   Manager Work Intake receives ONE informational reassignment card
//   Withdrawal: A offers another shift → withdraws → assignment stays

import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const OUT = path.resolve("test-results/scheduling-phase-e-shift-exchange");
fs.mkdirSync(OUT, { recursive: true });

const FIXTURE_SCRIPT = path.resolve("scripts/scheduling-phase-e-fixture.mjs");

interface FixtureOut {
  clubId: string; clubSlug: string; weekStartIso: string;
  employeeA: { id: string; loginEmail: string; password: string; assignmentId: string };
  employeeB: { id: string; loginEmail: string; password: string };
  shift: { id: string; startIso: string; endIso: string };
}
function primeFixture(): FixtureOut {
  const out = execFileSync("node", [FIXTURE_SCRIPT], {
    cwd: path.resolve("."), encoding: "utf8", timeout: 60_000,
  });
  return JSON.parse(out) as FixtureOut;
}

function shellFor(page: Page, viewport: "desktop" | "mobile"): Locator {
  return page.getByTestId(viewport === "desktop" ? "portal-desktop-shell" : "portal-mobile-shell");
}

async function loginAsEmployee(page: Page, email: string, password: string) {
  await page.goto("http://localhost:3000/employee/login", { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('[data-testid="employee-login-submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/employee/login"), { timeout: 30_000 })
    .catch(async () => {
      const err = await page.locator('[data-testid="employee-login-error"]').textContent().catch(() => "");
      throw new Error(`Employee login failed: "${err ?? ""}". URL: ${page.url()}`);
    });
}

test.describe.serial("Scheduling Foundation · Phase E · shift exchange end-to-end", () => {
  test.setTimeout(300_000);
  let prisma: PrismaClient;
  test.beforeAll(() => { prisma = new PrismaClient(); });
  test.afterAll(async () => { await prisma.$disconnect(); });

  test("§25 desktop 1440×900 — Employee A gives up → Employee B picks up → manager WI emitted", async ({ browser }) => {
    const fixture = primeFixture();

    // ---------- Employee A: sign in, open shift, offer ----------
    const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageA = await ctxA.newPage();
    await loginAsEmployee(pageA, fixture.employeeA.loginEmail, fixture.employeeA.password);
    await pageA.goto("http://localhost:3000/employee/schedule", { waitUntil: "domcontentloaded" });
    const shellA = shellFor(pageA, "desktop");
    await expect(shellA.getByTestId("portal-schedule-populated")).toBeVisible();
    // Click the shift card (data-testid tied to assignmentId).
    const shiftCardTestId = `portal-schedule-shift-${fixture.employeeA.assignmentId}`;
    // Wait for hydration then click. The shift button lives inside
    // the currently-visible desktop shell; the panel is a fixed-
    // positioned descendant that also lives in the same tree.
    await pageA.waitForTimeout(500);
    await shellA.getByTestId(shiftCardTestId).click();
    // The panel is inside the desktop shell's ScheduleView instance,
    // but its `fixed` positioning + Tailwind CSS visibility can
    // occasionally trip strict-mode/isVisible in a brief render
    // window. Wait for it to appear either scoped or page-wide.
    await pageA.getByTestId("portal-schedule-shift-panel").first().waitFor({
      state: "visible", timeout: 15_000,
    });
    await pageA.getByTestId("portal-schedule-give-up-open").first().click();
    await expect(pageA.getByTestId("portal-schedule-give-up-form").first()).toBeVisible();
    await pageA.getByTestId("portal-schedule-give-up-reason").first().selectOption("PERSONAL");
    await pageA.getByTestId("portal-schedule-give-up-submit").first().click();
    await pageA.waitForURL(/\/employee\/schedule\?offered=1/, { timeout: 15_000 });
    // Offered-state banner + shift card carries offered treatment.
    await expect(shellA.getByTestId("portal-schedule-toast-success")).toBeVisible();
    await expect(shellA.getByTestId(`portal-schedule-shift-offered-${fixture.employeeA.assignmentId}`))
      .toBeVisible();
    await pageA.screenshot({ path: path.join(OUT, "desktop-1440x900-a-offered.png"), fullPage: true });
    await ctxA.close();

    // ---------- Employee B: sign in, open FORE! shifts tab, pick up ----------
    const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageB = await ctxB.newPage();
    await loginAsEmployee(pageB, fixture.employeeB.loginEmail, fixture.employeeB.password);
    // Homepage should show the restrained "1 shift available" indicator.
    await pageB.goto("http://localhost:3000/employee", { waitUntil: "domcontentloaded" });
    const shellBHome = shellFor(pageB, "desktop");
    await expect(shellBHome.getByTestId("portal-desktop-announcements-shifts-indicator"))
      .toBeVisible();
    await pageB.screenshot({ path: path.join(OUT, "desktop-1440x900-b-home-indicator.png"), fullPage: true });
    // Follow the indicator link → FORE! Shift Opportunities tab.
    await pageB.goto("http://localhost:3000/employee/announcements?tab=shifts",
      { waitUntil: "domcontentloaded" });
    const shellB = shellFor(pageB, "desktop");
    await expect(shellB.getByTestId("fore-tab-content-shifts")).toBeVisible();
    await expect(shellB.getByTestId("fore-shifts-list")).toBeVisible();
    await pageB.screenshot({ path: path.join(OUT, "desktop-1440x900-b-fore-tabs.png"), fullPage: true });
    // Locate + click "View Shift" for the offered opportunity.
    const oppLocator = shellB.locator('[data-testid^="fore-shifts-view-"]').first();
    await oppLocator.click();
    await expect(shellB.getByTestId("fore-pickup-panel")).toBeVisible();
    await pageB.screenshot({ path: path.join(OUT, "desktop-1440x900-b-pickup-drawer.png"), fullPage: true });
    // Submit pickup.
    await shellB.getByTestId("fore-pickup-submit").click();
    await pageB.waitForURL(/\/employee\/schedule\?picked=/, { timeout: 15_000 });
    await expect(shellB.getByTestId("portal-schedule-toast-success")).toBeVisible();
    await pageB.screenshot({ path: path.join(OUT, "desktop-1440x900-b-picked-success.png"), fullPage: true });
    // Employee B's schedule now contains the new assignment.
    const bShift = await prisma.shiftAssignment.findFirst({
      where: { clubId: fixture.clubId, employeeId: fixture.employeeB.id, state: "ASSIGNED" },
    });
    expect(bShift).toBeTruthy();
    expect(bShift?.shiftId).toBe(fixture.shift.id);
    await ctxB.close();

    // ---------- DB assertions ----------
    // Original assignment REPLACED, exactly one ASSIGNED for this shift.
    const activeCount = await prisma.shiftAssignment.count({
      where: { clubId: fixture.clubId, shiftId: fixture.shift.id, state: "ASSIGNED" },
    });
    expect(activeCount).toBe(1);
    const original = await prisma.shiftAssignment.findUniqueOrThrow({
      where: { id: fixture.employeeA.assignmentId },
    });
    expect(original.state).toBe("REPLACED");
    // Opportunity CLAIMED.
    const opps = await prisma.shiftOpportunity.findMany({
      where: { clubId: fixture.clubId, shiftId: fixture.shift.id },
    });
    expect(opps.length).toBe(1);
    expect(opps[0].state).toBe("CLAIMED");
    expect(opps[0].claimedByEmployeeId).toBe(fixture.employeeB.id);
    // Manager Work Intake — exactly ONE informational card for this shift.
    const wi = await prisma.workIntakeItem.findMany({
      where: { clubId: fixture.clubId, workSubtype: "SHIFT_REASSIGNMENT" },
    });
    expect(wi.length).toBe(1);
    expect(wi[0].workIntent).toBe("NOTIFY");
  });

  test("§25 mobile 390×844 — Employee A gives up (bottom sheet)", async ({ browser }) => {
    const fixture = primeFixture();
    const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pageA = await ctxA.newPage();
    await loginAsEmployee(pageA, fixture.employeeA.loginEmail, fixture.employeeA.password);
    await pageA.goto("http://localhost:3000/employee/schedule", { waitUntil: "domcontentloaded" });
    const shellA = shellFor(pageA, "mobile");
    await expect(shellA.getByTestId("portal-schedule-populated")).toBeVisible();
    // Mobile shift card lives in the selected-day detail.
    const mobileShift = shellA.locator(`[data-testid="portal-schedule-mobile-shift-${fixture.employeeA.assignmentId}"]`);
    // Ensure the correct day is selected (Tuesday of week; the
    // fixture's shift is TOMORROW so the date strip may need a tap).
    const shiftDay = fixture.shift.startIso.slice(0, 10);
    const dayButton = shellA.locator(`[data-testid="portal-schedule-mobile-day-${shiftDay}"]`);
    if (await dayButton.count()) await dayButton.click();
    await expect(mobileShift.first()).toBeVisible();
    // Wait for hydration; the mobile shell's ScheduleView needs the
    // client bundle for onClick handlers to fire.
    await pageA.waitForLoadState("networkidle", { timeout: 20_000 });
    await pageA.waitForTimeout(1000);
    await mobileShift.first().click({ force: true });
    await pageA.getByTestId("portal-schedule-shift-panel").first().waitFor({
      state: "visible", timeout: 15_000,
    });
    await pageA.screenshot({ path: path.join(OUT, "mobile-390x844-a-shift-panel.png"), fullPage: false });
    await pageA.getByTestId("portal-schedule-give-up-open").first().click();
    await pageA.screenshot({ path: path.join(OUT, "mobile-390x844-a-give-up-form.png"), fullPage: false });
    await pageA.getByTestId("portal-schedule-give-up-submit").first().click();
    await pageA.waitForURL(/\/employee\/schedule\?offered=1/, { timeout: 15_000 });
    await pageA.screenshot({ path: path.join(OUT, "mobile-390x844-a-offered.png"), fullPage: false });
    const bodyScrollWidth = await pageA.evaluate(() => document.body.scrollWidth);
    expect(bodyScrollWidth).toBeLessThanOrEqual(400);
    await ctxA.close();
  });

  test("§25 withdrawal — A offers, A withdraws, assignment stays ASSIGNED", async ({ browser }) => {
    const fixture = primeFixture();
    const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageA = await ctxA.newPage();
    await loginAsEmployee(pageA, fixture.employeeA.loginEmail, fixture.employeeA.password);
    await pageA.goto("http://localhost:3000/employee/schedule", { waitUntil: "domcontentloaded" });
    const shellA = shellFor(pageA, "desktop");
    await pageA.waitForTimeout(500);
    await shellA.getByTestId(`portal-schedule-shift-${fixture.employeeA.assignmentId}`).click();
    await pageA.getByTestId("portal-schedule-shift-panel").first().waitFor({
      state: "visible", timeout: 15_000,
    });
    await pageA.getByTestId("portal-schedule-give-up-open").first().click();
    await pageA.getByTestId("portal-schedule-give-up-submit").first().click();
    await pageA.waitForURL(/\/employee\/schedule\?offered=1/, { timeout: 15_000 });
    // The panel closes itself on submit and the redirect re-renders.
    // Reopen panel + withdraw.
    await pageA.waitForTimeout(500);
    await shellA.getByTestId(`portal-schedule-shift-${fixture.employeeA.assignmentId}`).click();
    await pageA.getByTestId("portal-schedule-withdraw-offer").first().waitFor({
      state: "visible", timeout: 15_000,
    });
    await pageA.getByTestId("portal-schedule-withdraw-offer").first().click();
    await pageA.waitForURL(/\/employee\/schedule\?withdrawn=1/, { timeout: 15_000 });
    // Shift no longer offered.
    const opps = await prisma.shiftOpportunity.findMany({
      where: { clubId: fixture.clubId, shiftId: fixture.shift.id },
    });
    expect(opps.length).toBe(1);
    expect(opps[0].state).toBe("WITHDRAWN");
    const asn = await prisma.shiftAssignment.findUniqueOrThrow({
      where: { id: fixture.employeeA.assignmentId },
    });
    expect(asn.state).toBe("ASSIGNED");
    await ctxA.close();
  });
});
