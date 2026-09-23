// WEB-1B.1 — LIVE Framer + staging audit.
// Captures full-page shots, section shots, page height, and extracts
// visible text in document order so the parity map can be built from
// the real reference, not memory.

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";

const FRAMER = "https://passionate-mindset-017743.framer.app/";
const STAGING = "https://staging.spectreautomation.com/";

async function captureAt(browser: any, url: string, tag: string, width: number, height: number) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() =>
    document.querySelectorAll(".w1b-reveal").forEach((el) => el.classList.add("is-visible")),
  );
  await page.waitForTimeout(500);
  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  await page.screenshot({ path: `test-results/${tag}-hero.png`, fullPage: false });
  await page.screenshot({ path: `test-results/${tag}-fullpage.png`, fullPage: true });
  for (let i = 0, y = height; y < scrollHeight; i++, y += height) {
    await page.evaluate((yy: number) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/${tag}-section-${String(i + 1).padStart(2, "0")}.png`, fullPage: false });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  // Extract visible text nodes in document order + section boundary Y-coords.
  const dump = await page.evaluate(() => {
    const bodyText = document.body.innerText.replace(/\n{3,}/g, "\n\n");
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        text: (el as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
        y: Math.round(r.top + window.scrollY),
      };
    });
    return { scrollHeight: document.body.scrollHeight, bodyText, headings };
  });
  fs.writeFileSync(`test-results/${tag}-dump.txt`, `SCROLL_HEIGHT: ${dump.scrollHeight}\n\n=== HEADINGS ===\n${dump.headings.map((h: { y: number; tag: string; text: string }) => `[${h.y.toString().padStart(5)}px] ${h.tag}: ${h.text}`).join("\n")}\n\n=== BODY TEXT ===\n${dump.bodyText}\n`);
  await ctx.close();
  return dump;
}

test.describe("WEB-1B.1 audit", () => {
  test.setTimeout(300_000);

  test("Framer @ 1440", async ({ browser }) => {
    const d = await captureAt(browser, FRAMER, "audit-framer-1440", 1440, 900);
    expect(d.scrollHeight).toBeGreaterThan(1000);
  });

  test("Framer @ 390", async ({ browser }) => {
    const d = await captureAt(browser, FRAMER, "audit-framer-390", 390, 844);
    expect(d.scrollHeight).toBeGreaterThan(1000);
  });

  test("Staging @ 1440", async ({ browser }) => {
    const d = await captureAt(browser, STAGING, "audit-staging-1440", 1440, 900);
    expect(d.scrollHeight).toBeGreaterThan(1000);
  });

  test("Staging @ 390", async ({ browser }) => {
    const d = await captureAt(browser, STAGING, "audit-staging-390", 390, 844);
    expect(d.scrollHeight).toBeGreaterThan(1000);
  });
});
