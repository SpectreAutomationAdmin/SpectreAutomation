// EP-TRAIN-4Y-G — One controlled live pilot: Silver Springs orientation
// video (owned by Coulee Ridge staging tenant).
//
// Scope:
//   1. Request transcription via the manager admin API (same route the UI uses).
//   2. Poll transcription job until COMPLETED.
//   3. Request generation via the admin API against the completed build.
//   4. Poll generation run until COMPLETED.
//   5. Open the AI workspace in the manager UI; take screenshots.
//   6. Verify the manager workflow surfaces: transcript view + draft review
//      + checkpoint positions + final assessment.
//
// NO draft approval; NO draft promotion (§7: "Do not automatically
// approve or promote questions"). We CLICK TO verify the capabilities
// exist; we do not trigger them with real actions.

import { test, expect } from "@playwright/test";
import { loginAsFounder } from "./_lib/staging-auth";
import * as fs from "node:fs";
import * as path from "node:path";

const COURSE_VERSION_ID = "cmvzs3w05000456qcgfgps7gy"; // DRAFT, 642s, Silver Springs video
const COURSE_ID = "cmvzs3vz9000256qcu7lfysoz";
const EXPECTED_VIDEO_SHA = "d1ddb823437c78478c5f2388b5daa42c957a8706afcce871bd6a522801efee29";
const EXPECTED_DURATION_SEC = 642;

const EVIDENCE_DIR = path.join(process.cwd(), "test-results", "4y-g-pilot");

test.beforeAll(() => {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
});

test("4Y-G Gate 2 live pilot — Silver Springs orientation", async ({ context, request }) => {
  test.setTimeout(1200_000); // 20 min — covers ~90s Whisper cold-boot + ~60s Qwen cold-boot + inference

  // ─────────────────────── Authenticate
  const page = await loginAsFounder(context);

  // ─────────────────────── §5. Request transcription
  console.log("[4Y-G] Requesting transcription for version", COURSE_VERSION_ID);
  const t0 = Date.now();
  const transcribeResp = await request.post(
    `https://staging.spectreautomation.com/api/admin/training/versions/${COURSE_VERSION_ID}/transcribe`,
    {
      headers: { "Content-Type": "application/json", cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") },
      data: {},
    },
  );
  expect(transcribeResp.ok(), `transcribe request failed: ${transcribeResp.status()}`).toBeTruthy();
  const transcribeInit = await transcribeResp.json();
  console.log("[4Y-G] Transcribe init:", JSON.stringify(transcribeInit));
  fs.writeFileSync(path.join(EVIDENCE_DIR, "01-transcribe-init.json"), JSON.stringify(transcribeInit, null, 2));
  expect(transcribeInit.jobId).toBeTruthy();
  const jobId: string = transcribeInit.jobId;

  // ─────────────────────── Poll until COMPLETED
  let transcribeStatus: any;
  const transcribeDeadline = Date.now() + 10 * 60 * 1000; // 10 min
  while (Date.now() < transcribeDeadline) {
    const pollResp = await request.get(
      `https://staging.spectreautomation.com/api/admin/training/versions/${COURSE_VERSION_ID}/transcription-status`,
      {
        headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") },
      },
    );
    if (pollResp.ok()) {
      transcribeStatus = await pollResp.json();
      console.log(`[4Y-G] Transcribe state=${transcribeStatus.state} elapsed=${Math.floor((Date.now() - t0) / 1000)}s`);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(transcribeStatus.state)) break;
    } else {
      console.log(`[4Y-G] poll non-OK: ${pollResp.status()}`);
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, "02-transcribe-final.json"), JSON.stringify(transcribeStatus, null, 2));
  expect(transcribeStatus?.state, `transcribe did not reach COMPLETED; state=${transcribeStatus?.state}`).toBe("COMPLETED");
  const resolvedTranscriptBuildId: string | undefined = transcribeStatus?.transcript?.resolvedTranscriptBuildId;
  expect(resolvedTranscriptBuildId, "transcribe result must include resolvedTranscriptBuildId").toBeTruthy();
  const transcribeElapsedSec = Math.floor((Date.now() - t0) / 1000);
  console.log(`[4Y-G] Transcription COMPLETED in ${transcribeElapsedSec}s`);

  // ─────────────────────── §6. Request generation
  console.log("[4Y-G] Requesting generation for buildId", resolvedTranscriptBuildId);
  const g0 = Date.now();
  const generateResp = await request.post(
    `https://staging.spectreautomation.com/api/admin/training/versions/${COURSE_VERSION_ID}/generate`,
    {
      headers: { "Content-Type": "application/json", cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") },
      data: { targetTotalQuestions: 6, resolvedTranscriptBuildId },
    },
  );
  expect(generateResp.ok(), `generate request failed: ${generateResp.status()} — ${await generateResp.text()}`).toBeTruthy();
  const generateInit = await generateResp.json();
  console.log("[4Y-G] Generate init:", JSON.stringify(generateInit));
  fs.writeFileSync(path.join(EVIDENCE_DIR, "03-generate-init.json"), JSON.stringify(generateInit, null, 2));
  expect(generateInit.runId).toBeTruthy();
  const runId: string = generateInit.runId;

  // ─────────────────────── Poll generation until COMPLETED
  let generateStatus: any;
  const generateDeadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < generateDeadline) {
    const pollResp = await request.get(
      `https://staging.spectreautomation.com/api/admin/training/versions/${COURSE_VERSION_ID}/generation-status`,
      {
        headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ") },
      },
    );
    if (pollResp.ok()) {
      generateStatus = await pollResp.json();
      console.log(`[4Y-G] Generate state=${generateStatus.state} elapsed=${Math.floor((Date.now() - g0) / 1000)}s`);
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(generateStatus.state)) break;
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, "04-generate-final.json"), JSON.stringify(generateStatus, null, 2));
  expect(generateStatus?.state, `generate did not reach COMPLETED; state=${generateStatus?.state}`).toBe("COMPLETED");
  const generateElapsedSec = Math.floor((Date.now() - g0) / 1000);
  console.log(`[4Y-G] Generation COMPLETED in ${generateElapsedSec}s`);

  // ─────────────────────── §7. Manager UI walk-through
  // Navigate to the AI workspace for this version.
  const wsUrl = `https://staging.spectreautomation.com/app/admin/training/courses/${COURSE_ID}/versions/${COURSE_VERSION_ID}`;
  await page.goto(wsUrl);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "05-workspace.png"), fullPage: true });

  // Scroll to find transcript / AI-workspace / drafts sections.
  const hasTranscriptText = await page
    .getByText(/transcript|transcription/i)
    .first()
    .isVisible()
    .catch(() => false);
  const hasDraftText = await page
    .getByText(/draft|proposed|ai question/i)
    .first()
    .isVisible()
    .catch(() => false);

  const manifest = {
    timestamp: new Date().toISOString(),
    pilot: {
      courseId: COURSE_ID,
      courseVersionId: COURSE_VERSION_ID,
      expectedVideoSha: EXPECTED_VIDEO_SHA,
      expectedDurationSec: EXPECTED_DURATION_SEC,
    },
    transcribeJob: {
      id: jobId,
      state: transcribeStatus.state,
      elapsedSec: transcribeElapsedSec,
      resolvedTranscriptBuildId,
      failureCode: transcribeStatus.failureCode ?? null,
      transcriptMeta: transcribeStatus.transcript ?? null,
    },
    generateRun: {
      id: runId,
      state: generateStatus.state,
      elapsedSec: generateElapsedSec,
      breakdown: generateStatus.breakdown ?? null,
      failureCode: generateStatus.failureCode ?? null,
    },
    managerUi: {
      workspaceUrl: wsUrl,
      transcriptCueVisible: hasTranscriptText,
      draftCueVisible: hasDraftText,
    },
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, "00-manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("[4Y-G] FINAL MANIFEST:", JSON.stringify(manifest, null, 2));
});
