// /app/admin/imports — Delete-draft-batch e2e.
//
// Validates the founder's acceptance criteria:
//
//   1. A DRAFT batch's row shows a Delete button.
//   2. A non-DRAFT batch's row does NOT show a Delete button.
//   3. Cancelling the confirm() dialog leaves the batch in place.
//   4. Confirming the dialog deletes the batch, removes the row
//      from the table, and surfaces the success notice banner.
//
// Tenant safety is exercised in the vitest unit suite — the e2e
// here covers the in-browser UX path only.
//
// Requires the dev server on http://localhost:3000 + Silver
// Springs seed data.

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

async function createDraftBatch(opts: {
  domain: string;
  fileName: string;
  status?: string;
  rowCount?: number;
}): Promise<string> {
  const clubId = await silverSpringsClubId();
  const batch = await prisma.importBatch.create({
    data: {
      clubId,
      domain: opts.domain,
      source: "CSV",
      fileName: opts.fileName,
      mappingJson: JSON.stringify({}),
      totalRows: opts.rowCount ?? 1,
      status: opts.status ?? "DRAFT",
    },
  });
  for (let i = 0; i < (opts.rowCount ?? 1); i++) {
    await prisma.importRow.create({
      data: {
        clubId,
        batchId: batch.id,
        rowNumber: i + 1,
        rawJson: JSON.stringify({ number: `${9000 + i}`, name: `Seed row ${i + 1}` }),
      },
    });
  }
  return batch.id;
}

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test.describe("/app/admin/imports — delete draft batch", () => {
  test.afterAll(async () => {
    await prisma.$disconnect();
  });

  test("DRAFT batch shows Delete; non-DRAFT batch does not", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const draftId = await createDraftBatch({
      domain: "COA",
      fileName: "e2e-draft.csv",
      status: "DRAFT",
    });
    const validatedId = await createDraftBatch({
      domain: "COA",
      fileName: "e2e-validated.csv",
      status: "VALIDATED",
    });
    await login(page);
    await page.goto("/app/admin/imports");

    await expect(
      page.locator(`[data-testid="delete-draft-batch-${draftId}"]`),
    ).toBeVisible();
    expect(
      await page
        .locator(`[data-testid="delete-draft-batch-${validatedId}"]`)
        .count(),
    ).toBe(0);

    // Cleanup so the next test starts clean.
    await prisma.importBatch.deleteMany({
      where: { id: { in: [draftId, validatedId] } },
    });
  });

  test("cancelling the confirm() dialog leaves the batch in place", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const draftId = await createDraftBatch({
      domain: "COA",
      fileName: "e2e-cancel.csv",
      status: "DRAFT",
    });

    page.once("dialog", (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message().toLowerCase()).toContain("delete this draft");
      expect(dialog.message().toLowerCase()).toContain("cannot be undone");
      void dialog.dismiss(); // cancel
    });

    await login(page);
    await page.goto("/app/admin/imports");
    await page.locator(`[data-testid="delete-draft-batch-${draftId}"]`).click();

    // Give the page a beat to react (no network round-trip if
    // dismissed — but the click handler short-circuits).
    await page.waitForTimeout(300);

    // Batch still in the table.
    await expect(
      page.locator(`[data-testid="delete-draft-batch-${draftId}"]`),
    ).toBeVisible();

    // Batch still in DB.
    const stillThere = await prisma.importBatch.findUnique({
      where: { id: draftId },
    });
    expect(stillThere).not.toBeNull();

    await prisma.importBatch.delete({ where: { id: draftId } });
  });

  test("confirming deletes the batch + cascades child rows + shows success notice", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const draftId = await createDraftBatch({
      domain: "COA",
      fileName: "e2e-confirm.csv",
      status: "DRAFT",
      rowCount: 3,
    });

    // Pre-check: rows exist in the DB.
    expect(
      await prisma.importRow.count({ where: { batchId: draftId } }),
    ).toBe(3);

    page.on("dialog", (dialog) => {
      void dialog.accept();
    });

    await login(page);
    await page.goto("/app/admin/imports");
    await page.locator(`[data-testid="delete-draft-batch-${draftId}"]`).click();

    // Success notice banner appears + batch row gone.
    await expect(page.locator('[data-testid="new-batch-notice"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('[data-testid="new-batch-notice"]')).toContainText(
      /deleted/i,
    );
    expect(
      await page
        .locator(`[data-testid="delete-draft-batch-${draftId}"]`)
        .count(),
    ).toBe(0);

    // Batch + child rows gone in the DB.
    expect(
      await prisma.importBatch.findUnique({ where: { id: draftId } }),
    ).toBeNull();
    expect(
      await prisma.importRow.count({ where: { batchId: draftId } }),
    ).toBe(0);
  });
});
