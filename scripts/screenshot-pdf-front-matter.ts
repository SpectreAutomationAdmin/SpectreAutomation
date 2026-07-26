// Visual verification of the PDF front matter (title page + TOC).
// Loads the print route in headless Chromium, runs the same
// measurement + injection the API does, then screenshots the two
// front-matter sections at landscape Letter dimensions.

import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { sealData } from "iron-session";

const BASE = "http://localhost:3000";

async function main() {
  const prisma = new PrismaClient();
  const adminRole = await prisma.userClubRole.findFirst({
    where: { roleKey: "CLUB_ADMIN" },
    include: { user: true },
  });
  const livePkg = await prisma.monthlyPackage.findFirst({
    where: { status: { in: ["PUBLISHED", "SENT"] } },
    orderBy: [{ reportingYear: "desc" }, { reportingMonth: "desc" }],
  });
  await prisma.$disconnect();
  if (!adminRole?.user || !livePkg) throw new Error("Missing fixture");

  const secret = process.env.SPECTRE_SESSION_SECRET!;
  const cookieName = process.env.SESSION_COOKIE_NAME ?? "spectre_session";
  const sealed = await sealData(
    { userId: adminRole.user.id, activeClubId: adminRole.clubId, generation: 1 },
    { password: secret, ttl: 60 * 60 * 24 * 7 },
  );

  const outDir = "test-results/pdf-front-matter";
  fs.mkdirSync(outDir, { recursive: true });

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 990 },
    });
    await ctx.addCookies([
      { name: cookieName, value: sealed, domain: "localhost", path: "/" },
    ]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/app/print/monthly-package?id=${livePkg.id}`, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(250);

    // Replay the measurement + injection pass.
    const PER_PAGE = 844;
    const OFFSET = 2;
    const ids: string[] = await page.evaluate(() => {
      const out: string[] = [];
      document
        .querySelectorAll<HTMLElement>("[data-toc-anchor]")
        .forEach((a) => {
          const id = a.getAttribute("data-toc-anchor");
          if (id) out.push(id);
        });
      return out;
    });
    const tocPages: Record<string, number> = await page.evaluate(
      ({ perPage, offset, idList }) => {
        const root = document.querySelector<HTMLElement>(
          "[data-testid='print-monthly-package']",
        );
        if (!root) return {} as Record<string, number>;
        const r: Record<string, number> = {};
        let bp = 1;
        for (const id of idList) {
          const el = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
          if (!el) continue;
          r[id] = bp + offset;
          bp += Math.max(1, Math.ceil((el.offsetHeight || 1) / perPage));
        }
        return r;
      },
      { perPage: PER_PAGE, offset: OFFSET, idList: ids },
    );
    await page.evaluate((mapping) => {
      document.querySelectorAll<HTMLElement>("[data-page-ref]").forEach((slot) => {
        const id = slot.getAttribute("data-page-ref");
        if (id && mapping[id] != null) slot.textContent = String(mapping[id]);
      });
    }, tocPages);

    const titleHandle = await page.$("[data-testid='pdf-title-page']");
    const tocHandle = await page.$("[data-testid='pdf-toc-page']");
    if (!titleHandle || !tocHandle) throw new Error("Missing front matter sections");
    await titleHandle.screenshot({ path: path.join(outDir, "title-page.png") });
    await tocHandle.screenshot({ path: path.join(outDir, "toc-page.png") });
    console.log("Saved", path.join(outDir, "title-page.png"));
    console.log("Saved", path.join(outDir, "toc-page.png"));

    // Confirm by extracting the rendered TOC text.
    const tocText: string = await page.evaluate(() => {
      const root = document.querySelector("[data-testid='pdf-toc-page']");
      return root ? (root.textContent ?? "").replace(/\s+/g, " ").trim() : "";
    });
    console.log("\nTOC rendered text:");
    console.log(tocText.slice(0, 700));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
