// Count sourceSegmentIds length per 4Y-N draft to find one with 1..5.
import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
const p = new PrismaClient();
try {
  const drafts = await p.trainingQuestionAiDraft.findMany({
    where: { clubId: "cmrvdeny7000144372ktmmg9c" },
    select: { id: true, state: true, draftJson: true, generationRunId: true },
    take: 100,
  });
  const result = drafts.map((d) => {
    let ssi = null;
    try {
      const body = JSON.parse(d.draftJson || "{}");
      ssi = Array.isArray(body.sourceSegmentIds) ? body.sourceSegmentIds.length : "missing";
    } catch { ssi = "parse-err"; }
    return { id: d.id, state: d.state, runId: d.generationRunId, ssi };
  });
  const byLen = {};
  for (const r of result) {
    const k = String(r.ssi);
    byLen[k] = (byLen[k] || 0) + 1;
  }
  console.log("count_by_sourceSegmentIds_length:", JSON.stringify(byLen));
  const eligible = result.filter((r) => typeof r.ssi === "number" && r.ssi >= 1 && r.ssi <= 5);
  console.log("eligible_draft_count:", eligible.length);
  console.log("first_5_eligible:", JSON.stringify(eligible.slice(0, 5), null, 2));
} finally {
  await p.$disconnect();
}
