// One-shot reproduction spec for the founder's Tenant Users crash on
// Marc invitation. Not a permanent regression — its job is to capture
// the browser console + pageerror + network status so we can root-cause.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/tenant-users-repro");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("REPRO: tenant users invitation crash", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const page = await loginAsFounder(ctx);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: Array<{ url: string; status: number; body: string }> = [];
  page.on("pageerror", (e) => pageErrors.push(`${e.name}: ${e.message}\n${e.stack ?? ""}`));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("response", async (res) => {
    if (res.status() >= 400) {
      try {
        const body = await res.text();
        failedRequests.push({ url: res.url(), status: res.status(), body: body.slice(0, 800) });
      } catch { /* ignore */ }
    }
  });

  await page.goto(`${STAGING}/app/admin/settings/users`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, "00-tenant-users-list.png"), fullPage: false });

  // Find the Invite / Add user button/link.
  const inviteTrigger = page
    .locator('a, button', {
      hasText: /(\+ ?Invite user|Invite user|Add user|Invite Tenant User|\+ ?Add|New user)/i,
    })
    .first();
  const triggerCount = await inviteTrigger.count();
  console.log(`[repro] invite trigger count=${triggerCount}`);
  if (triggerCount) {
    await inviteTrigger.scrollIntoViewIfNeeded();
    await inviteTrigger.click();
    await page.waitForTimeout(2500);
  }
  await page.screenshot({ path: path.join(OUT, "01-invite-dialog-or-page.png"), fullPage: false });

  // Try to find a "select existing employee" affordance.
  const empSelect = page.locator('select, input[role="combobox"], [data-testid*="employee"]').first();
  const empSelectCount = await empSelect.count();
  console.log(`[repro] employee select count=${empSelectCount}`);

  // Fill the invitation form.
  await page.locator('input[name="email"], input[type="email"]').first().fill("marc.tenantuser@synthetic.spectre.test");
  await page.locator('input[name="firstName"], input[placeholder*="First" i]').first().fill("Marc");
  await page.locator('input[name="lastName"], input[placeholder*="Last" i]').first().fill("Maldiney");

  // Employment relationship = Employee of this Club (default).
  // Link an existing Employee record dropdown — select Marc.
  const linkSel = page.locator('select').filter({
    hasNot: page.locator('option', { hasText: /Administration|None/i }),
  }).first();
  // Try any select whose options contain "Marc".
  const allSelects = await page.locator("select").all();
  let marcSel: import("@playwright/test").Locator | null = null;
  for (const sel of allSelects) {
    const opts = await sel.locator("option").allTextContents();
    if (opts.some((o) => /Marc.*Maldiney|Maldiney/i.test(o))) {
      marcSel = sel;
      break;
    }
  }
  console.log(`[repro] found Marc select: ${marcSel != null}`);
  if (marcSel) {
    const values = await marcSel.locator("option").evaluateAll((els) =>
      (els as HTMLOptionElement[]).map((o) => ({ value: o.value, text: o.textContent ?? "" })),
    );
    const marcOpt = values.find((v) => /Marc.*Maldiney|Maldiney/i.test(v.text));
    if (marcOpt) {
      await marcSel.selectOption(marcOpt.value);
      await page.waitForTimeout(500);
    }
  }
  await page.screenshot({ path: path.join(OUT, "02-marc-linked.png"), fullPage: false });

  // Check the "Payroll Administrator" access role.
  const payrollRoleCb = page
    .locator('label, div', { hasText: /Payroll Administrator/i })
    .locator('input[type="checkbox"]')
    .first();
  if (await payrollRoleCb.count()) {
    await payrollRoleCb.check();
    await page.waitForTimeout(300);
  }

  await page.screenshot({ path: path.join(OUT, "03-role-checked.png"), fullPage: false });

  // Submit — find "Send invitation" / "Save" / "Invite".
  const submitBtn = page.locator('button', {
    hasText: /(Send invitation|Invite|Save|Create|Submit)/i,
  }).last();
  if (await submitBtn.count()) {
    await submitBtn.scrollIntoViewIfNeeded();
    await submitBtn.click();
    await page.waitForTimeout(5000);
  }
  await page.screenshot({ path: path.join(OUT, "04-after-submit.png"), fullPage: false });

  // Write the diagnostics.
  fs.writeFileSync(path.join(OUT, "pageerrors.json"), JSON.stringify(pageErrors, null, 2));
  fs.writeFileSync(path.join(OUT, "consoleerrors.json"), JSON.stringify(consoleErrors, null, 2));
  fs.writeFileSync(path.join(OUT, "failed-requests.json"), JSON.stringify(failedRequests, null, 2));

  console.log("\n=== PAGE ERRORS ===\n" + pageErrors.join("\n\n"));
  console.log("\n=== CONSOLE ERRORS ===\n" + consoleErrors.join("\n"));
  console.log("\n=== FAILED REQUESTS ===\n" + failedRequests.map(r => `${r.status} ${r.url}\n${r.body}`).join("\n---\n"));

  expect(true).toBe(true);
  await ctx.close();
});
