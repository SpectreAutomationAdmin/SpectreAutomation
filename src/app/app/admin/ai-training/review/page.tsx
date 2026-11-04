// EP-TRAIN-6D-1 — fixture-driven AI-training review page.
//
// This page is intentionally OFFLINE: it imports fixture data and the
// authoritative validator, computes results on the fly, and renders a
// manager-facing review experience. There is no Prisma access, no
// cross-tenant exposure, and no connection to live generation.
//
// Auth gate preserved: the page lives under /app/admin/* which the
// existing middleware protects. The fixture mode is isolated from
// production training content by construction — fixtures reference
// only the Coulee Ridge development tenant.

import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import ReviewWorkspace from "@/components/ai-training/ReviewWorkspace";
// EP-TRAIN-6D-4F — pre-compute each fixture's validation on the server
// so the client bundle never pulls in the Node-only `node:crypto`
// dependency that the validator chain uses for content-hashing.
import { validateTrainingQuestion, type PipelineResult } from "@/lib/training/ai-generation";
import { FIXTURES } from "@/components/ai-training/fixtures";

export const metadata = {
  title: "AI-assisted training · manager review",
};

export default async function AiTrainingReviewPage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  // Compute every fixture's validation once per request on the server.
  // `validateTrainingQuestion` reaches `node:crypto` which cannot be
  // bundled for client components.
  const initialValidations: Record<string, PipelineResult> = {};
  for (const f of FIXTURES) {
    initialValidations[f.label] = validateTrainingQuestion({
      draft: f.draft,
      grounding: f.grounding,
      authorization: f.authorization,
    });
  }

  return <ReviewWorkspace initialValidations={initialValidations} />;
}
