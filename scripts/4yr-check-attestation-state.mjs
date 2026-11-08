// Read-only diagnostic for the 4Y-R acceptance walk. Checks how
// many of the 13 cited segments of draft cmw823ncy00bnuakp41hglrrn
// actually have reviewerAttestedAt populated, and reports the
// latest validation's stage + reason.
import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
const p = new PrismaClient();
const DRAFT_ID = "cmw823ncy00bnuakp41hglrrn";
try {
  const draft = await p.trainingQuestionAiDraft.findUnique({
    where: { id: DRAFT_ID },
  });
  if (!draft) {
    console.log("DRAFT_NOT_FOUND");
    process.exit(0);
  }
  // The cited-segment list lives somewhere on the draft; try common shapes.
  let draftBody = {};
  try { draftBody = JSON.parse(draft.draftJson || "{}"); } catch {}
  const segIds = draft.citedSegmentIds
    ?? draftBody.citedSegmentIds
    ?? draftBody.citedTranscriptSegmentIds
    ?? draftBody.evidence?.citedSegmentIds
    ?? [];
  const segs = await p.trainingTranscriptSegment.findMany({
    where: { id: { in: segIds } },
    select: {
      id: true,
      reviewerAttestedAt: true,
      reviewerAttestedByUserId: true,
    },
  });
  const attested = segs.filter((s) => !!s.reviewerAttestedAt).length;
  const unattested = segs.filter((s) => !s.reviewerAttestedAt);
  const latestVal = await p.trainingQuestionAiValidation.findFirst({
    where: { draftId: DRAFT_ID },
    orderBy: { createdAt: "desc" },
    select: { id: true, verdict: true, stage: true, errorsJson: true, createdAt: true },
  });
  console.log(JSON.stringify({
    draftId: draft.id,
    state: draft.state,
    citedSegmentCount: segIds.length,
    foundSegments: segs.length,
    attestedCount: attested,
    unattestedCount: unattested.length,
    unattestedIds: unattested.map((s) => s.id).slice(0, 3),
    latestValidation: latestVal,
  }, null, 2));
} finally {
  await p.$disconnect();
}
