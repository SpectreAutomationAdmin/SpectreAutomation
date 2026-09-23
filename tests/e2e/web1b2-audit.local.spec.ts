// WEB-1B.2 — deterministic multi-viewport parity audit.
//
// Framer's runtime never reaches networkidle. Use domcontentloaded +
// fonts.ready + explicit hero-visible check + scroll walk + settle.
// Extract SECTION BOUNDARIES by locating known Framer verbatim text
// nodes and reading their bounding rect (Framer uses <div> not <h2>).

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";

const FRAMER = "https://passionate-mindset-017743.framer.app/";
const STAGING = "https://staging.spectreautomation.com/";

// Verbatim text nodes present in both Framer and Spectre — used to
// probe section boundaries without depending on tag semantics.
const SECTION_PROBES: Array<[string, string]> = [
  ["Hero",             "The Operating System for Private Clubs."],
  ["Philosophy",       "Software should disappear."],
  ["MissionControl",   "Know what matters before you go looking for it."],
  ["Intelligence",     "notices what you might not"],
  ["ConnectedSystem",  "Information should live once."],
  ["ClubOperations",   "One operating system. Every part of the club."],
  ["Confidence",       "Confidence is more valuable than speed."],
  ["ClubIdentity",     "Your club. Not ours."],
  ["Result",           "how club management software should have always worked"],
  ["Footer",           "Built for the people who run exceptional clubs"],
];

const VIEWPORTS: Array<{ w: number; h: number; tag: string; deviceScaleFactor?: number; mobile?: boolean }> = [
  { w: 1440, h: 900, tag: "1440x900" },
  { w: 1024, h: 900, tag: "1024x900" },
  { w:  900, h: 900, tag: "0900x900" },
  { w:  768, h: 900, tag: "0768x900" },
  { w:  390, h: 844, tag: "0390x844", deviceScaleFactor: 3, mobile: true },
  { w:  375, h: 812, tag: "0375x812", deviceScaleFactor: 3, mobile: true },
];

async function deterministicSettle(page: any, w: number, h: number) {
  await page.goto(page.url() || "about:blank", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  // Wait for fonts.
  await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
  // Wait for the H1 text to be present.
  await page
    .waitForFunction(() => /Operating System for Private Clubs/.test(document.body.innerText), { timeout: 30_000 })
    .catch(() => {});
  // Scroll walk to trigger any lazy/reveal rendering.
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = Math.floor(h * 0.75);
  for (let y = 0; y < scrollHeight; y += step) {
    await page.evaluate((yy: number) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
}

async function probe(page: any) {
  return await page.evaluate((probes: string[][]) => {
    const findY = (needle: string): number | null => {
      const wanted = needle.replace(/\s+/g, " ").toLowerCase();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const t = (node.textContent || "").replace(/\s+/g, " ").toLowerCase();
        if (t.includes(wanted)) {
          const parent = node.parentElement as HTMLElement | null;
          if (parent) {
            const r = parent.getBoundingClientRect();
            return Math.round(r.top + window.scrollY);
          }
        }
      }
      return null;
    };
    const out: Record<string, number | null> = {};
    for (const [label, needle] of probes) out[label] = findY(needle);
    return {
      scrollHeight: document.documentElement.scrollHeight,
      boundaries: out,
    };
  }, SECTION_PROBES);
}

async function captureSite(browser: any, url: string, tagBase: string, capture: typeof VIEWPORTS) {
  const results: Record<string, any> = {};
  for (const v of capture) {
    const ctx = await browser.newContext({
      viewport: { width: v.w, height: v.h },
      deviceScaleFactor: v.deviceScaleFactor ?? 1,
      isMobile: !!v.mobile,
      userAgent: v.mobile
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
        : undefined,
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await deterministicSettle(page, v.w, v.h);
    // Reveal any local .w1b-reveal wrappers (staging only — harmless on Framer).
    await page.evaluate(() =>
      document.querySelectorAll(".w1b-reveal").forEach((el) => el.classList.add("is-visible")),
    );
    await page.waitForTimeout(300);
    const data = await probe(page);
    await page.screenshot({ path: `test-results/${tagBase}-${v.tag}-full.png`, fullPage: true });
    results[v.tag] = { ...data, viewport: { w: v.w, h: v.h } };
    await ctx.close();
  }
  fs.writeFileSync(`test-results/${tagBase}-report.json`, JSON.stringify(results, null, 2));
  return results;
}

test.describe("WEB-1B.2 · multi-viewport parity", () => {
  test.setTimeout(600_000);

  test("Framer reference", async ({ browser }) => {
    const r = await captureSite(browser, FRAMER, "w1b2-reference", VIEWPORTS);
    expect(r["1440x900"].scrollHeight).toBeGreaterThan(1000);
  });

  test("Staging baseline", async ({ browser }) => {
    const r = await captureSite(browser, STAGING, "w1b2-staging", VIEWPORTS);
    expect(r["1440x900"].scrollHeight).toBeGreaterThan(1000);
  });
});
