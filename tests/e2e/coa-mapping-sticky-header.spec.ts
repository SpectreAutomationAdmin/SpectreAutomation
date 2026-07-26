// CoaMappingTable — sticky header + relocated Save Mapping button.
//
// Validates the founder's spec for the mapping screen UX changes:
//
//   1. The "Save mapping" button lives inside the bulk-actions area
//      (top-right of the bulk bar), not in a far-away footer.
//   2. When the operator scrolls past the mapping card, the title +
//      counter + helper text + bulk bar + table column headers all
//      stay pinned to the viewport top.
//   3. The table BODY scrolls cleanly underneath the sticky stack
//      (only the rows move; the chrome stays put).
//   4. The pinned stack does not overlap the left sidebar or the
//      top app chrome.
//   5. Sticky dropdowns remain operable — opening the bulk "Apply
//      Type" select still works after a long scroll.
//
// Validated at three viewports the founder named:
//   1366 × 768  — small admin laptop
//   1440 × 900  — common admin laptop
//   1920 × 1080 — desktop
//
// Requires the dev server on http://localhost:3000 and Silver Springs
// seed data. The fixture builds a draft 240-row COA batch directly via
// Prisma so the scroll surface always exists, then opens the batch
// detail page in the browser.

import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

const prisma = new PrismaClient();

async function silverSpringsClubId(): Promise<string> {
  const club = await prisma.club.findFirst({
    where: { slug: "silver-springs" },
    select: { id: true },
  });
  if (!club) throw new Error("Silver Springs not seeded");
  return club.id;
}

async function createCoaDraftBatch(rowCount = 240): Promise<string> {
  const clubId = await silverSpringsClubId();
  const batch = await prisma.importBatch.create({
    data: {
      clubId,
      domain: "COA",
      source: "CSV",
      fileName: "e2e-sticky.csv",
      mappingJson: JSON.stringify({}),
      totalRows: rowCount,
      status: "DRAFT",
    },
  });
  // Use distinct numbers so the rendered rows don't collapse.
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    clubId,
    batchId: batch.id,
    rowNumber: i + 1,
    rawJson: JSON.stringify({
      number: String(1000 + i),
      name: `E2E Account ${1000 + i}`,
    }),
  }));
  for (const r of rows) await prisma.importRow.create({ data: r });
  return batch.id;
}

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

const VIEWPORTS = [
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
];

test.describe("COA mapping — sticky header + Save Mapping relocation", () => {
  let batchId: string;

  test.beforeAll(async () => {
    batchId = await createCoaDraftBatch(240);
  });

  test.afterAll(async () => {
    await prisma.importBatch
      .delete({ where: { id: batchId } })
      .catch(() => undefined);
    await prisma.$disconnect();
  });

  test("Save Mapping is inside the bulk bar (not a far-away footer)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto(`/app/admin/imports/${batchId}`);
    await page
      .locator('[data-testid="coa-mapping-table"]')
      .waitFor({ timeout: 15_000 });

    // The Save button exists.
    const save = page.locator('[data-testid="coa-save-mapping"]');
    await expect(save).toBeVisible();

    // The Save button is inside the bulk-actions container — proves
    // the relocation from the legacy footer is in effect.
    const insideBulk = await save.evaluate((btn) => {
      const bulk = btn.closest('[data-testid="coa-bulk-bar"]');
      return bulk !== null;
    });
    expect(insideBulk).toBe(true);

    // And it sits in the SAME sticky header block, so it pins with
    // the bulk bar when the user scrolls.
    const insideSticky = await save.evaluate((btn) => {
      const sticky = btn.closest('[data-testid="coa-mapping-sticky-header"]');
      return sticky !== null;
    });
    expect(insideSticky).toBe(true);
  });

  for (const vp of VIEWPORTS) {
    test(`sticky header + thead stay pinned after scroll @ ${vp.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await login(page);
      await page.goto(`/app/admin/imports/${batchId}`);
      await page
        .locator('[data-testid="coa-mapping-table"]')
        .waitFor({ timeout: 15_000 });

      const sticky = page.locator('[data-testid="coa-mapping-sticky-header"]');
      const thead = page.locator('[data-testid="coa-mapping-thead"]');
      const progress = page.locator('[data-testid="coa-mapping-progress"]');
      const saveBtn = page.locator('[data-testid="coa-save-mapping"]');

      // Pre-scroll baseline: sticky header sits at its natural position
      // (below the page title + action buttons).
      const beforeTop = await sticky.evaluate(
        (el) => el.getBoundingClientRect().top,
      );
      expect(beforeTop).toBeGreaterThan(0);

      // Scroll the page far enough to push the sticky element to its
      // pinned position. Scroll 1200px down — past the mapping card's
      // natural top edge.
      await page.evaluate(() => window.scrollTo(0, 1200));
      await page.waitForTimeout(150);

      // After scroll: sticky header is pinned at top: 0 (or very near).
      const stickyBox = await sticky.boundingBox();
      expect(stickyBox, `sticky header bounding box @ ${vp.name}`).not.toBeNull();
      expect(stickyBox!.y).toBeGreaterThanOrEqual(-2); // allow tiny rounding
      expect(stickyBox!.y).toBeLessThan(40); // pinned, not scrolled away

      // The thead pins immediately below the sticky header (no gap,
      // no overlap > 4px).
      const theadBox = await thead.boundingBox();
      expect(theadBox).not.toBeNull();
      const stickyBottom = stickyBox!.y + stickyBox!.height;
      const gap = theadBox!.y - stickyBottom;
      expect(
        gap,
        `thead-vs-sticky gap @ ${vp.name} should be < 6px (got ${gap})`,
      ).toBeLessThan(6);
      expect(
        gap,
        `thead-vs-sticky gap @ ${vp.name} should be >= -2px (got ${gap})`,
      ).toBeGreaterThanOrEqual(-2);

      // Counter + Save button are visible after the long scroll —
      // they stay in the operator's field of view.
      await expect(progress).toBeVisible();
      await expect(saveBtn).toBeVisible();

      // The sticky header must not bleed off the left edge into the
      // sidebar. Get the sidebar's right edge + assert sticky.x >= it.
      // The Spectre admin sidebar uses a flex layout — sticky lives
      // inside main, which sits to the sidebar's right.
      const sidebarRight = await page.evaluate(() => {
        const aside = document.querySelector('aside, nav[aria-label*="sidebar" i], [data-testid="sidebar"]');
        if (!aside) return null;
        return Math.ceil(aside.getBoundingClientRect().right);
      });
      if (sidebarRight !== null) {
        expect(
          stickyBox!.x,
          `sticky header must start at or after sidebar right edge @ ${vp.name}`,
        ).toBeGreaterThanOrEqual(sidebarRight - 2);
      }
    });
  }

  test("rows scroll underneath; sticky chrome does not move", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto(`/app/admin/imports/${batchId}`);
    await page
      .locator('[data-testid="coa-mapping-table"]')
      .waitFor({ timeout: 15_000 });

    const sticky = page.locator('[data-testid="coa-mapping-sticky-header"]');
    const firstRow = page.locator('[data-testid^="coa-row-"]').first();
    const lateRow = page.locator('[data-testid="coa-row-1200"]');

    // Scroll just enough to engage sticky pinning.
    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.waitForTimeout(150);
    const stickyYAfter1 = (await sticky.boundingBox())!.y;
    const firstRowYAfter1 = (await firstRow.boundingBox())!.y;

    // Scroll further — rows move, sticky stays.
    await page.evaluate(() => window.scrollTo(0, 2400));
    await page.waitForTimeout(150);
    const stickyYAfter2 = (await sticky.boundingBox())!.y;
    const firstRowAfter2 = await firstRow.boundingBox();

    // Sticky y position barely changes between the two scrolls.
    expect(
      Math.abs(stickyYAfter2 - stickyYAfter1),
      "sticky header y is stable between scrolls",
    ).toBeLessThan(4);

    // The first row has scrolled up (either off-screen or further up).
    if (firstRowAfter2) {
      expect(firstRowAfter2.y).toBeLessThan(firstRowYAfter1 - 400);
    }

    // A row far down the list (#1200 — corresponds to rowNumber 201
    // in this synthetic batch since numbers start at 1000) becomes
    // visible after the second scroll.
    await expect(lateRow).toBeVisible();
  });

  test("sticky dropdowns remain operable after scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await page.goto(`/app/admin/imports/${batchId}`);
    await page
      .locator('[data-testid="coa-mapping-table"]')
      .waitFor({ timeout: 15_000 });

    await page.evaluate(() => window.scrollTo(0, 1800));
    await page.waitForTimeout(150);

    // The bulk Type select is still focusable + interactable.
    const bulkType = page.locator('[data-testid="coa-bulk-type-select"]');
    await expect(bulkType).toBeVisible();
    await bulkType.selectOption("EXPENSE");
    await expect(bulkType).toHaveValue("EXPENSE");
  });
});
