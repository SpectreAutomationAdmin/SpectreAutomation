import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const srcDir = path.join(repoRoot, "public", "design-concepts", "workflow-surface");
const outDir = path.join(repoRoot, "test-results", "workflow-surface");
fs.mkdirSync(outDir, { recursive: true });

const shots = [
  { name: "01-detail-1440x900",         file: "detail.html",     w: 1440, h: 900 },
  { name: "02-detail-1920x1080",        file: "detail.html",     w: 1920, h: 1080 },
  { name: "03-queue-1440x900",          file: "queue.html",      w: 1440, h: 900 },
  { name: "04-queue-1920x1080",         file: "queue.html",      w: 1920, h: 1080 },
  { name: "05-primitives-1440x1600",    file: "primitives.html", w: 1440, h: 1600 },
];

const browser = await chromium.launch();
try {
  for (const shot of shots) {
    const url = pathToFileURL(path.join(srcDir, shot.file)).toString();
    const ctx = await browser.newContext({ viewport: { width: shot.w, height: shot.h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on("pageerror", (err) => console.error(`[${shot.name}]`, err.message));
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const out = path.join(outDir, `${shot.name}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log(`captured ${out}`);
    await ctx.close();
  }
} finally { await browser.close(); }
