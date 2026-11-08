// Find an eligible REQUIRES_HUMAN_REVIEW draft (ssi 1-5), not yet
// approved, and resolve its cited transcript-segment CUIDs so the
// Playwright spec can walk the full chain end-to-end on it.
import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
const p = new PrismaClient();
const CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const VERSION_ID = "cmvzs3w05000456qcgfgps7gy";
try {
  const drafts = await p.trainingQuestionAiDraft.findMany({
    where: { clubId: CLUB_ID, courseVersionId: VERSION_ID, state: "REQUIRES_HUMAN_REVIEW" },
    take: 200,
  });
  const version = await p.trainingCourseVersion.findUnique({ where: { id: VERSION_ID } });
  const build = await p.trainingTranscriptBuild.findFirst({
    where: { sourceVideoSha256: version.videoSha256 },
    orderBy: { producedAt: "desc" },
  });
  const segs = await p.trainingTranscriptSegment.findMany({
    where: { transcriptBuildId: build.id },
    orderBy: { segmentIndex: "asc" },
  });
  const byIndex = new Map(segs.map((s) => [s.segmentIndex, s]));
  for (const d of drafts) {
    try {
      const body = JSON.parse(d.draftJson || "{}");
      const ssi = Array.isArray(body.sourceSegmentIds) ? body.sourceSegmentIds : [];
      if (ssi.length < 1 || ssi.length > 5) continue;
      const cuids = ssi.map((i) => byIndex.get(i)?.id).filter(Boolean);
      if (cuids.length !== ssi.length) continue;
      const attestedAll = ssi.every((i) => !!byIndex.get(i)?.reviewerAttestedAt);
      console.log(JSON.stringify({
        draftId: d.id,
        state: d.state,
        ssiCount: ssi.length,
        ssiIndices: ssi,
        segmentCuids: cuids,
        attestedAlready: attestedAll,
      }));
      if (!attestedAll) break; // first unattested eligible draft wins
    } catch {}
  }
} finally {
  await p.$disconnect();
}
