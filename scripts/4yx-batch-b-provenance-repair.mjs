// EP-TRAIN-4Y-X Batch B (2026-11-09) — provenance-repair orchestrator.
//
// Workflow:
//   1. Authenticate as founder.
//   2. GET /api/admin/training/courses/[courseId]/metadata — read
//      the CURRENT title, description, code, attribution record.
//   3. Verify the title + code still match the 4Y-U-known
//      deterministic values. If anything has drifted (manager edit,
//      another slice wrote attribution), STOP without repairing.
//   4. If verified AND attribution is unset: POST
//      /api/admin/training/courses/[courseId]/metadata/repair-
//      provenance with expectedAuthoredBy="deterministic" +
//      titleAtRepair=<observed title> + evidence.
//   5. Re-read and confirm attribution.At is set, source="deterministic",
//      title/description/code are unchanged.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE =
  process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";

// 4Y-U known deterministic-generated values (from
// project_ep_train_4y_u_accepted memory). If these drift, the repair
// is unsafe and MUST stop.
const EXPECTED_TITLE =
  "Getting Right Into It, The Most Frequently Asked Question We Have Is How Do We";
const EXPECTED_CODE_PREFIX =
  "GETTING_RIGHT_INTO_IT_THE_MOST_FREQUENTLY_ASKED_";

function envGet(k) {
  if (process.env[k]) return process.env[k];
  for (const f of [".env.playwright.local", ".env.staging.local", ".env.local"]) {
    const p = path.join(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

const EMAIL = envGet("SPECTRE_STAGING_EMAIL");
const PASSWORD = envGet("SPECTRE_STAGING_PASSWORD");
if (!EMAIL || !PASSWORD) {
  console.error("Missing SPECTRE_STAGING_EMAIL / SPECTRE_STAGING_PASSWORD");
  process.exit(2);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const page = await ctx.newPage();

  console.log(`→ login as ${EMAIL}`);
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
  console.log("  logged in");

  console.log(`\n→ GET /api/admin/training/courses/${COURSE_ID}/metadata (BEFORE)`);
  const r1 = await page.request.get(
    `${BASE}/api/admin/training/courses/${COURSE_ID}/metadata`,
  );
  if (!r1.ok()) {
    console.error(`  FAIL: HTTP ${r1.status()} ${await r1.text()}`);
    await browser.close();
    process.exit(1);
  }
  const before = await r1.json();
  console.log("  course BEFORE:");
  console.log(`    title:       ${JSON.stringify(before.course.title)}`);
  console.log(`    description: ${JSON.stringify((before.course.description ?? "").slice(0, 120))}`);
  console.log(`    code:        ${JSON.stringify(before.course.code)}`);
  console.log(`    attribution: ${JSON.stringify(before.course.attribution, null, 2)}`);

  // ─── Verification: title + code must still match 4Y-U values.
  let verifiedOk = true;
  const reasons = [];
  if (before.course.title !== EXPECTED_TITLE) {
    reasons.push(`title drift — expected ${JSON.stringify(EXPECTED_TITLE)}, got ${JSON.stringify(before.course.title)}`);
    verifiedOk = false;
  }
  if (!before.course.code.startsWith(EXPECTED_CODE_PREFIX)) {
    reasons.push(`code drift — expected prefix ${JSON.stringify(EXPECTED_CODE_PREFIX)}, got ${JSON.stringify(before.course.code)}`);
    verifiedOk = false;
  }
  if (before.course.attribution.at !== null) {
    reasons.push(`attribution already set — At=${before.course.attribution.at}`);
    verifiedOk = false;
  }
  if (!verifiedOk) {
    console.error("\n× VERIFICATION FAILED — not repairing. Reasons:");
    for (const r of reasons) console.error(`  - ${r}`);
    await browser.close();
    process.exit(1);
  }
  console.log("\n✓ Verification OK — title + code match 4Y-U values, attribution unset.");

  // ─── Repair.
  console.log(`\n→ POST .../metadata/repair-provenance`);
  const r2 = await page.request.post(
    `${BASE}/api/admin/training/courses/${COURSE_ID}/metadata/repair-provenance`,
    {
      headers: { "Content-Type": "application/json" },
      data: {
        expectedAuthoredBy: "deterministic",
        titleAtRepair: before.course.title,
        evidence: "4Y-U acceptance 2026-11-09, commit 1d69b536; 4Y-X Batch B 2026-11-09",
      },
    },
  );
  const repairBody = await r2.json();
  console.log(`  status=${r2.status()} body=${JSON.stringify(repairBody)}`);
  if (!r2.ok() || !repairBody.ok) {
    console.error("× Repair failed");
    await browser.close();
    process.exit(1);
  }
  console.log(`  outcome: ${repairBody.outcome}`);

  // ─── Re-read.
  console.log(`\n→ GET .../metadata (AFTER)`);
  const r3 = await page.request.get(
    `${BASE}/api/admin/training/courses/${COURSE_ID}/metadata`,
  );
  const after = await r3.json();
  console.log(`  title:       ${JSON.stringify(after.course.title)}`);
  console.log(`  description: ${JSON.stringify((after.course.description ?? "").slice(0, 120))}`);
  console.log(`  code:        ${JSON.stringify(after.course.code)}`);
  console.log(`  attribution: ${JSON.stringify(after.course.attribution, null, 2)}`);

  // Confirm nothing was overwritten.
  const problems = [];
  if (after.course.title !== before.course.title) {
    problems.push(`TITLE OVERWRITTEN — was ${JSON.stringify(before.course.title)} now ${JSON.stringify(after.course.title)}`);
  }
  if (after.course.description !== before.course.description) {
    problems.push(`DESCRIPTION OVERWRITTEN`);
  }
  if (after.course.code !== before.course.code) {
    problems.push(`CODE OVERWRITTEN — was ${JSON.stringify(before.course.code)} now ${JSON.stringify(after.course.code)}`);
  }
  if (after.course.attribution.at === null) {
    problems.push(`attribution.At still null — repair did not write`);
  }
  if (after.course.attribution.source !== "deterministic") {
    problems.push(`attribution.source expected "deterministic", got ${JSON.stringify(after.course.attribution.source)}`);
  }
  if (after.course.attribution.attributedTitle !== before.course.title) {
    problems.push(`attribution.attributedTitle mismatch`);
  }

  if (problems.length > 0) {
    console.error("\n× POST-REPAIR CHECK FAILED:");
    for (const p of problems) console.error(`  - ${p}`);
    await browser.close();
    process.exit(1);
  }

  console.log("\n✓ Batch B PASS — attribution set, title/description/code unchanged.");
  await browser.close();
}

main().catch((err) => {
  console.error("FATAL:", err?.stack ?? err);
  process.exit(1);
});
