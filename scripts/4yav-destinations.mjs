#!/usr/bin/env node
// EP-TRAIN-4Y-AV §1 — resolve destination for every live draft using
// the composed group map (same logic as the review page).

import fs from "node:fs";

const inv = JSON.parse(fs.readFileSync("test-results/4yav-inventory.json","utf8"));
const inv2 = JSON.parse(fs.readFileSync("test-results/4yav-inventory-v2.json","utf8"));

// Compose contentHash → group across every run's shortfallReasonJson,
// mirroring composeGroupMapsFromRuns + annotateDraftsWithComposedDestination.
function composeGroupMapsFromRuns(reasons) {
  const map = new Map();
  for (const raw of reasons) {
    if (!raw) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    // Walk proposedGroupMap[].items[] if present — not expected in our shape;
    // and perGroupDiagnostics[].recoveryHistory[] which is the AR/AS shape.
    const groups = parsed.perGroupDiagnostics;
    if (Array.isArray(groups)) {
      for (const g of groups) {
        const groupKey = g.group ?? g.groupKey;
        if (!groupKey) continue;
        const history = Array.isArray(g.recoveryHistory) ? g.recoveryHistory : [];
        for (const h of history) {
          if (h && typeof h.contentHash === "string" && !map.has(h.contentHash)) {
            map.set(h.contentHash, groupKey);
          }
        }
        // Also note: perGroupDiagnostics may carry `membershipHashes` (the group's seed hashes)
        const seed = Array.isArray(g.membershipHashes) ? g.membershipHashes :
                     (Array.isArray(g.contentHashes) ? g.contentHashes : []);
        for (const h of seed) {
          if (typeof h === "string" && !map.has(h)) map.set(h, groupKey);
        }
      }
    }
    // Some older runs may carry a flat `hashToGroup` or `proposedGroupMap`.
    if (parsed.hashToGroup && typeof parsed.hashToGroup === "object") {
      for (const [h, g] of Object.entries(parsed.hashToGroup)) {
        if (typeof g === "string" && !map.has(h)) map.set(h, g);
      }
    }
    const pg = parsed.proposedGroupMap;
    if (Array.isArray(pg)) {
      for (const pair of pg) {
        if (pair && typeof pair.contentHash === "string" && typeof pair.group === "string") {
          if (!map.has(pair.contentHash)) map.set(pair.contentHash, pair.group);
        }
      }
    }
  }
  return map;
}
function destinationKindForGroup(g) {
  if (!g) return "UNKNOWN";
  if (g === "final" || g.startsWith("fa-")) return "FINAL_ASSESSMENT";
  if (g.startsWith("cg-") || g.startsWith("ck-")) return "CHECKPOINT";
  return "UNKNOWN";
}

const terminalRuns = inv.runs.filter((r) => ["COMPLETED","FAILED"].includes(r.executionStatus));
const groupMap = composeGroupMapsFromRuns(terminalRuns.map((r) => r.shortfallReasonJson));
console.log("group map size:", groupMap.size);

// Also parse assessmentPlanJson from each run to collect atSec per group.
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
console.log("group->atSec:", [...groupAtSec.entries()]);

const resolved = [];
for (const d of inv2.live) {
  const body = JSON.parse(d.draftJson || "{}");
  const group = groupMap.get(d.contentHash) ?? null;
  let dest = destinationKindForGroup(group);
  // Follow supersedes chain if dest is UNKNOWN (ancestor may carry it)
  if (dest === "UNKNOWN" && d.supersedesDraftId) {
    // Ancestor hashes: pull ancestry from the 27-draft inv dump
    const allById = new Map(inv.drafts.map((x) => [x.id, x]));
    let cursor = d.supersedesDraftId;
    for (let depth = 0; depth < 5 && cursor; depth++) {
      const anc = allById.get(cursor);
      if (!anc) break;
      const ancGroup = groupMap.get(anc.contentHash);
      const ancDest = destinationKindForGroup(ancGroup);
      if (ancDest !== "UNKNOWN") { dest = ancDest; break; }
      cursor = anc.supersedesDraftId;
    }
  }
  const atSec = group ? groupAtSec.get(group) ?? null : null;
  resolved.push({
    id: d.id,
    state: d.state,
    hash12: d.contentHash.slice(0, 12),
    generationRunId: d.generationRunId,
    supersedesDraftId: d.supersedesDraftId,
    group,
    destination: dest,
    atSec,
    questionText: body.questionText,
    options: body.options,
    sourceSegmentIds: body.sourceSegmentIds,
    explanation: body.explanation,
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

console.log("\n== Resolved destinations ==");
for (const r of resolved) {
  console.log(r.destination.padEnd(16), (r.group||"?").padEnd(8), "atSec="+(r.atSec??"?").toString().padStart(5), r.hash12, r.state.padEnd(24), String(r.questionText).slice(0,80));
}

fs.writeFileSync("test-results/4yav-resolved.json", JSON.stringify({ groupMap: [...groupMap.entries()], groupAtSec: [...groupAtSec.entries()], resolved }, null, 2));
console.log("\nwrote test-results/4yav-resolved.json");
