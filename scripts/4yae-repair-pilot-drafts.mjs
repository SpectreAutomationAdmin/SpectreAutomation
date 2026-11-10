#!/usr/bin/env node
// EP-TRAIN-4Y-AE §5 — repair the 5 pilot drafts' structural defects.
//
// Uses the SAME /edit endpoint the manager inline-edit path uses, so
// every repair flows through writeStateTransition (lifecycle-enforced
// SUPERSEDED_BY_EDIT → EDITED_VALIDATION_STALE), is audited, and
// requires a reviewer to re-approve. No raw Prisma mutation, no GPU.
//
// Cleaning rules (deterministic, mirror the validator's
// `normaliseStructuredQuestion`):
//   - strip "\nA) … B) …" option blocks from the stem when every
//     embedded body matches an option.text
//   - strip option-body paragraphs that appear verbatim in the stem
//     after the "?"
//   - strip "A) " / "B) " letter-prefixes from option.text fields
//   - strip "Correct Answer: X" / "*Segment IDs: [...]*" tails
//
// Ambiguous cases are flagged for manual review, never auto-corrected.
//
// Protected: refuses to touch the founder course's attribution row or
// the pilot course `cmw8n6z8f0008z4nxck6uvms9` /
// `cmvzs3vz9000256qcu7lfysoz` metadata — only touches the 5 drafts.

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

// Replicate normaliseStructuredQuestion's behavior inline (the script
// runs on the host; the module is TS). Keep in sync with
// src/lib/hr/training/ai-review/question-structure-validator.ts.
const EMBEDDED_OPTION_LINE_RX = /(?:\n|^)\s*(?:[*_]{0,2})([A-Da-d])(?:[*_]{0,2})\s*[)\].:]\s+\S/;
const OPTION_LABEL_PREFIX_RX = /^\s*(?:[*_]{0,2}\(?)?([A-Da-d])(?:[*_]{0,2}\)?)\s*[)\].:]\s+/;
const EMBEDDED_SPLIT_RX = /(?:\n|^)\s*(?:[*_]{0,2})([A-Da-d])(?:[*_]{0,2})\s*[)\].:]\s+/g;

function normaliseQuestion(questionText, options) {
  let stem = String(questionText ?? "");
  const stripped = options.map((o) => ({
    text: String(o.text ?? "").replace(OPTION_LABEL_PREFIX_RX, "").trim(),
    isCorrect: !!o.isCorrect,
  }));

  // Strip Correct Answer / Segment IDs tails.
  stem = stem.replace(/\n*\*{0,2}\s*Correct\s+Answer\s*:\s*\*{0,2}\s*[A-D]\s*\n*/gi, "\n");
  stem = stem.replace(/\n*\*?\s*Segment\s*IDs?\s*:\s*\[[\d, ]+\]\s*\*?\s*/gi, "");

  // Strip inlined option block.
  const m = EMBEDDED_SPLIT_RX.exec(stem);
  if (m) {
    const cut = m.index;
    const stemCore = stem.slice(0, cut).trim();
    const inlined = stem.slice(cut);
    const chunks = inlined
      .split(/(?:\n|^)\s*(?:[*_]{0,2})([A-Da-d])(?:[*_]{0,2})\s*[)\].:]\s+/)
      .filter((s) => s !== undefined && s !== null)
      .map((s) => String(s).trim())
      .filter((s) => s.length > 0 && !/^[A-Da-d]$/.test(s));
    const optTextsLower = stripped.map((o) => o.text.toLowerCase());
    const everyChunkMatches = chunks.length > 0 && chunks.every((c) =>
      optTextsLower.some((ot) => ot.length > 10 && (c.toLowerCase().startsWith(ot) || ot.startsWith(c.toLowerCase().slice(0, Math.min(ot.length, c.length))))),
    );
    if (everyChunkMatches && stemCore.length > 10) {
      stem = stemCore;
    }
  }

  // Strip option-body paragraphs that duplicate options.
  const qIdx = stem.indexOf("?");
  if (qIdx >= 10 && qIdx < stem.length - 10) {
    const afterQ = stem.slice(qIdx + 1).trim();
    const paras = afterQ.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
    const optLower = stripped.map((o) => o.text.toLowerCase());
    const allMatch = paras.length > 0 && paras.every((p) =>
      optLower.some((ot) => ot.length > 10 && p.toLowerCase().includes(ot.slice(0, Math.min(ot.length, 60)))),
    );
    if (allMatch) stem = stem.slice(0, qIdx + 1).trim();
  }

  stem = stem.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { questionText: stem, options: stripped };
}

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await p.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await p.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([p.waitForURL(/\/app\//), p.click('button[type="submit"]')]);

const listResp = await p.request.get(
  `${BASE}/api/admin/ai-training/drafts?limit=50&states=REQUIRES_HUMAN_REVIEW,EDITED_VALIDATION_STALE,VALIDATION_FAILED,GENERATED,VALIDATION_PENDING`,
);
const listBody = await listResp.json();
const mine = (listBody.rows ?? []).filter((d) => d.courseVersionId === VERSION_ID);

const report = [];
for (const d of mine) {
  const detailResp = await p.request.get(`${BASE}/api/admin/ai-training/drafts/${d.draftId}`);
  if (!detailResp.ok()) { report.push({ id: d.draftId, step: "fetch-detail", status: detailResp.status() }); continue; }
  const detail = await detailResp.json();
  const body = detail.draft ?? {};
  const origText = String(body.questionText ?? "");
  const origOpts = Array.isArray(body.options) ? body.options : [];
  const { questionText: cleanText, options: cleanOpts } = normaliseQuestion(origText, origOpts);
  if (cleanText === origText && cleanOpts.every((o, i) => o.text === (origOpts[i]?.text ?? ""))) {
    report.push({ id: d.draftId, step: "noop", reason: "already clean" });
    continue;
  }
  if (cleanText.length < 15) {
    report.push({ id: d.draftId, step: "flagged-manual", reason: "cleaned stem too short", before: origText.slice(0, 80) });
    continue;
  }
  const correctCount = cleanOpts.reduce((n, o) => n + (o.isCorrect ? 1 : 0), 0);
  if (correctCount !== 1) {
    report.push({ id: d.draftId, step: "flagged-manual", reason: `correct-count=${correctCount}`, before: origText.slice(0, 80) });
    continue;
  }
  const editResp = await p.request.post(
    `${BASE}/api/admin/ai-training/drafts/${d.draftId}/edit`,
    {
      headers: { "Content-Type": "application/json" },
      data: {
        questionText: cleanText,
        options: cleanOpts,
        explanation: "",
        expectedContentHash: detail.contentHash,
        expectedRecordVersion: detail.recordVersion,
        reviewerNote: "EP-TRAIN-4Y-AE §5 — deterministic normalisation of embedded options / markdown headers.",
      },
    },
  );
  const editBody = await editResp.json().catch(() => ({}));
  if (!editResp.ok() || editBody.ok !== true) {
    report.push({ id: d.draftId, step: "edit", status: editResp.status(), error: editBody?.error, message: editBody?.message });
    continue;
  }
  report.push({
    id: d.draftId,
    step: "cleaned",
    newDraftId: editBody.newDraftId,
    beforeText: origText.slice(0, 120),
    afterText: cleanText.slice(0, 120),
    beforeOptionCount: origOpts.length,
    afterOptionCount: cleanOpts.length,
  });
}

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yae-pilot-repair.json", JSON.stringify(report, null, 2));
console.log("\n━━━━━━ 4Y-AE PILOT REPAIR SUMMARY ━━━━━━");
let cleaned = 0, flagged = 0, failed = 0, noop = 0;
for (const r of report) {
  const mark = r.step === "cleaned" ? "✓" : r.step === "flagged-manual" ? "⚠" : r.step === "noop" ? "·" : "✗";
  console.log(` ${mark} ${r.id} ${r.step}${r.newDraftId ? " → " + r.newDraftId : ""}`);
  if (r.beforeText) console.log(`     before: ${r.beforeText}…`);
  if (r.afterText) console.log(`     after:  ${r.afterText}…`);
  if (r.reason) console.log(`     reason: ${r.reason}`);
  if (r.step === "cleaned") cleaned++;
  else if (r.step === "flagged-manual") flagged++;
  else if (r.step === "noop") noop++;
  else failed++;
}
console.log(`\n cleaned: ${cleaned}  flagged: ${flagged}  noop: ${noop}  failed: ${failed}`);
await b.close();
if (failed > 0) process.exit(1);
