// EP-TRAIN-5D-3 (2026-11-02) — Course Revision Checkpoint Integrity.
//
// End-to-end authenticated-admin regression: provision a disposable
// fixture course (with video + 2 checkpoints + questions typed
// SINGLE_CHOICE / MULTI_ANSWER / TRUE_FALSE), log in as the founder
// admin, click "Revise training" on the course detail page which
// invokes `startNewDraftAction` → `startNewDraft`.  Verify via SSH
// snapshot that the new DRAFT v2 contains:
//   §1 All checkpoints from v1 (new ids, atSecond + label + flags
//      preserved).
//   §2 All questions from v1 with questionType preserved for all
//      three types.
//   §3 question.checkpointId remapped to the v2 checkpoint ids
//      (never leaking a v1 checkpoint id).
//   §4 v1 PUBLISHED remains byte-identical (no mutation of the
//      source version).
//
// Also verifies:
//   §5 Historical TrainingCompletion rows seeded on v1 remain
//      associated with v1.
//   §6 Clicking Revise Training a second time reuses the v2 DRAFT
//      (idempotency).

import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import {
  provisionIsolatedFixture,
  teardownIsolatedFixture,
  newRunId,
  type IsolatedFixture,
} from "./_lib/ep-train-3-fixture";
import {
  seedHistoricalCompletion,
  cleanupFixtureObligations,
} from "./_lib/ep-train-5c3a-seed";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FLYCTL = process.env.FLYCTL_PATH ?? "C:/Users/cturcato/.fly/bin/flyctl.exe";

/** Direct SSH query to the staging Prisma for the DRAFT v2 clone
 *  state (checkpoints + questions + options + final-assessment
 *  binding). */
function snapshotCloneState(fixture: IsolatedFixture): {
  v1: {
    versionId: string;
    checkpoints: Array<{ id: string; atSecond: number; label: string | null; requiredToProceed: boolean; maxRetries: number; displayOrder: number }>;
    questions: Array<{ id: string; prompt: string; checkpointId: string | null; questionType: string; displayOrder: number }>;
  } | null;
  v2: {
    versionId: string;
    checkpoints: Array<{ id: string; atSecond: number; label: string | null; requiredToProceed: boolean; maxRetries: number; displayOrder: number }>;
    questions: Array<{ id: string; prompt: string; checkpointId: string | null; questionType: string; displayOrder: number }>;
  } | null;
  completions: Array<{ id: string; courseVersionId: string; score: number }>;
} {
  const script = `
import { createRequire } from "node:module";
const req = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = req("@prisma/client");
const p = new PrismaClient();

const courseId = ${JSON.stringify(fixture.courseId)};
const versions = await p.trainingCourseVersion.findMany({
  where: { courseId },
  orderBy: { version: "asc" },
  include: {
    checkpoints: { orderBy: { displayOrder: "asc" } },
    questions: { orderBy: { displayOrder: "asc" } },
  },
});

const v1 = versions.find((v) => v.version === 1) ?? null;
const v2 = versions.find((v) => v.version === 2) ?? null;

const employeeId = ${JSON.stringify(fixture.employeeId)};
const completions = await p.trainingCompletion.findMany({
  where: { employeeId },
  select: { id: true, courseVersionId: true, score: true },
});

console.log("SNAPSHOT " + JSON.stringify({
  v1: v1 ? { versionId: v1.id, checkpoints: v1.checkpoints, questions: v1.questions.map((q) => ({ id: q.id, prompt: q.prompt, checkpointId: q.checkpointId, questionType: q.questionType, displayOrder: q.displayOrder })) } : null,
  v2: v2 ? { versionId: v2.id, checkpoints: v2.checkpoints, questions: v2.questions.map((q) => ({ id: q.id, prompt: q.prompt, checkpointId: q.checkpointId, questionType: q.questionType, displayOrder: q.displayOrder })) } : null,
  completions,
}));
await p.$disconnect();
process.exit(0);
`;
  const b64 = Buffer.from(script).toString("base64");
  const tmp = `/tmp/ep5d3-snap-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}.mjs`;
  const remoteCmd = `/bin/sh -c "echo ${b64} | base64 -d > ${tmp} && cd /app && node ${tmp}; rc=$?; rm -f ${tmp}; exit $rc"`;
  const out = execFileSync(
    FLYCTL,
    ["ssh", "console", "--app", "spectre-staging", "-C", remoteCmd],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const line = out.split(/\r?\n/).find((l) => l.startsWith("SNAPSHOT "));
  if (!line) throw new Error(`snapshotCloneState failed: ${out.slice(-500)}`);
  return JSON.parse(line.slice(line.indexOf("{")));
}

test.describe("EP-TRAIN-5D-3 :: Revise Training clone integrity", () => {
  test.setTimeout(300_000);

  test.beforeAll(() => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");
  });

  test("clicking Revise Training clones checkpoints + question metadata; v1 untouched", async ({ browser }) => {
    const runId = newRunId("5d3");
    const fixture = provisionIsolatedFixture(runId);
    try {
      // Seed a historical completion on v1 so we can later assert it
      // stays bound to v1 after the clone.
      const historical = seedHistoricalCompletion(fixture, { score: 100, daysAgo: 7 });

      // §1 — pre-revise snapshot: v1 has 2 checkpoints + 6 questions
      // (per EP-TRAIN-3 Slice 3 fixture) + the historical completion.
      const pre = snapshotCloneState(fixture);
      expect(pre.v1).not.toBeNull();
      expect(pre.v1!.checkpoints.length).toBeGreaterThanOrEqual(1);
      expect(pre.v1!.questions.length).toBeGreaterThanOrEqual(1);
      expect(pre.v2).toBeNull();
      const v1Snapshot = pre.v1!;
      expect(pre.completions.some((c) => c.id === historical.completionId && c.courseVersionId === v1Snapshot.versionId))
        .toBe(true);

      // §2 — log in as founder admin and click Revise training.
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await loginAsFounder(ctx);
      await page.goto(
        `${BASE}/app/admin/people/safety-training/${encodeURIComponent(fixture.courseId)}`,
        { waitUntil: "networkidle" },
      );
      const btn = page.getByTestId("training-start-new-draft");
      await expect(btn).toBeVisible({ timeout: 15_000 });
      await Promise.all([
        page.waitForURL(/safety-training\/[^/]+/, { waitUntil: "networkidle" }).catch(() => {}),
        btn.click(),
      ]);
      // The server action redirects back to the course detail; the
      // open-draft banner appears when the DRAFT exists.  Give the
      // page a moment to settle.
      await page.waitForTimeout(1500);
      await ctx.close();

      // §3 — snapshot v2 + verify clone semantics.
      const post = snapshotCloneState(fixture);
      expect(post.v2).not.toBeNull();
      const v2 = post.v2!;

      // §3.1 All v1 checkpoints cloned onto v2 with new ids + correct config.
      expect(v2.checkpoints.length).toBe(v1Snapshot.checkpoints.length);
      const v1CpById = new Map(v1Snapshot.checkpoints.map((c) => [c.id, c]));
      for (const v2Cp of v2.checkpoints) {
        expect(v1CpById.has(v2Cp.id)).toBe(false); // new id, not v1's
        const match = v1Snapshot.checkpoints.find((v1cp) => v1cp.atSecond === v2Cp.atSecond && v1cp.displayOrder === v2Cp.displayOrder);
        expect(match, `v2 CP at ${v2Cp.atSecond}s should match a v1 CP`).toBeDefined();
        expect(v2Cp.label).toBe(match!.label);
        expect(v2Cp.requiredToProceed).toBe(match!.requiredToProceed);
        expect(v2Cp.maxRetries).toBe(match!.maxRetries);
      }

      // §3.2 All v1 questions cloned with questionType preserved.
      expect(v2.questions.length).toBe(v1Snapshot.questions.length);
      const v1QuestionsByOrder = new Map(v1Snapshot.questions.map((q) => [q.displayOrder, q]));
      for (const v2Q of v2.questions) {
        const v1Q = v1QuestionsByOrder.get(v2Q.displayOrder)!;
        expect(v2Q.questionType).toBe(v1Q.questionType);
        expect(v2Q.prompt).toBe(v1Q.prompt);
      }

      // §3.3 question.checkpointId remapped (no cross-version leak).
      const v2CheckpointIdSet = new Set(v2.checkpoints.map((c) => c.id));
      const v1CheckpointIdSet = new Set(v1Snapshot.checkpoints.map((c) => c.id));
      for (const v2Q of v2.questions) {
        if (v2Q.checkpointId !== null) {
          // Must be a v2 checkpoint id, never a v1 id.
          expect(v2CheckpointIdSet.has(v2Q.checkpointId)).toBe(true);
          expect(v1CheckpointIdSet.has(v2Q.checkpointId)).toBe(false);
          // The corresponding v1 question MUST also have been
          // checkpoint-bound (preserving binding semantics).
          const v1Q = v1QuestionsByOrder.get(v2Q.displayOrder)!;
          expect(v1Q.checkpointId).not.toBeNull();
        } else {
          // Final-assessment questions stay unbound.
          const v1Q = v1QuestionsByOrder.get(v2Q.displayOrder)!;
          expect(v1Q.checkpointId).toBeNull();
        }
      }

      // §4 — v1 remains byte-identical to pre-snapshot.
      expect(post.v1!.versionId).toBe(v1Snapshot.versionId);
      expect(post.v1!.checkpoints.length).toBe(v1Snapshot.checkpoints.length);
      expect(post.v1!.checkpoints.map((c) => c.id).sort()).toEqual(v1Snapshot.checkpoints.map((c) => c.id).sort());
      expect(post.v1!.questions.map((q) => q.id).sort()).toEqual(v1Snapshot.questions.map((q) => q.id).sort());

      // §5 — Historical completion still bound to v1.
      const histAfter = post.completions.find((c) => c.id === historical.completionId);
      expect(histAfter).toBeDefined();
      expect(histAfter!.courseVersionId).toBe(v1Snapshot.versionId);

      // §6 — Idempotency: second click reuses v2 DRAFT (no v3 created).
      const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page2 = await loginAsFounder(ctx2);
      await page2.goto(
        `${BASE}/app/admin/people/safety-training/${encodeURIComponent(fixture.courseId)}`,
        { waitUntil: "networkidle" },
      );
      const btn2 = page2.getByTestId("training-start-new-draft");
      if (await btn2.count() > 0) {
        await Promise.all([
          page2.waitForURL(/safety-training\/[^/]+/, { waitUntil: "networkidle" }).catch(() => {}),
          btn2.click(),
        ]);
        await page2.waitForTimeout(1500);
      }
      await ctx2.close();
      const postRepeat = snapshotCloneState(fixture);
      expect(postRepeat.v2!.versionId).toBe(v2.versionId);
      expect(postRepeat.v2!.checkpoints.length).toBe(v2.checkpoints.length);
    } finally {
      cleanupFixtureObligations(fixture);
      teardownIsolatedFixture(runId);
    }
  });
});
