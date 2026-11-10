#!/usr/bin/env node
// EP-TRAIN-4Y-AE2 §5 — placeholder-letter reconstruction for the
// `cmwa2axv1` descendant chain. Routes through the authorized
// /edit endpoint so lifecycle + audit + separation of duties are
// preserved. No raw Prisma writes.
//
// Safety:
//   - target by draftId + content signature (refuses if options are
//     no longer all single letters or chunk count ≠ option count)
//   - refuses if contentHash doesn't match live staging state

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";

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

// Mirror of the TS normaliser's placeholder-letter reconstruction.
function reconstructPlaceholderLetters(stem, options) {
  const allPlaceholder = options.length >= 2 && options.every((o) => /^[A-Da-d]$/.test(String(o.text ?? "").trim()));
  if (!allPlaceholder) return null;
  const qMark = stem.indexOf("?");
  if (qMark < 10 || qMark >= stem.length - 10) return null;
  const stemHead = stem.slice(0, qMark + 1).trim();
  const tail = stem.slice(qMark + 1).trim();
  let chunks;
  if (/\n/.test(tail)) {
    chunks = tail.split(/\n+/).map((x) => x.trim()).filter((x) => x.length > 0);
  } else {
    chunks = tail.split(/(?<=\.)\s+(?=[A-Z])/).map((x) => x.trim()).filter((x) => x.length > 0);
  }
  const cleanChunks = chunks.filter((c) => c.length > 0 && c.length <= 400);
  if (cleanChunks.length !== options.length) return null;
  return {
    questionText: stemHead,
    options: cleanChunks.map((c, i) => ({ text: c, isCorrect: !!options[i].isCorrect })),
  };
}

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await p.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await p.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([p.waitForURL(/\/app\//), p.click('button[type="submit"]')]);

const list = await p.request.get(
  `${BASE}/api/admin/ai-training/drafts?limit=50&states=REQUIRES_HUMAN_REVIEW,EDITED_VALIDATION_STALE,VALIDATION_FAILED,GENERATED,VALIDATION_PENDING`,
);
const listBody = await list.json();
const mine = (listBody.rows ?? []).filter((d) => d.courseVersionId === VERSION_ID);
console.log(`drafts for version: ${mine.length}`);

const report = [];
for (const d of mine) {
  const r = await p.request.get(`${BASE}/api/admin/ai-training/drafts/${d.draftId}`);
  if (!r.ok()) continue;
  const detail = await r.json();
  const body = detail.draft ?? {};
  const origStem = String(body.questionText ?? "");
  const origOptions = Array.isArray(body.options) ? body.options : [];
  const rebuilt = reconstructPlaceholderLetters(origStem, origOptions);
  if (!rebuilt) {
    report.push({ id: d.draftId, step: "skip", reason: "not a placeholder-letter case" });
    continue;
  }
  console.log(`\n→ reconstructing ${d.draftId}`);
  console.log(`  before stem: ${origStem.slice(0, 80)}…`);
  console.log(`  before opts: ${JSON.stringify(origOptions.map((o) => o.text))}`);
  console.log(`  after  stem: ${rebuilt.questionText.slice(0, 80)}…`);
  console.log(`  after  opts: ${JSON.stringify(rebuilt.options.map((o) => o.text))}`);
  console.log(`  correct idx: ${rebuilt.options.findIndex((o) => o.isCorrect)}`);
  const editResp = await p.request.post(
    `${BASE}/api/admin/ai-training/drafts/${d.draftId}/edit`,
    {
      headers: { "Content-Type": "application/json" },
      data: {
        questionText: rebuilt.questionText,
        options: rebuilt.options,
        explanation: "",
        expectedContentHash: detail.contentHash,
        expectedRecordVersion: detail.recordVersion,
        reviewerNote: "EP-TRAIN-4Y-AE2 §5 — placeholder-letter reconstruction per directive expected shape; correct-answer index preserved.",
      },
    },
  );
  const editBody = await editResp.json().catch(() => ({}));
  if (!editResp.ok() || editBody.ok !== true) {
    report.push({ id: d.draftId, step: "edit", status: editResp.status(), error: editBody?.error, message: editBody?.message });
  } else {
    report.push({ id: d.draftId, step: "reconstructed", newDraftId: editBody.newDraftId });
  }
}
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yae2-reconstruction.json", JSON.stringify(report, null, 2));
console.log("\n━━━━━━ 4Y-AE2 §5 RECONSTRUCTION SUMMARY ━━━━━━");
for (const r of report) {
  const mark = r.step === "reconstructed" ? "✓" : r.step === "skip" ? "·" : "✗";
  console.log(` ${mark} ${r.id} ${r.step}${r.newDraftId ? " → " + r.newDraftId : ""}`);
}
await b.close();
