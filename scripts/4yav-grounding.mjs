#!/usr/bin/env node
// EP-TRAIN-4Y-AV §2 — grounding join. For each of the 15 live
// questions, print the transcript text behind every cited segmentId.

import fs from "node:fs";

const inv2 = JSON.parse(fs.readFileSync("test-results/4yav-inventory-v2.json","utf8"));
const res = JSON.parse(fs.readFileSync("test-results/4yav-resolved.json","utf8"));

const segById = new Map();
for (const s of inv2.segments) {
  segById.set(s.segmentIndex, s);
}

const out = [];
for (const r of res.resolved) {
  const q = {
    id: r.id, hash12: r.hash12, state: r.state,
    destination: r.destination, group: r.group, atSec: r.atSec,
    questionText: r.questionText,
    correctChoice: null,
    options: [],
    explanation: r.explanation,
    citedSegments: [],
    uncitedButReferencedInQuestion: [],
  };
  for (let i = 0; i < (r.options?.length ?? 0); i++) {
    const o = r.options[i];
    q.options.push({ i, text: o.text, isCorrect: !!o.isCorrect });
    if (o.isCorrect) q.correctChoice = { index: i, text: o.text };
  }
  for (const sid of (r.sourceSegmentIds || [])) {
    const seg = segById.get(sid);
    q.citedSegments.push({
      segmentIndex: sid,
      startSec: seg ? Number(seg.startSec) : null,
      endSec: seg ? Number(seg.endSec) : null,
      text: seg ? seg.text : "(segment not found)",
      pendingReviewJson: seg?.pendingReviewJson ?? "[]",
      reviewerAttestedAt: seg?.reviewerAttestedAt ?? null,
    });
  }
  out.push(q);
}

// Human-readable dump
let md = `# EP-TRAIN-4Y-AV grounding dump\n\n`;
md += `Transcript build: ${inv2.transcriptBuild?.id} · ${inv2.segmentCount} segments\n\n`;
for (const q of out) {
  md += `\n---\n## ${q.hash12} · ${q.destination} / ${q.group} · ${q.state}\n\n`;
  md += `**Q:** ${q.questionText}\n\n`;
  for (const o of q.options) md += `- ${o.isCorrect ? "**[✓]**" : "[ ]"} ${o.text}\n`;
  md += `\n*Explanation:* ${q.explanation || "(empty)"}\n\n`;
  md += `*Cited segments:* [${q.citedSegments.map((s) => s.segmentIndex).join(", ")}]\n\n`;
  for (const s of q.citedSegments) {
    md += `  - **[${s.segmentIndex}]** (${s.startSec?.toFixed(1)}s–${s.endSec?.toFixed(1)}s): ${s.text}\n`;
  }
}
fs.writeFileSync("test-results/4yav-grounding.md", md);
fs.writeFileSync("test-results/4yav-grounding.json", JSON.stringify(out, null, 2));
console.log("wrote test-results/4yav-grounding.md +.json");

// Also dump a plain transcript (helpful for cross-assessment / coverage)
let tx = `# Transcript (${inv2.segmentCount} segments)\n\n`;
for (const s of inv2.segments) {
  tx += `[${s.segmentIndex}] (${Number(s.startSec).toFixed(1)}s–${Number(s.endSec).toFixed(1)}s): ${s.text}\n`;
}
fs.writeFileSync("test-results/4yav-transcript.md", tx);
console.log("wrote test-results/4yav-transcript.md");
