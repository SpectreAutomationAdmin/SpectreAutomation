// Find a REQUIRES_HUMAN_REVIEW draft with ssi 1..5 whose cited
// segments have NOT been attested yet (fresh pilot for post-slice-9
// walk).
import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
const p = new PrismaClient();
const CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const VERSION_ID = "cmvzs3w05000456qcgfgps7gy";
const SKIP = new Set([
  "cmw7zjm38007pcnz1s7wrlrvp", // already approved
  "cmw7zjm49007rcnz13tb6cbgn", // already attested in 4Y-R spec run 1
  "cmw7zjm4v007tcnz1ypzti7il", // already attested, REJECTED at VALIDATE
]);
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
  });
  const byIndex = new Map(segs.map((s) => [s.segmentIndex, s]));
  for (const d of drafts) {
    if (SKIP.has(d.id)) continue;
    try {
      const body = JSON.parse(d.draftJson || "{}");
      const ssi = Array.isArray(body.sourceSegmentIds) ? body.sourceSegmentIds : [];
      if (ssi.length < 1 || ssi.length > 5) continue;
      const cuids = ssi.map((i) => byIndex.get(i)?.id).filter(Boolean);
      if (cuids.length !== ssi.length) continue;
      const attestedAny = ssi.some((i) => !!byIndex.get(i)?.reviewerAttestedAt);
      if (attestedAny) continue;
      console.log(JSON.stringify({
        draftId: d.id,
        ssiCount: ssi.length,
        ssiIndices: ssi,
        segmentCuids: cuids,
        questionTextPreview: body.questionText?.slice(0, 80),
      }));
      break;
    } catch {}
  }
} finally {
  await p.$disconnect();
}
