// 4Y-V check current generation state
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
function envGet(k) {
  if (process.env[k]) return process.env[k];
  for (const f of [".env.playwright.local", ".env.local"]) {
    const p = path.join(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}
const b = await chromium.launch({ headless: true });
const c = await b.newContext();
const p = await c.newPage();
await p.goto("https://staging.spectreautomation.com/login", { waitUntil: "domcontentloaded" });
await p.locator('input[name="email"]').fill(envGet("SPECTRE_STAGING_EMAIL"));
await p.locator('input[name="password"]').fill(envGet("SPECTRE_STAGING_PASSWORD"));
await Promise.all([p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }), p.locator('form button[type="submit"]').first().click()]);
const r = await p.request.get("https://staging.spectreautomation.com/api/admin/training/versions/cmw8n6z9a000az4nx56vwh02f/generation-status");
console.log("STATUS:", r.status());
console.log(JSON.stringify(await r.json(), null, 2));
await b.close();
