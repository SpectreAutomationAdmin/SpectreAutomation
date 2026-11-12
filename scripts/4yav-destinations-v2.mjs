#!/usr/bin/env node
// EP-TRAIN-4Y-AV — v2: faithful port of parseShortfallGroupMap +
// composeGroupMapsFromRuns + destinationKindForGroup + supersedes walk.

import fs from "node:fs";

const inv  = JSON.parse(fs.readFileSync("test-results/4yav-inventory.json","utf8"));
const inv2 = JSON.parse(fs.readFileSync("test-results/4yav-inventory-v2.json","utf8"));

function parseShortfallGroupMap(json) {
  const map = new Map();
  if (!json) return map;
  let parsed;
  try { parsed = JSON.parse(json); } catch { return map; }
  const decisions = parsed?.dedupDecisions;
  if (Array.isArray(decisions)) {
    for (const row of decisions) {
      if (row?.kept !== true) continue;
      if (typeof row.group !== "string") continue;
      if (typeof row.candidateContentHash !== "string") continue;
      if (!map.has(row.candidateContentHash)) map.set(row.candidateContentHash, row.group);
    }
  }
  const diag = parsed?.perGroupDiagnostics;
  if (Array.isArray(diag)) {
    for (const g of diag) {
      if (typeof g?.group !== "string") continue;
      if (!Array.isArray(g.recoveryHistory)) continue;
      for (const rh of g.recoveryHistory) {
        if (typeof rh?.contentHash !== "string") continue;
        if (typeof rh?.savedAsDraftId !== "string") continue;
        if (!map.has(rh.contentHash)) map.set(rh.contentHash, g.group);
      }
    }
  }
  return map;
}
function destinationKindForGroup(g) {
  if (!g) return "UNKNOWN";
  if (g === "final") return "FINAL_ASSESSMENT";
  if (/^fa-\d+$/.test(g)) return "FINAL_ASSESSMENT";
  return "CHECKPOINT";
}
function composeGroupMapsFromRuns(reasons) {
  const composed = new Map();
  for (const j of reasons) {
    const m = parseShortfallGroupMap(j);
    for (const [h, g] of m) if (!composed.has(h)) composed.set(h, g);
  }
  return composed;
}

const terminalRuns = inv.runs.filter((r) => ["COMPLETED","FAILED"].includes(r.executionStatus));
const groupMap = composeGroupMapsFromRuns(terminalRuns.map((r) => r.shortfallReasonJson));
console.log("group map size:", groupMap.size);

// atSec from assessmentPlanJson
const groupAtSec = new Map();
for (const r of terminalRuns) {
  if (!r.assessmentPlanJson) continue;
  try {
    const plan = JSON.parse(r.assessmentPlanJson);
    for (const g of plan.proposedCheckpointGroups ?? []) {
      if (typeof g?.id === "string" && typeof g?.atSec === "number") {
        if (!groupAtSec.has(g.id)) groupAtSec.set(g.id, g.atSec);
      }
    }
  } catch {}
}

// All drafts for ancestry walk
const allById = new Map(inv.drafts.map((x) => [x.id, x]));

const resolved = [];
for (const d of inv2.live) {
  const body = JSON.parse(d.draftJson || "{}");
  // Primary: own contentHash
  let group = groupMap.get(d.contentHash) ?? null;
  // Supersedes walk up to 5 levels if not resolved
  if (!group && d.supersedesDraftId) {
    let cursor = d.supersedesDraftId;
    for (let depth = 0; depth < 5 && cursor; depth++) {
      const anc = allById.get(cursor);
      if (!anc) break;
      const g = groupMap.get(anc.contentHash);
      if (g) { group = g; break; }
      cursor = anc.supersedesDraftId;
    }
  }
  const dest = destinationKindForGroup(group);
  const atSec = group ? (groupAtSec.get(group) ?? null) : null;
  resolved.push({
    id: d.id, state: d.state, hash12: d.contentHash.slice(0, 12),
    generationRunId: d.generationRunId, supersedesDraftId: d.supersedesDraftId,
    group, destination: dest, atSec,
    questionText: body.questionText, options: body.options,
    sourceSegmentIds: body.sourceSegmentIds, explanation: body.explanation,
  });
}

resolved.sort((a, b) => {
  if (a.destination !== b.destination) {
    if (a.destination === "CHECKPOINT") return -1;
    if (b.destination === "CHECKPOINT") return 1;
  }
  if (a.atSec != null && b.atSec != null && a.atSec !== b.atSec) return a.atSec - b.atSec;
  if (a.atSec != null) return -1;
  if (b.atSec != null) return 1;
  return a.hash12.localeCompare(b.hash12);
});

console.log("== Resolved destinations ==");
for (const r of resolved) {
  console.log(r.destination.padEnd(16), (r.group||"?").padEnd(8), "atSec="+(r.atSec??"?").toString().padStart(5), r.hash12, r.state.padEnd(24), String(r.questionText).slice(0,80));
}
const cpCount = resolved.filter((r)=>r.destination==="CHECKPOINT").length;
const faCount = resolved.filter((r)=>r.destination==="FINAL_ASSESSMENT").length;
const unkCount = resolved.filter((r)=>r.destination==="UNKNOWN").length;
console.log("\nCP:", cpCount, "FA:", faCount, "UNKNOWN:", unkCount);

fs.writeFileSync("test-results/4yav-resolved.json", JSON.stringify({ groupMap: [...groupMap.entries()], groupAtSec: [...groupAtSec.entries()], resolved }, null, 2));
console.log("wrote test-results/4yav-resolved.json");
