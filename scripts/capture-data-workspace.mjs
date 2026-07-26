// Capture the Data Workspace concept across every required review state.
// The concept is hash-driven so each state maps to a stable URL.

import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const src = path.join(repoRoot, "public", "design-concepts", "data-workspace", "chart-of-accounts.html");
const outDir = path.join(repoRoot, "test-results", "data-workspace");
fs.mkdirSync(outDir, { recursive: true });

const url = pathToFileURL(src).toString();
const collect_console = (page, label) => {
  page.on("pageerror", (err) => console.error(`[${label}] pageerror`, err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error(`[${label}] console.error`, msg.text());
  });
};

const shots = [
  // Two required baseline captures
  { name: "01-default-1440x900",              hash: "",                                  w: 1440, h: 900 },
  { name: "02-default-1920x1080",             hash: "",                                  w: 1920, h: 1080 },

  // The seven required states at 1440x900
  { name: "03-account-selected-1440x900",     hash: "#select=1010",                       w: 1440, h: 900 },
  { name: "04-inspector-editing-unsaved-1440x900", hash: "#edit=1010&dirty=1",           w: 1440, h: 900 },
  { name: "05-multi-hidden-1440x900",         hash: "#state=multi-hidden",                w: 1440, h: 900 },
  { name: "06-fund-applicability-1440x900",   hash: "#view=fund-applicability",           w: 1440, h: 900 },
  { name: "07-validation-error-1440x900",     hash: "#edit=1250&err=1",                   w: 1440, h: 900 },
  { name: "08-no-results-1440x900",           hash: "#q=zzzzzzz",                         w: 1440, h: 900 },

  // Extra: the pattern-reference block (illustrative AI, status vocab)
  { name: "09-pattern-reference-1440x900",    hash: "#ref=1",                             w: 1440, h: 1400 },

  // Extra: density variations (visible difference)
  { name: "10-density-comfortable-1440x900",  hash: "#density=comfortable",               w: 1440, h: 900 },
  { name: "11-density-compact-1440x900",      hash: "#density=compact",                   w: 1440, h: 900 },
];

const browser = await chromium.launch();
try {
  for (const shot of shots) {
    const ctx = await browser.newContext({ viewport: { width: shot.w, height: shot.h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    collect_console(page, shot.name);
    await page.goto(url + shot.hash);
    await page.waitForLoadState("networkidle");
    // give the hash-controller a moment to render
    await page.waitForTimeout(100);
    const out = path.join(outDir, `${shot.name}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log(`captured ${out}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
