// EP-TRAIN-4Y-U §8 diagnostic: call the deterministic metadata
// generator against the founder-reported course's transcript to
// verify the path WOULD have populated metadata if invoked.
// Read-only — never writes.
import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
import {
  generateCourseMetadataDeterministic,
} from "/app/dist/lib/hr/training/ai-metadata/course-metadata-generator.js";

const CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const VIDEO_SHA = "d1ddb823437c78478c5f2388b5daa42c957a8706afcce871bd6a522801efee29";
const p = new PrismaClient();
try {
  const build = await p.trainingTranscriptBuild.findFirst({
    where: { clubId: CLUB_ID, sourceVideoSha256: VIDEO_SHA },
    orderBy: { producedAt: "desc" },
  });
  console.log("buildId:", build?.id);
  const segs = await p.trainingTranscriptSegment.findMany({
    where: { transcriptBuildId: build.id, clubId: CLUB_ID },
    orderBy: { segmentIndex: "asc" },
    select: { segmentIndex: true, text: true, pendingReviewJson: true },
  });
  const usable = segs.filter((s) => {
    try {
      const x = JSON.parse(s.pendingReviewJson ?? "[]");
      return !Array.isArray(x) || x.length === 0;
    } catch {
      return true;
    }
  });
  console.log(`total_segments=${segs.length} usable_after_filter=${usable.length}`);
  const r = generateCourseMetadataDeterministic({
    segments: usable.map((s) => ({ segmentIndex: s.segmentIndex, text: s.text })),
  });
  console.log("metadata:", JSON.stringify({
    title: r.title,
    descriptionFirst120: r.description.slice(0, 120),
    code: r.code,
    inferenceSource: r.inferenceSource,
  }, null, 2));
} finally {
  await p.$disconnect();
}
