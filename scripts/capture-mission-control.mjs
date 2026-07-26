// Capture the Mission Control concept at 1440x900 and 1920x1080,
// plus the inbox-zero variant.

import { chromium } from "playwright";
import fs from "node:fs/promises";

const BASE = "http://localhost:3000/design-concepts/mission-control";
const OUT = "test-results/mission-control";

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const b = await chromium.launch({ headless: true });
  const shots = [
    { name: "main-1440",   file: "index.html",       w: 1440, h: 900,  full: true },
    { name: "main-1920",   file: "index.html",       w: 1920, h: 1080, full: true },
    { name: "main-1440-abovefold",   file: "index.html",       w: 1440, h: 900, full: false },
    { name: "inbox-zero-1440", file: "inbox-zero.html", w: 1440, h: 900, full: false },
    { name: "inbox-zero-1920", file: "inbox-zero.html", w: 1920, h: 1080, full: false },
  ];
  for (const s of shots) {
    const c = await b.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 2 });
    const p = await c.newPage();
    await p.goto(`${BASE}/${s.file}`);
    await p.evaluate(async () => { if ("fonts" in document) await document.fonts.ready; });
    await p.waitForTimeout(400);
    const path = `${OUT}/${s.name}.png`;
    await p.screenshot({ path, fullPage: s.full });
    console.log(`  ${path}`);
    await c.close();
  }
  await b.close();
}
main().catch(e => { console.error(e); process.exit(1); });
