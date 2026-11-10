#!/usr/bin/env node
// EP-TRAIN-4Y-AE §5 — inspect the 5 current pilot drafts' body shape.
// Read-only. Writes a report to test-results/4yae-pilot-drafts.json.

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
console.log("drafts for version:", mine.length);

const details = [];
for (const d of mine) {
  const r = await p.request.get(`${BASE}/api/admin/ai-training/drafts/${d.draftId}`);
  if (!r.ok()) { details.push({ id: d.draftId, error: r.status() }); continue; }
  const body = await r.json();
  const q = body.draft ?? {};
  // Heuristic flags
  const text = String(q.questionText ?? "");
  const optionBodies = (q.options ?? []).map((o) => o.text ?? "");
  const embeddedOptionLineRx = /\n[\s*_-]*[A-Da-d][)\]\.:]\s+\S/;
  const optionBodyAppearsInStem = optionBodies.some((ot) => ot.length > 10 && text.includes(ot));
  const transcriptRefRx = /\baccording to (?:the )?(?:transcript|evidence window|training material)|segments?\s*\[[\d, ]+\]|segment\s+\d+/i;
  const correctAnswerKeyRx = /\*{0,2}\s*correct\s+answer\s*:/i;
  const unresolvedPlaceholderRx = /\[(?!\s*\d)[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*){0,2}\]/;
  details.push({
    id: d.draftId,
    state: d.state,
    contentHash: body.contentHash,
    recordVersion: body.recordVersion,
    verdict: d.latestVerdict,
    hardErrors: d.latestHardErrorCount,
    questionText: text,
    optionCount: optionBodies.length,
    options: optionBodies,
    flags: {
      embeddedOptionLinesInStem: embeddedOptionLineRx.test(text),
      optionBodyAppearsInStem,
      transcriptReferenceInStem: transcriptRefRx.test(text),
      correctAnswerKeyInStem: correctAnswerKeyRx.test(text),
      unresolvedPlaceholderInStem: unresolvedPlaceholderRx.test(text),
      stemLongerThan160Chars: text.length > 160,
    },
  });
}
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yae-pilot-drafts.json", JSON.stringify(details, null, 2));
console.log("\n━━━━━━ PILOT DRAFT SURVEY ━━━━━━");
for (const d of details) {
  console.log(`\n${d.id} state=${d.state} verdict=${d.verdict} flags=${JSON.stringify(d.flags)}`);
  console.log(`  Q: ${d.questionText.slice(0, 200)}${d.questionText.length > 200 ? "…" : ""}`);
  d.options.slice(0, 4).forEach((o, i) => console.log(`  ${String.fromCharCode(65+i)}) ${o.slice(0, 80)}`));
}
await b.close();
