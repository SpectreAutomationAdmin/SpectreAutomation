// Reproduce the Tenant Users Save crash to capture the root cause.
import { test, expect } from "@playwright/test";
import { loginAsFounder } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

test("reproduce tenant users save crash", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: { url: string; status: number; body: string }[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}\n${e.stack ?? ""}`));
  page.on("response", async (r) => {
    if (r.request().resourceType() === "fetch" || r.request().resourceType() === "xhr") {
      if (r.status() >= 400) {
        const body = await r.text().catch(() => "<no body>");
        failedRequests.push({ url: r.url(), status: r.status(), body: body.slice(0, 800) });
      }
    }
  });

  await page.goto("https://staging.spectreautomation.com/app/admin/settings/users", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // Click Edit on Chris's row.
  const editBtn = page.getByRole("button", { name: /^edit$/i }).first();
  await editBtn.click();
  await page.waitForTimeout(1000);

  const saveBtn = page.getByRole("button", { name: /^save$/i }).first();
  await saveBtn.click();
  await page.waitForTimeout(4000);

  await page.screenshot({ path: "test-results/reproduce-tenant-save-crash.png", fullPage: false });

  console.log("PAGE ERRORS:");
  for (const e of pageErrors) console.log(e);
  console.log("\nCONSOLE ERRORS:");
  for (const e of consoleErrors) console.log(e);
  console.log("\nFAILED REQUESTS:");
  for (const f of failedRequests) console.log(`${f.status} ${f.url}\n${f.body}\n`);

  await ctx.close();
});
