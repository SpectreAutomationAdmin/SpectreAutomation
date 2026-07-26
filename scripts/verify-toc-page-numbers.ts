// Verify the TOC page-number measurement pass without going through
// the full PDF API. Runs the exact same page.evaluate() the API uses
// against the live print route and prints the resolved page number
// for every chapter.
//
// Confirms: (a) every TOC anchor gets a page number, (b) numbers are
// monotonically non-decreasing (chapters appear in document order),
// (c) the first chapter (Executive Opening) lands at page 3 (after
// title page + TOC), (d) the spread of page numbers reflects a
// sensible landscape pagination (typically 30-50 pages, not 100+).

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

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    await ctx.addCookies([
      {
        name: cookieName,
        value: sealed,
        domain: "localhost",
        path: "/",
      },
    ]);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 990 });
    const url = `${BASE}/app/print/monthly-package?id=${livePkg.id}`;
    console.log("Loading", url);
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(250);

    const PER_PAGE_CONTENT_HEIGHT_CSS_PX = 844;
    const TITLE_PLUS_TOC_OFFSET = 2;
    const chapterIds: string[] = await page.evaluate(() => {
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
      ({ perPage, offset, ids }) => {
        const root = document.querySelector<HTMLElement>(
          "[data-testid='print-monthly-package']",
        );
        if (!root) return {} as Record<string, number>;
        const result: Record<string, number> = {};
        let bodyPage = 1;
        for (const id of ids) {
          const el = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
          if (!el) continue;
          result[id] = bodyPage + offset;
          const h = el.offsetHeight || 1;
          const pagesUsed = Math.max(1, Math.ceil(h / perPage));
          bodyPage += pagesUsed;
        }
        return result;
      },
      { perPage: PER_PAGE_CONTENT_HEIGHT_CSS_PX, offset: TITLE_PLUS_TOC_OFFSET, ids: chapterIds },
    );

    const tocAnchors: Array<{ id: string; label: string }> = await page.evaluate(() => {
      const out: Array<{ id: string; label: string }> = [];
      document
        .querySelectorAll<HTMLElement>("[data-toc-anchor]")
        .forEach((a) => {
          const id = a.getAttribute("data-toc-anchor") ?? "";
          const label = (a.querySelector(".label")?.textContent ?? "").trim();
          out.push({ id, label });
        });
      return out;
    });

    console.log("\nResolved TOC page numbers:\n");
    let allHaveNumbers = true;
    let monotonic = true;
    let last = -Infinity;
    for (const { id, label } of tocAnchors) {
      const page = tocPages[id];
      if (page == null) allHaveNumbers = false;
      if (page != null && page < last) monotonic = false;
      if (page != null) last = page;
      const padded = label.padEnd(34, " ");
      console.log(`  ${padded}${String(page ?? "—").padStart(4, " ")}`);
    }

    console.log("");
    console.log(`  All 14 chapters have numbers : ${allHaveNumbers && tocAnchors.length === 14}`);
    console.log(`  Monotonic non-decreasing     : ${monotonic}`);
    console.log(
      `  First chapter at page 3      : ${tocAnchors[0] && tocPages[tocAnchors[0].id] === 3}`,
    );
    const lastPage = tocPages[tocAnchors[tocAnchors.length - 1]?.id ?? ""];
    console.log(`  Last chapter page            : ${lastPage}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
