import { test } from "@playwright/test";
import { writeFileSync, mkdirSync } from "fs";

// Surveys Saguaro pages p01-p16 to find where the
// "Equity Value Over Time" and "Operating Results" panels actually
// live. Writes which page contains which panel into a JSON
// inventory. Captures full-page screenshots so we can see content
// below the first viewport.

const PAGES = ["p01","p02","p03","p04","p05","p06","p07","p08","p09","p10","p11","p12","p13","p14","p15","p16"];
const VIEWPORT = { width: 1440, height: 900 };

const NEEDLES = [
  "Equity Value Over Time",
  "Operating Results",
  "12-Month",
  "12 Month",
  "Rolling Trend",
  "NOI",
  "Net Operating Income",
  "Operating Surplus",
  "Equity",
  "Break-even",
];

test("survey — locate Saguaro panels for Equity / Operating", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  mkdirSync("test-results/saguaro-survey", { recursive: true });
  const inventory: any[] = [];

  for (const slug of PAGES) {
    try {
      await page.goto(`https://sample-club.netlify.app/#${slug}`, { waitUntil: "networkidle", timeout: 15_000 });
      await page.waitForTimeout(800);
      // Full-page screenshot so content below the viewport is visible.
      await page.screenshot({ path: `test-results/saguaro-survey/${slug}-full.png`, fullPage: true });

      // Inventory: for each needle, does it appear on this page?
      const hits = await page.evaluate((needles) => {
        const found: { needle: string; sample: string; matchedClass: string; elementTag: string }[] = [];
        for (const needle of needles) {
          const all = document.querySelectorAll("*");
          for (const el of Array.from(all)) {
            const tc = el.textContent?.trim() ?? "";
            if (tc.length > 200) continue;
            if (tc.includes(needle)) {
              found.push({
                needle,
                sample: tc.slice(0, 100),
                matchedClass: (el as HTMLElement).className?.toString?.().slice(0, 80) ?? "",
                elementTag: el.tagName.toLowerCase(),
              });
              break; // only first match per needle on this page
            }
          }
        }
        return found;
      }, NEEDLES);

      // Also capture all H1/H2/H3 titles so I know what the page is.
      const titles = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("h1, h2, h3")).slice(0, 12).map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || "").trim().slice(0, 100),
        }));
      });

      inventory.push({ slug, titles, hits });
    } catch (err) {
      inventory.push({ slug, error: String(err).slice(0, 200) });
    }
  }

  writeFileSync("test-results/saguaro-survey/inventory.json", JSON.stringify(inventory, null, 2), "utf8");
});
