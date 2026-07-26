// Club Settings — fiscal-year-end change end-to-end.
//
// Acceptance criterion: changing the fiscal year end in Club
// Settings immediately affects the next Jonas import without any
// code changes or application restart.
//
// This spec walks the WHOLE founder workflow against the live dev
// server:
//   1. Set Silver Springs' ClubProfile to a known baseline (June 30)
//      via direct prisma write
//   2. Navigate to /app/admin/club-settings — confirm UI shows June 30
//   3. Change the form to December 31
//   4. Click Save
//   5. Confirm the green "Saved" banner appears
//   6. Reload the page (fresh server fetch)
//   7. Confirm the UI still shows December 31 (data persisted)
//   8. Query Prisma directly + confirm DB row shows month=12, day=31
//   9. (Acceptance) Run the Jonas-import resolver path against this
//      live setting → confirm Apr 2026 statement resolves to FY2026
//      period 4 (not period 10 which the prior June 30 setting gave)

import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

import {
  computeFiscalLabels,
  computeFiscalYearStart,
  DEFAULT_FISCAL_YEAR_END,
  lastDayOfMonthUtc,
} from "@/lib/reporting/ledger/importers/jonas-fiscal-period";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

const prisma = new PrismaClient();

async function getSilverSpringsProfile(): Promise<{
  clubId: string;
  fiscalYearEndMonth: number | null;
  fiscalYearEndDay: number | null;
}> {
  const club = await prisma.club.findFirst({
    where: { slug: "silver-springs" },
    select: { id: true },
  });
  if (!club) throw new Error("Silver Springs not seeded");
  const profile = await prisma.clubProfile.findUnique({
    where: { clubId: club.id },
    select: { fiscalYearEndMonth: true, fiscalYearEndDay: true },
  });
  return {
    clubId: club.id,
    fiscalYearEndMonth: profile?.fiscalYearEndMonth ?? null,
    fiscalYearEndDay: profile?.fiscalYearEndDay ?? null,
  };
}

async function setSilverSpringsFiscalYearEnd(month: number, day: number) {
  const { clubId } = await getSilverSpringsProfile();
  await prisma.clubProfile.upsert({
    where: { clubId },
    update: { fiscalYearEndMonth: month, fiscalYearEndDay: day },
    create: { clubId, fiscalYearEndMonth: month, fiscalYearEndDay: day },
  });
}

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test.describe("Club Settings — fiscal-year-end save flow", () => {
  test.afterAll(async () => {
    await prisma.$disconnect();
  });

  test("change FY end from Jun 30 → Dec 31 via UI; persists in DB; survives reload; affects next Jonas resolution", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    // -----------------------------------------------------------------
    // Baseline — set Silver Springs to Jun 30 via direct prisma write.
    // -----------------------------------------------------------------
    await setSilverSpringsFiscalYearEnd(6, 30);
    const baseline = await getSilverSpringsProfile();
    expect(baseline.fiscalYearEndMonth, "baseline set in DB").toBe(6);
    expect(baseline.fiscalYearEndDay).toBe(30);

    // -----------------------------------------------------------------
    // STAGE 1 — Open Club Settings, confirm UI reflects Jun 30.
    // -----------------------------------------------------------------
    await login(page);
    await page.goto("/app/admin/club-settings");
    await page
      .locator('[data-testid="club-settings-form"]')
      .waitFor({ timeout: 15_000 });

    // The dropdown is a native <select> — confirm its current value.
    await expect(page.locator('select[name="fiscalYearEndMonth"]')).toHaveValue(
      "6",
    );
    await expect(page.locator('input[name="fiscalYearEndDay"]')).toHaveValue(
      "30",
    );

    // -----------------------------------------------------------------
    // STAGE 2 — Change the dropdown + day, save.
    // -----------------------------------------------------------------
    await page.selectOption('select[name="fiscalYearEndMonth"]', "12");
    await page.fill('input[name="fiscalYearEndDay"]', "31");
    await page.locator('[data-testid="club-settings-save"]').click();

    // -----------------------------------------------------------------
    // STAGE 3 — Confirm the green success banner appears.
    // -----------------------------------------------------------------
    await expect(
      page.locator('[data-testid="club-settings-save-ok"]'),
    ).toBeVisible({ timeout: 10_000 });
    // NO error banner.
    expect(
      await page.locator('[data-testid="club-settings-save-error"]').count(),
    ).toBe(0);

    // -----------------------------------------------------------------
    // STAGE 4 — Reload the page; confirm UI still shows Dec 31.
    // -----------------------------------------------------------------
    await page.goto("/app/admin/club-settings");
    await page
      .locator('[data-testid="club-settings-form"]')
      .waitFor({ timeout: 15_000 });
    await expect(page.locator('select[name="fiscalYearEndMonth"]')).toHaveValue(
      "12",
    );
    await expect(page.locator('input[name="fiscalYearEndDay"]')).toHaveValue(
      "31",
    );

    // -----------------------------------------------------------------
    // STAGE 5 — Query the DB directly. fiscalYearEndMonth=12, day=31.
    // -----------------------------------------------------------------
    const persisted = await getSilverSpringsProfile();
    expect(
      persisted.fiscalYearEndMonth,
      "DB row has Dec 31 after UI save + reload",
    ).toBe(12);
    expect(persisted.fiscalYearEndDay).toBe(31);

    // -----------------------------------------------------------------
    // STAGE 6 (acceptance) — The next Jonas-import resolution reflects
    // Dec 31 immediately. Re-runs the same code path the import
    // route uses: read profile → computeFiscalLabels.
    // -----------------------------------------------------------------
    const freshLookup = await getSilverSpringsProfile();
    const fyEndMonth =
      freshLookup.fiscalYearEndMonth ?? DEFAULT_FISCAL_YEAR_END.month;
    const fyEndDay = freshLookup.fiscalYearEndDay ?? DEFAULT_FISCAL_YEAR_END.day;
    const periodEnd = lastDayOfMonthUtc(2026, 4); // Apr 30, 2026
    const start = computeFiscalYearStart(periodEnd, fyEndMonth, fyEndDay);
    const labels = computeFiscalLabels(periodEnd, fyEndMonth, fyEndDay);

    expect(
      start.toISOString().slice(0, 10),
      "next Jonas resolution: FY start uses LIVE setting",
    ).toBe("2026-01-01"); // would be 2025-07-01 under old Jun 30 setting
    expect(
      labels.fiscalPeriodNum,
      "next Jonas resolution: fiscal period uses LIVE setting",
    ).toBe(4); // would be 10 under old Jun 30 setting

    // -----------------------------------------------------------------
    // Restore baseline for the dev environment (so other workflows
    // continue against Silver Springs' usual settings).
    // -----------------------------------------------------------------
    await setSilverSpringsFiscalYearEnd(6, 30);
  });

  test("if save fails on another field, error banner is prominent + DB unchanged", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    // Set a known baseline.
    await setSilverSpringsFiscalYearEnd(6, 30);

    await login(page);
    await page.goto("/app/admin/club-settings");
    await page
      .locator('[data-testid="club-settings-form"]')
      .waitFor({ timeout: 15_000 });

    // Change FY end to Dec 31 BUT also enter an invalid value in a
    // separate field (year founded > current year) to trigger a
    // validation failure on a DIFFERENT field.
    await page.selectOption('select[name="fiscalYearEndMonth"]', "12");
    await page.fill('input[name="fiscalYearEndDay"]', "31");
    await page.fill('input[name="yearFounded"]', "9999"); // future year → invalid

    await page.locator('[data-testid="club-settings-save"]').click();

    // The red error banner appears + lists yearFounded as the
    // problem. No green success banner.
    await expect(
      page.locator('[data-testid="club-settings-save-error"]'),
    ).toBeVisible({ timeout: 10_000 });
    expect(
      await page.locator('[data-testid="club-settings-save-ok"]').count(),
    ).toBe(0);
    await expect(
      page.locator('[data-testid="club-settings-save-error"]'),
    ).toContainText("yearFounded");

    // CRITICAL: the DB is UNCHANGED — fiscalYearEnd was NOT silently
    // persisted just because the dropdown showed December.
    const stillBaseline = await getSilverSpringsProfile();
    expect(
      stillBaseline.fiscalYearEndMonth,
      "DB row unchanged on failed save",
    ).toBe(6);
    expect(stillBaseline.fiscalYearEndDay).toBe(30);
  });
});
