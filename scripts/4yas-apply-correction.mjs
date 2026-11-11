#!/usr/bin/env node
// EP-TRAIN-4Y-AS §7 — apply the manager editorial correction on
// the AR retained proposal via the recovery endpoint. Zero GPU.
// Only persists if the full validation pipeline passes.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const AR_RUN_ID = "cmwbij5rq0007mmqsxow0h9jv";
const GROUP_ID = "fa-1";
const PROPOSAL_INDEX = 0;

// Editorial correction per founder directive §3. Original Qwen
// options are preserved; stem + explanation rewritten to pass the
// existing sanitiser without altering grounding or correct answer.
const EDITED_STEM = "How can employees access their pay stubs?";
const EDITED_OPTIONS = [
  { text: "By using the last four digits of their SIN number", isCorrect: true },
  { text: "By calling the HR department", isCorrect: false },
  { text: "By logging into the company's online portal", isCorrect: false },
  { text: "By visiting the physical HR office", isCorrect: false },
];
const EDITED_EXPLANATION =
  "Employees access their pay stubs by using the last four digits of their SIN number. An email notification arrives on each payday, and the last four SIN digits serve as the quick, secure identifier that lets them open the statement. The remaining options describe alternative methods not covered in the onboarding video.";

function env(k) {
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
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();
await pg.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await pg.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await pg.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([pg.waitForURL(/\/app\//), pg.click('button[type="submit"]')]);

console.log("Posting manager editorial correction...");
const resp = await pg.request.post(
  `${BASE}/api/admin/ai-training/runs/${AR_RUN_ID}/recover-rejected-proposal`,
  {
    headers: { "Content-Type": "application/json" },
    data: {
      groupId: GROUP_ID,
      proposalIndex: PROPOSAL_INDEX,
      editedQuestionText: EDITED_STEM,
      editedOptions: EDITED_OPTIONS,
      editedExplanation: EDITED_EXPLANATION,
    },
  },
);
const body = await resp.json();
console.log(`HTTP ${resp.status()}`);
console.log(JSON.stringify(body, null, 2));
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yas-correction-dispatch.json",
  JSON.stringify({ at: new Date().toISOString(), status: resp.status(), body }, null, 2));
await b.close();
if (resp.status() !== 200 || !body.ok || !body.newDraftId) {
  console.error("CORRECTION REFUSED");
  process.exit(1);
}
console.log(`\nCORRECTION APPLIED — new draft ${body.newDraftId} created, dedup=${body.validation?.dedup}, idempotent=${body.idempotent}`);
