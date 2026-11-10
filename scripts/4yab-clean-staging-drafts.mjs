#!/usr/bin/env node
// EP-TRAIN-4Y-AB §3 (2026-11-10) — one-shot cleanup of the 5 live
// staging checkpoint drafts whose questionText / options contain
// internal pipeline terminology ("according to the transcript",
// "Segment IDs: [...]", "**Correct Answer:** C", "[Last Name]").
//
// Mechanism: calls POST /api/admin/ai-training/drafts/[id]/edit per
// draft with a manager-sanitised body. No raw Prisma mutation, no
// GPU inference, no re-transcription. The edit endpoint enforces:
//   - hr:training:ai:edit grant (CLUB_ADMIN now holds this)
//   - sanitiser re-check on the new body
//   - lifecycle transition parent → ARCHIVED, new row → EDITED_VALIDATION_STALE
//   - audit log + state-transition row
//
// After the script completes, a reviewer (TRAINING_AI_REVIEWER) must
// revalidate + approve the new drafts; this script does NOT invoke
// the approval path (SoD preserved per directive §4).
//
// Preserves: content meaning, option count, correct-answer selection,
// provenance (sourceSegmentIds carried by the edit-service from the
// parent draftJson), audit trail.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
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
const EMAIL = env("SPECTRE_STAGING_EMAIL");
const PW = env("SPECTRE_STAGING_PASSWORD");
if (!EMAIL || !PW) { console.error("SPECTRE_STAGING_EMAIL/PASSWORD required"); process.exit(2); }

/**
 * Deterministic text-cleanup rules. Preserves substance — strips only
 * the internal pipeline terminology the EP-TRAIN-4Y-AA sanitiser
 * flags. Each rule is a {match, replace} pair applied in order.
 */
const CLEANUPS = [
  // "… according to the transcript segments [15] and [18]?" — drop
  // the "according to …" trailing clause entirely (preserves the
  // leading question).
  { match: /,?\s*according to the transcript(?:\s*segments?\s*\[[\d,\s]+\](?:\s+and\s+\[[\d,\s]+\])*)?(?=[?.])/gi, replace: "" },
  // "According to the transcript, …" at sentence start → remove the
  // preamble, uppercase the next word.
  {
    match: /^(?:[*_]{0,2})According to the transcript,?\s+/i,
    replace: "",
  },
  { match: /,?\s*according to (?:the )?evidence window(?:\s*content)?(?=[?.])/gi, replace: "" },
  { match: /,?\s*according to (?:the )?training materials?(?:\s+provided so far)?(?=[?.])/gi, replace: "" },
  // Standalone "Segment IDs: [N, N]" line — remove entirely.
  { match: /\n*\*?\s*Segment\s*IDs?\s*:\s*\[[\d,\s]+\]\s*\*?\s*/gi, replace: "" },
  // Embedded "**Correct Answer:** C" lines — remove entirely (the
  // correct option already lives in the options array).
  { match: /\n*\*{0,2}\s*Correct\s+Answer\s*\*{0,2}\s*:\s*[A-D]\s*\n*/gi, replace: "\n" },
  // Embedded markdown option headers like "**A)**" — strip the ** and
  // the "A)" etc. Kept the option body itself.
  { match: /\*{1,2}([A-D])\)\*{1,2}\s*/g, replace: "" },
  // Leftover "… that could be improved, what is the best course of
  // action?" after we dropped "according to the training material" —
  // these questions remain grammatical, just slightly tighter.
];

/**
 * Replace unresolved template placeholders in OPTION text with safe
 * substitutes. Preserves meaning without inventing specifics.
 */
const PLACEHOLDER_REPLACEMENTS = [
  { match: /\[Last\s*Name\]/gi, replace: "surname" },
  { match: /\[First\s*Name\]/gi, replace: "given name" },
  { match: /\[Member\s*Name\]/gi, replace: "member's name" },
  { match: /\[Member\s*Number\]/gi, replace: "member number" },
];

function cleanText(text) {
  let out = String(text ?? "");
  for (const { match, replace } of CLEANUPS) out = out.replace(match, replace);
  for (const { match, replace } of PLACEHOLDER_REPLACEMENTS) out = out.replace(match, replace);
  // Collapse whitespace + trim.
  out = out.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  // If the leading character is lowercase after preamble removal,
  // uppercase it. "what is the correct way..." → "What is the correct way..."
  if (/^[a-z]/.test(out)) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const page = await ctx.newPage();
  console.log("→ login");
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PW);
  await Promise.all([page.waitForURL(/\/app\//, { timeout: 30_000 }), page.click('button[type="submit"]')]);

  // List all drafts for this version.
  const listResp = await page.request.get(
    `${BASE}/api/admin/ai-training/drafts?limit=50&states=REQUIRES_HUMAN_REVIEW,EDITED_VALIDATION_STALE,VALIDATION_FAILED,GENERATED,VALIDATION_PENDING`,
  );
  const listBody = await listResp.json();
  const mine = (listBody.rows ?? []).filter((d) => d.courseVersionId === VERSION_ID);
  console.log(`→ ${mine.length} drafts for this version`);

  const results = [];
  for (const row of mine) {
    const id = row.draftId;
    try {
      const detailResp = await page.request.get(`${BASE}/api/admin/ai-training/drafts/${id}`);
      if (!detailResp.ok()) {
        results.push({ id, step: "detail", status: detailResp.status(), skipped: true });
        continue;
      }
      const detail = await detailResp.json();
      const body = detail.draft ?? {};
      const origText = String(body.questionText ?? "");
      const origOptions = Array.isArray(body.options) ? body.options : [];
      const cleanedText = cleanText(origText);
      const cleanedOptions = origOptions.map((o) => ({
        text: cleanText(o.text ?? ""),
        isCorrect: !!o.isCorrect,
      }));
      // Sanity checks: (a) the question still has substance after
      // cleanup; (b) exactly one correct option remains.
      if (cleanedText.length < 15) {
        results.push({ id, step: "cleanup", flaggedForManualReview: true, reason: "cleaned text too short", originalFirst60: origText.slice(0, 60) });
        continue;
      }
      const correctCount = cleanedOptions.reduce((n, o) => n + (o.isCorrect ? 1 : 0), 0);
      if (correctCount !== 1) {
        results.push({ id, step: "cleanup", flaggedForManualReview: true, reason: `correct-count=${correctCount}`, originalFirst60: origText.slice(0, 60) });
        continue;
      }
      // No-op? If the cleaner made no substantive change, don't call
      // /edit (it would 409 EDIT_DUPLICATE_OF_PARENT). This matches
      // the directive: "If safe cleanup is impossible, flag the
      // question for manual review" — the sanitiser's approval-side
      // gate will still refuse this draft at approve-time.
      const changed = cleanedText !== origText || cleanedOptions.some((o, i) => o.text !== (origOptions[i]?.text ?? ""));
      if (!changed) {
        results.push({ id, step: "cleanup", skipped: true, reason: "no change needed" });
        continue;
      }
      const editResp = await page.request.post(
        `${BASE}/api/admin/ai-training/drafts/${id}/edit`,
        {
          headers: { "Content-Type": "application/json" },
          data: {
            questionText: cleanedText,
            options: cleanedOptions,
            explanation: "",
            expectedContentHash: detail.contentHash,
            expectedRecordVersion: detail.recordVersion,
            reviewerNote: "EP-TRAIN-4Y-AB §3 — automatic cleanup of internal pipeline terminology.",
          },
        },
      );
      const editBody = await editResp.json().catch(() => ({}));
      if (!editResp.ok()) {
        results.push({ id, step: "edit", status: editResp.status(), error: editBody?.error ?? "?", message: editBody?.message ?? "" });
        continue;
      }
      results.push({ id, step: "edit", ok: true, newDraftId: editBody.newDraftId, supersedes: editBody.supersedesDraftId, textBefore: origText.slice(0, 80), textAfter: cleanedText.slice(0, 80) });
    } catch (err) {
      results.push({ id, step: "exception", error: (err && err.message) || String(err) });
    }
  }

  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync("test-results/4yab-cleanup-report.json", JSON.stringify(results, null, 2));
  console.log("\n━━━━━━━━━━━━━ 4Y-AB CLEANUP SUMMARY ━━━━━━━━━━━━━");
  let okCount = 0, flagged = 0, failed = 0;
  for (const r of results) {
    const marker = r.ok ? "✓" : r.flaggedForManualReview ? "⚠ flagged" : r.skipped ? "·" : "✗";
    console.log(`  ${marker} ${r.id} ${r.step}${r.newDraftId ? ` → ${r.newDraftId}` : ""}`);
    if (r.textBefore && r.textAfter) {
      console.log(`      before: ${r.textBefore}`);
      console.log(`      after:  ${r.textAfter}`);
    }
    if (r.ok) okCount++;
    else if (r.flaggedForManualReview) flagged++;
    else if (!r.skipped) failed++;
  }
  console.log(`\n  cleaned: ${okCount}  flagged: ${flagged}  failed: ${failed}  skipped: ${results.length - okCount - flagged - failed}`);
  console.log(`  report:  test-results/4yab-cleanup-report.json`);
  await browser.close();
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
