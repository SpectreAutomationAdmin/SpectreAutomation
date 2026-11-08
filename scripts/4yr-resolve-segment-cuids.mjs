// Resolve TrainingTranscriptSegment CUIDs for a given set of
// numeric sourceSegmentIds against the version's resolved transcript.
import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
const p = new PrismaClient();
const DRAFT_ID = "cmw7zjm38007pcnz1s7wrlrvp";
const VERSION_ID = "cmvzs3w05000456qcgfgps7gy";
try {
  const draft = await p.trainingQuestionAiDraft.findUnique({ where: { id: DRAFT_ID } });
  const body = JSON.parse(draft.draftJson || "{}");
  const ssi = body.sourceSegmentIds ?? [];
  console.log("draft_sourceSegmentIds:", ssi);
  // The version has a resolved TrainingTranscriptBuild whose
  // transcript segments carry an ordinal index. Enumerate.
  const version = await p.trainingCourseVersion.findUnique({ where: { id: VERSION_ID } });
  console.log("version_videoSha256:", version.videoSha256);
  // Find the most recent transcript build for this video
  const build = await p.trainingTranscriptBuild.findFirst({
    where: { sourceVideoSha256: version.videoSha256 },
    orderBy: { producedAt: "desc" },
  });
  console.log("buildId:", build.id);
  const segs = await p.trainingTranscriptSegment.findMany({
    where: { transcriptBuildId: build.id },
    orderBy: { segmentIndex: "asc" },
  });
  console.log("total_segments:", segs.length);
  const matched = segs.filter((s) => ssi.includes(s.segmentIndex));
  console.log("matched_segments:", JSON.stringify(matched.map((s) => ({
    id: s.id,
    segmentIndex: s.segmentIndex,
    textPreview: s.textContent?.slice(0, 60),
    alreadyAttested: !!s.reviewerAttestedAt,
  })), null, 2));
} finally {
  await p.$disconnect();
}
