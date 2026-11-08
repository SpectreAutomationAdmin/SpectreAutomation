// Directly hit /revalidate on the previously-approved draft to
// trigger the slice-4 draft-scalar-sync. State remains APPROVED_DRAFT
// (revalidate writes a new validation row + updates the scalar; it
// doesn't change draft state). Then attempt promote.
//
// Runs in staging via flyctl ssh using the reviewer session cookie
// from /tmp (captured via a one-shot login with bcrypt-compare).
import { PrismaClient } from "/app/node_modules/@prisma/client/default.js";
import { revalidateDraft } from "/app/dist/lib/hr/training/ai-review/projection-and-validation-persistence.js";

const DRAFT_ID = "cmw7zjm38007pcnz1s7wrlrvp";
const p = new PrismaClient();
try {
  const before = await p.trainingQuestionAiDraft.findUnique({
    where: { id: DRAFT_ID },
    select: { groundingProjectionSha256: true, groundingProjectionId: true, state: true },
  });
  console.log("BEFORE:", JSON.stringify(before));
  const r = await revalidateDraft({ draftId: DRAFT_ID });
  console.log("REVALIDATE:", JSON.stringify(r));
  const after = await p.trainingQuestionAiDraft.findUnique({
    where: { id: DRAFT_ID },
    select: { groundingProjectionSha256: true, groundingProjectionId: true, state: true },
  });
  console.log("AFTER:", JSON.stringify(after));
  const projection = await p.trainingGroundingProjection.findUnique({
    where: { id: r.projectionRowId },
    select: { sha256: true },
  });
  console.log("PROJECTION_SHA:", projection.sha256);
  console.log("ALIGNED:", after.groundingProjectionSha256 === projection.sha256);
} finally {
  await p.$disconnect();
}
