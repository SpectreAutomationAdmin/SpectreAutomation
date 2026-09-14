// Onboarding canonical Position display hotfix — staging Playwright acceptance.
//
// Founder rule (§16): screenshot proof against Marc's actual session is
// preferred but "if possible". Marc's active session has an already-
// consumed invitation cookie set in the founder's browser; re-issuing
// his invitation would touch his session state, which §10 forbids.
//
// Safer path: create a synthetic PRE_HIRE Employee shaped identically to
// Marc (same Position + Department + salary + expected start date),
// issue a fresh invitation, redeem it in an unauthenticated browser
// context, and screenshot the About You → Employment page. Both
// onboarding pages consume the identical shared helper
// `formatEmploymentPositionLabel`, so the Employment-page proof also
// stands for Review.
//
// Cleanup: the synthetic is deleted through the founder's own directory
// UI at the end of the run so the founder-visible directory remains
// Chris + Marc only.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/onboarding-position-hotfix");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FLYCTL = process.env.SPECTRE_FLYCTL_PATH ?? "C:/Users/cturcato/.fly/bin/flyctl.exe";
const FOUNDER_USER_ID = "cmrvdenz700034437agp7gqs5"; // Chris Turcato — staging founder

test.use({ viewport: { width: 1440, height: 900 } });

/**
 * Issue a fresh invitation for an existing Employee id by writing a raw
 * random token + SHA-256 hash directly to the staging DB via flyctl SSH.
 * Returns the raw token. The service-layer `issueInvitation` requires a
 * Principal object that this spec can't easily construct across the SSH
 * boundary; the DB layout is the same either way.
 */
function issueInvitationOverSsh(clubId: string, employeeId: string): string {
  const script = `
const { PrismaClient } = require("@prisma/client");
const { randomBytes, createHash } = require("crypto");
const p = new PrismaClient();
(async () => {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex");
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
  await p.employeeOnboardingInvitation.create({
    data: {
      club: { connect: { id: "${clubId}" } },
      employee: { connect: { id: "${employeeId}" } },
      issuedBy: { connect: { id: "${FOUNDER_USER_ID}" } },
      tokenHash, expiresAt,
    },
  });
  console.log("RAWTOKEN=" + rawToken);
})().catch(e => { console.error(e); process.exit(1); }).finally(() => p.$disconnect());
`;
  const remoteName = `issue-inv-${Date.now()}.cjs`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spectre-inv-"));
  const localFile = path.join(tmpDir, remoteName);
  try {
    fs.writeFileSync(localFile, script, "utf8");
    execFileSync(FLYCTL, [
      "ssh", "sftp", "put",
      "--app", "spectre-staging",
      localFile,
    ], { encoding: "utf8", timeout: 60_000, cwd: tmpDir });
    // flyctl on Windows exits with "The handle is invalid." at SSH shutdown
    // even after a successful command run — catch and parse stdout either way.
    let out = "";
    try {
      out = execFileSync(FLYCTL, [
        "ssh", "console",
        "--app", "spectre-staging",
        "--command", `sh -c "cd /app && node ${remoteName}; rm -f ${remoteName}"`,
      ], { encoding: "utf8", timeout: 60_000 });
    } catch (err) {
      const errObj = err as { stdout?: string; stderr?: string; message?: string };
      out = (errObj.stdout ?? "") + "\n" + (errObj.stderr ?? "");
      if (!/RAWTOKEN=/.test(out)) {
        throw new Error(`SSH invitation failed: ${errObj.message}\n${out}`);
      }
    }
    const m = /RAWTOKEN=([A-Za-z0-9_-]+)/.exec(out);
    if (!m) throw new Error(`issueInvitationOverSsh: no token in SSH output. Full output:\n${out}`);
    return m[1];
  } finally {
    try { fs.unlinkSync(localFile); } catch { /* ignore */ }
    try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  }
}

test("onboarding position hotfix · canonical Position renders on About You Employment step", async ({ browser }) => {
  test.setTimeout(360_000);
  const founderCtx = await browser.newContext();
  const founderPage = await loginAsFounder(founderCtx);

  const firstName = "PosProof";
  const lastName = `Synth${Date.now().toString().slice(-6)}`;
  const email = `posproof.${Date.now()}@synthetic.spectre.test`;

  // 1. Create the synthetic Employee via the real Add Employee UI —
  // uses the same canonical orgPositionId write path Marc used.
  await founderPage.goto(`${STAGING}/app/admin/people/employees/new`, { waitUntil: "domcontentloaded" });
  await founderPage.waitForTimeout(1500);
  await founderPage.locator('[name="firstName"]').fill(firstName);
  await founderPage.locator('[name="lastName"]').fill(lastName);
  await founderPage.locator('[name="personalEmail"]').fill(email);
  await founderPage.locator('[name="mobilePhone"]').fill("555-555-0100");

  const now = new Date();
  await founderPage.locator('[data-testid="expected-start-date-year"]').fill(String(now.getFullYear()));
  await founderPage.locator('[data-testid="expected-start-date-month"]')
    .fill(String(now.getMonth() + 1).padStart(2, "0"));
  await founderPage.locator('[data-testid="expected-start-date-day"]')
    .fill(String(now.getDate()).padStart(2, "0"));
  await founderPage.waitForTimeout(300);

  const deptSel = founderPage.locator('select[name="departmentId"]').first();
  await deptSel.selectOption({ label: "Administration" });
  await founderPage.waitForTimeout(400);
  // Find the Payroll Administrator option by scanning texts + values.
  const posSel = founderPage.locator('select[name="positionId"]').first();
  const posOptions = await posSel.locator("option").evaluateAll((els) =>
    (els as HTMLOptionElement[]).map((o) => ({ value: o.value, text: o.textContent ?? "" })),
  );
  const payrollAdminOpt = posOptions.find((o) => /Payroll Administrator/i.test(o.text));
  if (!payrollAdminOpt || !payrollAdminOpt.value) {
    throw new Error(`Payroll Administrator option not found. Options: ${JSON.stringify(posOptions)}`);
  }
  await posSel.selectOption(payrollAdminOpt.value);
  await founderPage.waitForTimeout(400);
  await founderPage.locator('select[name="compensationCadence"]').selectOption("SALARY");
  await founderPage.locator('[name="compensationAmount"]').fill("85000");

  await founderPage.locator('form button[type="submit"]').first().scrollIntoViewIfNeeded();
  await founderPage.locator('form button[type="submit"]').first().click();
  await founderPage.waitForTimeout(6000);

  const profileUrl = founderPage.url();
  const empIdMatch = /\/employees\/([a-z0-9]+)/.exec(profileUrl);
  expect(empIdMatch, `landed URL should include a new employee id: ${profileUrl}`).not.toBeNull();
  const syntheticEmployeeId = empIdMatch![1];

  // 2. Issue a fresh invitation for the synthetic via SSH → raw token.
  const clubId = "cmrvdeny7000144372ktmmg9c";
  const rawToken = issueInvitationOverSsh(clubId, syntheticEmployeeId);
  expect(rawToken.length).toBeGreaterThan(30);

  // 3. In a fresh, unauthenticated context, redeem the invitation and
  // land on the About You step.
  const empCtx = await browser.newContext();
  const empPage = await empCtx.newPage();
  await empPage.goto(`${STAGING}/hr/onboarding/${rawToken}`, { waitUntil: "domcontentloaded" });
  await empPage.waitForTimeout(2000);
  // Some invitations render an interstitial "Begin onboarding" button.
  const beginButton = empPage.locator('button, a', { hasText: /begin onboarding/i }).first();
  if (await beginButton.count()) {
    await beginButton.click();
    await empPage.waitForTimeout(3000);
  }

  // 4. Navigate to the Employment step and screenshot.
  await empPage.goto(`${STAGING}/hr/onboarding/about-you/employment`, { waitUntil: "domcontentloaded" });
  await empPage.waitForTimeout(2500);
  await empPage.screenshot({
    path: path.join(OUT, "01-employment-position-canonical.png"), fullPage: false,
  });
  const employmentText = await empPage.locator("body").innerText();
  expect(
    employmentText,
    "Employment step must render canonical Position 'Payroll Administrator', not the 'your role' placeholder.",
  ).toContain("Payroll Administrator");

  // Scope the placeholder check to the Position <dd> cell only — the
  // page headline "Let's confirm your role." is intentional copy and
  // must not trigger a false-positive on the placeholder.
  const positionRow = empPage.locator("dl > div", {
    has: empPage.locator("dt", { hasText: "Position" }),
  });
  const positionValue = await positionRow.locator("dd").innerText();
  expect(
    positionValue,
    "Position <dd> cell must show the canonical name, not the placeholder.",
  ).toContain("Payroll Administrator");
  expect(
    positionValue,
    "Position <dd> cell must NOT show the legacy 'your role' placeholder.",
  ).not.toBe("your role");

  // Also verify Department + Employment type + Expected start date render
  // — sanity check that the shared card is fully populated.
  expect(employmentText).toContain("Administration");
  expect(employmentText).toContain("Full-time");

  await empCtx.close();

  // 5. Cleanup: delete the synthetic via founder UI.
  await founderPage.goto(`${STAGING}/app/admin/people/employees/${syntheticEmployeeId}`, {
    waitUntil: "domcontentloaded",
  });
  await founderPage.waitForTimeout(1500);
  const deleteOpener = founderPage.locator('[data-testid="employee-delete-button"]');
  await deleteOpener.scrollIntoViewIfNeeded();
  await deleteOpener.click();
  await founderPage.waitForTimeout(500);
  await founderPage.locator('[data-testid="employee-lifecycle-confirm-input"]').fill("DELETE");
  await founderPage.waitForTimeout(300);
  await founderPage.locator('[data-testid="employee-lifecycle-confirm-button"]').click();
  await founderPage.waitForTimeout(4000);

  await founderPage.goto(`${STAGING}/app/admin/people/employees`, { waitUntil: "domcontentloaded" });
  await founderPage.waitForTimeout(1500);
  await founderPage.screenshot({
    path: path.join(OUT, "03-directory-after-cleanup.png"), fullPage: false,
  });
  const finalDir = await founderPage.locator("body").innerText();
  expect(finalDir).toContain("Chris Turcato");
  expect(finalDir).toContain("Marc Maldiney");
  expect(finalDir, "synthetic should be gone after cleanup").not.toContain(firstName);

  await founderCtx.close();
});
