// EP-TRAIN-5B-1 (2026-11-02) — authenticated browser acceptance.
//
// Covers directive §3 steps 1-15 against an isolated disposable
// fixture on Coulee Ridge:
//
//   - Provisions a disposable course + 2 test employees + a prior
//     OUTSTANDING MANUAL_REINSTATE for one of them.
//   - Logs in as the founder.
//   - Opens the course detail, verifies Revise + Require Retake
//     buttons.
//   - Opens Require Retake → verifies step 1 shape (reason / due
//     date / filterable list).
//   - Picks both fixture employees → opens Review → verifies the
//     conflict governance UI renders for the employee with a prior
//     OUTSTANDING, verifies no conflict control for the other.
//   - Picks REPLACE for the conflict → confirms issuance → verifies
//     success banner + DB state (new OUTSTANDING MANUAL_REINSTATE +
//     prior CANCELED + the other employee's OUTSTANDING issued).
//   - Opens Require Retake again on the same employee → verifies
//     the UI still enforces conflict choice (idempotent re-prompt).
//   - Tears down the fixture (removes obligations + employees +
//     course) without touching any legitimate training record.
//
// Does NOT:
//   - Exercise cross-tenant refusal (that path is proven by the
//     contract test §6.10; UI-level refusal is server-enforced).
//   - Attempt a destructive write against the founder's own records.
//   - Modify any legitimate TrainingCompletion/Attempt/Progress row.

import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { loginAsFounder } from "./_lib/staging-auth";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FLYCTL = process.env.FLYCTL_PATH ?? "C:/Users/cturcato/.fly/bin/flyctl.exe";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const outDir = path.resolve(process.cwd(), "test-results/ep-train-5b1-acceptance");
fs.mkdirSync(outDir, { recursive: true });

interface Fixture {
  runId: string;
  courseId: string;
  v1Id: string;
  empAId: string;
  empBId: string;
  empBPriorObligationId: string;
}

/** Provision + teardown via Fly SSH base64 trick (same as EP-UX-2 fixture harness). */
function sshRunScript(script: string, timeoutMs = 60_000): string {
  const b64 = Buffer.from(script).toString("base64");
  const remote = `/bin/sh -c "echo ${b64} | base64 -d > /app/scripts/_sc.mjs && cd /app && node scripts/_sc.mjs; rm -f /app/scripts/_sc.mjs"`;
  return execFileSync(FLYCTL, ["ssh", "console", "--app", "spectre-staging", "-C", remote], { encoding: "utf8", timeout: timeoutMs });
}

function provisionFixture(): Fixture {
  const runId = `b1-${Math.random().toString(36).slice(2, 8)}`;
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const clubId = ${JSON.stringify(COULEE_CLUB_ID)};
const runId = ${JSON.stringify(runId)};

const course = await p.trainingCourse.create({
  data: { clubId, code: "TRAIN5B1_" + runId.toUpperCase(), title: "EP-TRAIN-5B-1 Fixture " + runId, category: "Safety" },
});
const v1 = await p.trainingCourseVersion.create({
  data: {
    courseId: course.id, version: 1, state: "PUBLISHED",
    title: course.title, publishedAt: new Date(),
    appliesToAll: false, required: true, requiresKnowledgeTest: false,
    videoStorageKey: "clubs/_fixture/" + runId + "/stub.mp4",
    videoMimeType: "video/mp4", videoDurationSec: 30,
    videoSizeBytes: 1024, videoSha256: "sha-" + runId,
  },
});
await p.trainingCourse.update({ where: { id: course.id }, data: { currentVersionId: v1.id } });

const empA = await p.employee.create({
  data: {
    clubId, employeeNumber: "E-5B1-A-" + runId,
    firstName: "FixtureA", lastName: "Train5B1-" + runId,
    personalEmail: "fixture-a-" + runId + "@spectre-test.local",
    employeeLifecycle: "ACTIVE",
  },
});
const empB = await p.employee.create({
  data: {
    clubId, employeeNumber: "E-5B1-B-" + runId,
    firstName: "FixtureB", lastName: "Train5B1-" + runId,
    personalEmail: "fixture-b-" + runId + "@spectre-test.local",
    employeeLifecycle: "ACTIVE",
  },
});

// Explicit per-employee assignment so both fixture employees are applicable.
await p.trainingAssignment.create({
  data: { clubId, employeeId: empA.id, courseId: course.id, note: "5B1 fixture" },
});
await p.trainingAssignment.create({
  data: { clubId, employeeId: empB.id, courseId: course.id, note: "5B1 fixture" },
});

// Pre-seed empB with a prior OUTSTANDING MANUAL_REINSTATE on this course
// so the UI exercises the conflict-governance review-step.
const prior = await p.trainingObligation.create({
  data: {
    clubId, employeeId: empB.id, courseId: course.id, courseVersionId: v1.id,
    reason: "MANUAL_REINSTATE", reasonNote: "Pre-seeded prior ask for 5B1 fixture",
    issuedByUserId: null,
    issuanceKey: "rtk:fixture:" + runId,
    status: "OUTSTANDING",
  },
});

console.log(JSON.stringify({
  runId, courseId: course.id, v1Id: v1.id,
  empAId: empA.id, empBId: empB.id, empBPriorObligationId: prior.id,
}));
await p.$disconnect();
process.exit(0);
`;
  const out = sshRunScript(script);
  // The last non-empty line is the JSON payload.
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  const jsonLine = lines[lines.length - 1];
  const data = JSON.parse(jsonLine);
  return { ...data, runId };
}

function teardownFixture(fixture: Fixture): void {
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const courseId = ${JSON.stringify(fixture.courseId)};
const empAId = ${JSON.stringify(fixture.empAId)};
const empBId = ${JSON.stringify(fixture.empBId)};

// Order: obligations → assignments → versions → course → employees.
await p.trainingObligation.deleteMany({ where: { courseId } });
await p.trainingAssignment.deleteMany({ where: { courseId } });
await p.trainingCourseVersion.deleteMany({ where: { courseId } });
await p.trainingCourse.delete({ where: { id: courseId } });
await p.employee.delete({ where: { id: empAId } }).catch(() => {});
await p.employee.delete({ where: { id: empBId } }).catch(() => {});
console.log("TORN_DOWN");
await p.$disconnect();
process.exit(0);
`;
  const out = sshRunScript(script, 90_000);
  if (!out.includes("TORN_DOWN")) throw new Error(`fixture teardown failed: ${out.slice(0, 400)}`);
}

function queryFixtureObligations(fixture: Fixture): Array<{ id: string; employeeId: string; reason: string; status: string }> {
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const rows = await p.trainingObligation.findMany({
  where: { courseId: ${JSON.stringify(fixture.courseId)} },
  select: { id: true, employeeId: true, reason: true, status: true, reasonNote: true, issuanceKey: true },
  orderBy: { createdAt: "asc" },
});
console.log(JSON.stringify(rows));
await p.$disconnect();
process.exit(0);
`;
  const out = sshRunScript(script);
  const lines = out.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test.describe("EP-TRAIN-5B-1 :: authenticated acceptance", () => {
  test.setTimeout(600_000);

  test("end-to-end: provision → walk admin UI → verify DB → teardown", async ({ browser }) => {
    const fixture = provisionFixture();
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await loginAsFounder(ctx);
      await page.goto(`${BASE}/app/admin/people/safety-training/${fixture.courseId}`, { waitUntil: "networkidle" });

      // Course detail renders fixture course + both action buttons.
      await expect(page.locator("h1")).toContainText("EP-TRAIN-5B-1 Fixture");
      await expect(page.locator('[data-testid="training-start-new-draft"]')).toBeVisible();
      await expect(page.locator('[data-testid="training-require-retake-open"]')).toBeVisible();
      await page.screenshot({ path: path.join(outDir, "01-course-detail-fixture.png"), fullPage: true });

      // Open Require Retake modal.
      await page.locator('[data-testid="training-require-retake-open"]').click();
      await expect(page.locator('[data-testid="training-require-retake-dialog"]')).toBeVisible();

      // Fill reason.
      await page.locator('[data-testid="training-require-retake-reason"]').fill("5B1 acceptance test — refresher refresh.");

      // Select BOTH fixture employees.
      const fixtureEmpAnumber = `E-5B1-A-${fixture.runId}`;
      const fixtureEmpBnumber = `E-5B1-B-${fixture.runId}`;
      await page.locator(`[data-testid="training-require-retake-select-${fixtureEmpAnumber}"]`).check();
      await page.locator(`[data-testid="training-require-retake-select-${fixtureEmpBnumber}"]`).check();
      await page.screenshot({ path: path.join(outDir, "02-retake-step1-both-selected.png"), fullPage: true });

      // Click Review.
      await page.locator('[data-testid="training-require-retake-review"]').click();
      // Review step: empA has NO conflict (plain row). empB has a conflict
      // with Keep both / Replace radios.
      const empAReviewRow = page.locator(`[data-testid="training-require-retake-review-${fixtureEmpAnumber}"]`);
      const empBReviewRow = page.locator(`[data-testid="training-require-retake-review-${fixtureEmpBnumber}"]`);
      await expect(empAReviewRow).toBeVisible();
      await expect(empBReviewRow).toBeVisible();
      // empA's conflict column shows "None".
      await expect(empAReviewRow).toContainText("None");
      // empB's conflict column shows the per-row conflict controls.
      await expect(empBReviewRow.locator(`[data-testid="training-conflict-${fixtureEmpBnumber}-keep-both"]`)).toBeVisible();
      await expect(empBReviewRow.locator(`[data-testid="training-conflict-${fixtureEmpBnumber}-replace"]`)).toBeVisible();
      await page.screenshot({ path: path.join(outDir, "03-retake-step2-review-conflict.png"), fullPage: true });

      // Server-side governance: Confirm & issue is blocked (client-side)
      // until a conflict choice is made.  Pick REPLACE.
      await empBReviewRow.locator(`[data-testid="training-conflict-${fixtureEmpBnumber}-replace"]`).check();
      await page.locator('[data-testid="training-require-retake-confirm"]').click();

      // Success panel.
      await expect(page.locator('[data-testid="training-require-retake-success"]')).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: path.join(outDir, "04-retake-success.png"), fullPage: true });

      // DB verification.
      const obligations = queryFixtureObligations(fixture);
      // Expect: original prior for empB → CANCELED. 2 new MANUAL_REINSTATE
      // obligations OUTSTANDING (one for each selected employee).
      const canceled = obligations.filter((o) => o.status === "CANCELED");
      const outstanding = obligations.filter((o) => o.status === "OUTSTANDING");
      expect(canceled.length).toBe(1);
      expect(canceled[0].id).toBe(fixture.empBPriorObligationId);
      expect(outstanding.length).toBe(2);
      expect(outstanding.every((o) => o.reason === "MANUAL_REINSTATE")).toBe(true);
      expect(new Set(outstanding.map((o) => o.employeeId)))
        .toEqual(new Set([fixture.empAId, fixture.empBId]));

      // --- Idempotency: re-open the modal, repeat with the same fixture
      // employees, confirm the conflict governance now flags empA (new
      // OUTSTANDING just issued) AND empB (its new OUTSTANDING).
      await page.goto(`${BASE}/app/admin/people/safety-training/${fixture.courseId}`, { waitUntil: "networkidle" });
      await page.locator('[data-testid="training-require-retake-open"]').click();
      await page.locator('[data-testid="training-require-retake-reason"]').fill("Idempotency test — same employees.");
      await page.locator(`[data-testid="training-require-retake-select-${fixtureEmpAnumber}"]`).check();
      await page.locator(`[data-testid="training-require-retake-select-${fixtureEmpBnumber}"]`).check();
      await page.locator('[data-testid="training-require-retake-review"]').click();
      // Both now carry prior OUTSTANDING (from the first run) → BOTH
      // show conflict controls.
      await expect(page.locator(`[data-testid="training-conflict-${fixtureEmpAnumber}-keep-both"]`)).toBeVisible();
      await expect(page.locator(`[data-testid="training-conflict-${fixtureEmpBnumber}-keep-both"]`)).toBeVisible();
      await page.screenshot({ path: path.join(outDir, "05-retake-step2-both-conflict.png"), fullPage: true });
      // Cancel this second attempt (do NOT issue a second round of
      // obligations — the directive §3 proves "no duplicate requirements"
      // via the contract test §6.7; the Playwright run only has to
      // demonstrate the UI enforces re-prompt).
      await page.locator("button", { hasText: "Cancel" }).first().click();
    } finally {
      teardownFixture(fixture);
    }
  });
});
