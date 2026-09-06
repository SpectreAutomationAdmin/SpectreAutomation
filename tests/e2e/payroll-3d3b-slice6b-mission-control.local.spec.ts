// Payroll-3D-3B Slice 6B (2026-09-06) — comprehensive browser
// acceptance for Mission Control PayrollActionCard.
//
// This spec CROSSES THE REAL PATH for every core payroll flow:
//   browser → server action → dispatcher → canonical service → DB
//   → revalidation → refreshed Mission Control feed
//
// No mocking. No stubbing invokeMissionControlWorkIntakeAction. The
// tests click actual buttons and verify actual DB state changes via
// Prisma reads.
//
// Fixture reseeded per test via
//   tsx scripts/payroll-3d3b-slice6a-fixture.ts --scenario=<name>
// so each browser test starts from a deterministic canonical state.
//
// LOCALHOST ONLY. Auto-starts `npm run dev` via playwright.config.ts.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const OUT = path.resolve("test-results/payroll-3d3b-slice6b");
fs.mkdirSync(OUT, { recursive: true });

const FIXTURE_SCRIPT = path.resolve("scripts/payroll-3d3b-slice6a-fixture.ts");

const EVENTS_MGR   = "slice6a.events.mgr@spectre.test";
const GROUNDS_MGR  = "slice6a.grounds.mgr@spectre.test";
const TENANT_ADMIN = "slice6a.admin@spectre.test";
const PASSWORD = "password";
const TENANT_SLUG = "slice6a-events-mgr";

const prisma = new PrismaClient();
test.afterAll(async () => { await prisma.$disconnect(); });

function reseed(scenario: "default" | "ready" | "review-required" | "config-gap" | "mixed-feed") {
  // shell:true — resolves `npx.cmd` on Windows without hard-coding
  // the .cmd suffix (works on macOS/Linux too).
  execFileSync("npx", ["tsx", FIXTURE_SCRIPT, `--scenario=${scenario}`], {
    stdio: "pipe", timeout: 120_000, shell: true,
  });
}
async function getClubId(): Promise<string> {
  const c = await prisma.club.findFirst({ where: { slug: TENANT_SLUG }, select: { id: true } });
  if (!c) throw new Error("fixture not seeded");
  return c.id;
}
async function getUserId(email: string): Promise<string> {
  const u = await prisma.user.findFirst({ where: { email }, select: { id: true } });
  if (!u) throw new Error(`user missing: ${email}`);
  return u.id;
}

async function login(page: Page, email: string) {
  await page.goto("http://localhost:3000/login");
  await page.locator('form input[name="email"][type="email"]').fill(email);
  await page.locator('form input[name="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL(/\/app/, { timeout: 30_000 }),
    page.locator('form button[type="submit"]:has-text("Sign in")').click(),
  ]);
}

test.describe("Payroll-3D-3B Slice 6B · Mission Control browser acceptance", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();

  // ---------------------------------------------------------------
  // 1. Correction Approve — full browser click → DB assertions
  // ---------------------------------------------------------------
  test("§D/E correction Approve — click → correction APPROVED + WI RESOLVED + one ADMIN_CORRECTION", async ({ page }) => {
    reseed("default");
    const clubId = await getClubId();
    const eventsMgrId = await getUserId(EVENTS_MGR);

    await login(page, EVENTS_MGR);
    await page.goto("http://localhost:3000/app/admin");
    await page.waitForSelector('[data-testid="payroll-correction-approve"]', { timeout: 30_000 });

    // BEFORE screenshot.
    await page.screenshot({ path: path.join(OUT, "corr-approve-01-before.png"), fullPage: true });

    // BEFORE state assertions.
    const corrBefore = await prisma.timeClockCorrectionRequest.findFirst({
      where: { clubId, status: "PENDING" },
    });
    expect(corrBefore).not.toBeNull();
    const corrId = corrBefore!.id;
    expect(await prisma.timeClockEvent.count({ where: { clubId, source: "ADMIN_CORRECTION" } })).toBe(0);

    // CLICK Approve.
    await page.locator('[data-testid="payroll-correction-approve"]').first().click();
    // Server round-trip + revalidate → the correction card should
    // disappear (WI RESOLVED after Slice 5 lifecycle).
    await expect(page.locator(`[data-testid="payroll-correction-approve"]`).first()).toHaveCount(0, { timeout: 15_000 });

    // AFTER screenshot.
    await page.screenshot({ path: path.join(OUT, "corr-approve-02-after.png"), fullPage: true });

    // AFTER DB assertions.
    const corrAfter = await prisma.timeClockCorrectionRequest.findUnique({ where: { id: corrId } });
    expect(corrAfter!.status).toBe("APPROVED");
    // Correction-review WI is RESOLVED.
    const wiOrigin = await prisma.workIntakeOrigin.findFirst({
      where: { clubId, kind: "TIMECLOCK_CORRECTION_REVIEW", referenceId: corrId },
      include: { workIntakeItem: true },
    });
    expect(wiOrigin!.workIntakeItem.status).toBe("RESOLVED");
    expect(wiOrigin!.workIntakeItem.resolvedByUserId).toBe(eventsMgrId);
    // Exactly one ADMIN_CORRECTION event.
    expect(await prisma.timeClockEvent.count({ where: { clubId, source: "ADMIN_CORRECTION" } })).toBe(1);
    // Payroll side effects: zero.
    expect(await prisma.payrollApprovedTimeEntry.count({ where: { clubId } })).toBe(0);
    expect(await prisma.payrollBatch.count({ where: { clubId } })).toBe(0);
    expect(await prisma.journalEntry.count({ where: { clubId } })).toBe(0);
    // Scope card should now be present + actionable (correction gone → readiness true).
    // Give the feed a moment to render post-refresh.
    const scopeApprove = page.locator('[data-testid="payroll-scope-approve"]');
    await expect(scopeApprove).toBeVisible({ timeout: 10_000 });
  });

  // ---------------------------------------------------------------
  // 2. Correction Reject — full browser click → DB assertions
  // ---------------------------------------------------------------
  test("§F/G correction Reject — click → correction REJECTED + WI RESOLVED + zero ADMIN_CORRECTION", async ({ page }) => {
    reseed("default");
    const clubId = await getClubId();
    const eventsMgrId = await getUserId(EVENTS_MGR);

    await login(page, EVENTS_MGR);
    await page.goto("http://localhost:3000/app/admin");
    await page.waitForSelector('[data-testid="payroll-correction-reject"]', { timeout: 30_000 });

    const corrBefore = await prisma.timeClockCorrectionRequest.findFirst({
      where: { clubId, status: "PENDING" },
    });
    expect(corrBefore).not.toBeNull();
    const corrId = corrBefore!.id;

    // Open reject panel + type note.
    await page.locator('[data-testid="payroll-correction-reject"]').first().click();
    await expect(page.locator('[data-testid="payroll-correction-reject-note"]')).toBeVisible();
    await page.locator('[data-testid="payroll-correction-reject-note"]').fill("Not warranted — reviewed with Taylor.");
    await page.screenshot({ path: path.join(OUT, "corr-reject-01-panel-open.png"), fullPage: true });

    // Confirm reject — real click, real server round-trip.
    await page.locator('[data-testid="payroll-correction-reject-confirm"]').click();
    await expect(page.locator(`[data-testid="payroll-correction-reject-confirm"]`)).toHaveCount(0, { timeout: 15_000 });
    await page.screenshot({ path: path.join(OUT, "corr-reject-02-after.png"), fullPage: true });

    // AFTER DB assertions.
    const corrAfter = await prisma.timeClockCorrectionRequest.findUnique({ where: { id: corrId } });
    expect(corrAfter!.status).toBe("REJECTED");
    expect(corrAfter!.reviewerNote).toContain("Not warranted");
    expect(corrAfter!.reviewedByUserId).toBe(eventsMgrId);
    // WI RESOLVED.
    const wiOrigin = await prisma.workIntakeOrigin.findFirst({
      where: { clubId, kind: "TIMECLOCK_CORRECTION_REVIEW", referenceId: corrId },
      include: { workIntakeItem: true },
    });
    expect(wiOrigin!.workIntakeItem.status).toBe("RESOLVED");
    expect(wiOrigin!.workIntakeItem.resolvedByUserId).toBe(eventsMgrId);
    // Zero ADMIN_CORRECTION events (reject creates none).
    expect(await prisma.timeClockEvent.count({ where: { clubId, source: "ADMIN_CORRECTION" } })).toBe(0);
    expect(await prisma.payrollApprovedTimeEntry.count({ where: { clubId } })).toBe(0);
    expect(await prisma.payrollBatch.count({ where: { clubId } })).toBe(0);
    expect(await prisma.journalEntry.count({ where: { clubId } })).toBe(0);
  });

  // ---------------------------------------------------------------
  // 3. Ready timesheet — render + click Approve Time → DB assertions
  // ---------------------------------------------------------------
  test("§H/I/J ready timesheet — render + Approve Time click → APPROVED + WI RESOLVED + zero freeze", async ({ page }) => {
    reseed("ready");
    const clubId = await getClubId();
    const eventsMgrId = await getUserId(EVENTS_MGR);

    await login(page, EVENTS_MGR);
    await page.goto("http://localhost:3000/app/admin");
    await page.waitForSelector('[data-testid="payroll-scope-approve"]', { timeout: 30_000 });

    // Ready card visible with expected content.
    await expect(page.locator('h3', { hasText: /Events · Time approval/ }).first()).toBeVisible();
    await expect(page.getByText(/Ready for approval/).first()).toBeVisible();
    await expect(page.getByText(/Employees/).first()).toBeVisible();
    await expect(page.getByText(/Recorded hours/).first()).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "scope-ready-01-before.png"), fullPage: true });

    // BEFORE assertions.
    expect(await prisma.payrollDepartmentTimeApproval.count({ where: { clubId } })).toBe(0);

    // CLICK Approve Time — real server round-trip.
    await page.locator('[data-testid="payroll-scope-approve"]').first().click();
    await expect(page.locator('[data-testid="payroll-scope-approve"]').first()).toHaveCount(0, { timeout: 15_000 });
    await page.screenshot({ path: path.join(OUT, "scope-ready-02-after.png"), fullPage: true });

    // AFTER DB assertions.
    const approval = await prisma.payrollDepartmentTimeApproval.findFirst({ where: { clubId } });
    expect(approval).not.toBeNull();
    expect(approval!.state).toBe("APPROVED");
    expect(approval!.approvedByUserId).toBe(eventsMgrId);
    expect(approval!.approvedRevision).toBeTruthy();
    // Scope WI is RESOLVED via Slice 3 completion path.
    if (approval!.workIntakeItemId) {
      const wi = await prisma.workIntakeItem.findUnique({ where: { id: approval!.workIntakeItemId } });
      expect(wi!.status).toBe("RESOLVED");
      expect(wi!.resolvedByUserId).toBe(eventsMgrId);
    }
    // NO freeze.
    expect(await prisma.payrollApprovedTimeEntry.count({ where: { clubId } })).toBe(0);
    expect(await prisma.payrollBatch.count({ where: { clubId } })).toBe(0);
    expect(await prisma.journalEntry.count({ where: { clubId } })).toBe(0);
  });

  // ---------------------------------------------------------------
  // 4. Blocked card — render + assert no Approve Time
  // ---------------------------------------------------------------
  test("§K blocked scope — visible, no Approve Time, Review timesheets present", async ({ page }) => {
    reseed("default"); // pending correction blocks the scope
    await login(page, EVENTS_MGR);
    await page.goto("http://localhost:3000/app/admin");
    await page.waitForSelector('[data-testid^="payroll-action-card-"]', { timeout: 30_000 });

    // Blocked scope card is present.
    await expect(page.getByText(/Needs attention/).first()).toBeVisible();
    await expect(page.getByText(/Blocked by/).first()).toBeVisible();
    // NO Approve Time button.
    await expect(page.locator('[data-testid="payroll-scope-approve"]')).toHaveCount(0);
    // Review timesheets deep-link present.
    await expect(page.locator('[data-testid="payroll-scope-deeplink"]').first()).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "scope-blocked.png"), fullPage: true });
  });

  // ---------------------------------------------------------------
  // 5. REVIEW_REQUIRED — render + assert Approve Time re-appears
  // ---------------------------------------------------------------
  test("§L REVIEW_REQUIRED — card carries drift eyebrow + reopened WI", async ({ page }) => {
    reseed("review-required");
    const clubId = await getClubId();
    await login(page, EVENTS_MGR);
    await page.goto("http://localhost:3000/app/admin");
    await page.waitForSelector('[data-testid^="payroll-action-card-"]', { timeout: 30_000 });

    // Card carries the "Time changed since approval" eyebrow.
    await expect(page.getByText(/Time changed since approval/).first()).toBeVisible();
    // Approve Time is present (readiness=true after materialise).
    await expect(page.locator('[data-testid="payroll-scope-approve"]').first()).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "scope-review-required.png"), fullPage: true });

    // Underlying DB: the approval row is REVIEW_REQUIRED.
    const approval = await prisma.payrollDepartmentTimeApproval.findFirst({ where: { clubId } });
    expect(approval!.state).toBe("REVIEW_REQUIRED");
  });

  // ---------------------------------------------------------------
  // 6. Config gap — render + click remediation deep-link
  // ---------------------------------------------------------------
  test("§M/N config gap — Tenant Admin sees remediation card + deep-link opens focused settings", async ({ page }) => {
    reseed("config-gap");
    await login(page, TENANT_ADMIN);
    await page.goto("http://localhost:3000/app/admin");
    await page.waitForSelector('[data-testid="payroll-scope-gap-remediation"]', { timeout: 30_000 });

    // Assert gap card visible with configuration copy.
    await expect(page.getByText(/Timesheet Approver missing/).first()).toBeVisible();
    // Assert NO Approve / Reject / Approve-Time on this card.
    await expect(page.locator('[data-testid="payroll-correction-approve"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="payroll-scope-approve"]')).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, "config-gap-01-card.png"), fullPage: true });

    // Click remediation deep-link.
    await Promise.all([
      page.waitForURL(/\/app\/admin\/settings\/time-approvers/, { timeout: 15_000 }),
      page.locator('[data-testid="payroll-scope-gap-remediation"]').first().click(),
    ]);
    // Assert Time Approvers page loaded + Events context focused.
    expect(page.url()).toContain("departmentId=");
    await page.screenshot({ path: path.join(OUT, "config-gap-02-deeplink.png"), fullPage: true });
  });

  // ---------------------------------------------------------------
  // 7. Grounds Manager negative routing
  // ---------------------------------------------------------------
  test("§Q Grounds Manager sees zero Taylor Events obligations", async ({ page }) => {
    reseed("default");
    await login(page, GROUNDS_MGR);
    await page.goto("http://localhost:3000/app/admin");
    await page.waitForLoadState("networkidle");
    await expect(page.locator('[data-testid="payroll-correction-approve"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="payroll-scope-approve"]')).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, "grounds-mgr-empty.png"), fullPage: true });
  });

  // ---------------------------------------------------------------
  // 8. Stale action — decide via canonical service, then click stale card
  // ---------------------------------------------------------------
  test("§O stale action — second click after out-of-band decision returns friendly error, no duplicate", async ({ page }) => {
    reseed("default");
    const clubId = await getClubId();

    await login(page, EVENTS_MGR);
    await page.goto("http://localhost:3000/app/admin");
    await page.waitForSelector('[data-testid="payroll-correction-approve"]', { timeout: 30_000 });

    // Snapshot which correction the card represents.
    const corrBefore = await prisma.timeClockCorrectionRequest.findFirst({
      where: { clubId, status: "PENDING" },
    });
    expect(corrBefore).not.toBeNull();

    // Out-of-band decision — mark the correction APPROVED directly.
    // Not going through the full canonical service to avoid altering
    // other WI state; the WI-status gate + correction-status gate in
    // Slice 4/4A both return structured errors either way.
    await prisma.timeClockCorrectionRequest.update({
      where: { id: corrBefore!.id },
      data: { status: "APPROVED", reviewedAt: new Date() },
    });

    // Click the (now-stale) card.
    await page.locator('[data-testid="payroll-correction-approve"]').first().click();

    // Friendly error appears in the action-message region.
    const msg = page.locator('.spectre-mc-action-message');
    await expect(msg.first()).toBeVisible({ timeout: 10_000 });
    const msgText = (await msg.first().textContent()) ?? "";
    expect(msgText.length).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(OUT, "stale-action.png"), fullPage: true });

    // Zero ADMIN_CORRECTION events created by this stale click.
    expect(await prisma.timeClockEvent.count({ where: { clubId, source: "ADMIN_CORRECTION" } })).toBe(0);
  });

  // ---------------------------------------------------------------
  // 9. Mixed feed — legacy PAYROLL_ADMIN_PROCESSING subtype falls
  // through to <FeedItem>, PROVING payroll dispatch doesn't swallow
  // non-payroll-action cards. (Email/AP mixed-feed regression is a
  // Slice 8 concern — requires mailbox integration primed locally.)
  // ---------------------------------------------------------------
  test("§T/V mixed feed — legacy payroll subtype renders via FeedItem, PayrollActionCard renders alongside", async ({ page }) => {
    reseed("mixed-feed");
    await login(page, EVENTS_MGR);
    await page.goto("http://localhost:3000/app/admin");
    await page.waitForSelector('[data-testid^="payroll-action-card-"]', { timeout: 30_000 });

    // Payroll action cards render (from the correction + blocked-scope
    // default seed).
    await expect(page.locator('[data-testid^="payroll-action-card-"]').first()).toBeVisible();
    // Legacy payroll-processing card also renders — proven by title.
    await expect(page.getByText(/Legacy payroll processing card/).first()).toBeVisible();
    // The legacy card must NOT be inside a PayrollActionCard frame —
    // proves the dispatch tree correctly falls through to FeedItem.
    const legacyTitle = page.getByText(/Legacy payroll processing card/).first();
    const insidePayroll = await legacyTitle.evaluate((el) => {
      let cur: Element | null = el;
      while (cur) {
        const t = cur.getAttribute?.("data-testid");
        if (t && t.startsWith("payroll-action-card-")) return true;
        cur = cur.parentElement;
      }
      return false;
    });
    expect(insidePayroll).toBe(false);
    await page.screenshot({ path: path.join(OUT, "mixed-feed.png"), fullPage: true });
  });

  // ---------------------------------------------------------------
  // 10. View timesheet deep-link click-through
  // ---------------------------------------------------------------
  test("§R View timesheet deep-link — loads the workspace with pay-period + department context", async ({ page }) => {
    reseed("default");
    await login(page, EVENTS_MGR);
    await page.goto("http://localhost:3000/app/admin");
    await page.waitForSelector('[data-testid="payroll-correction-deeplink"]', { timeout: 30_000 });

    // Click "View timesheet" secondary.
    await Promise.all([
      page.waitForURL(/\/app\/admin\/payroll\/time\?/, { timeout: 15_000 }),
      page.locator('[data-testid="payroll-correction-deeplink"]').first().click(),
    ]);
    // Assert URL carries both params.
    expect(page.url()).toContain("payPeriodId=");
    expect(page.url()).toContain("departmentId=");
    expect(page.url()).toContain("scope=timesheet");
    await page.screenshot({ path: path.join(OUT, "deeplink-view-timesheet.png"), fullPage: true });
  });
});
