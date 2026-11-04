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

export const metadata = {
  title: "AI-assisted training · manager review",
};

export default async function AiTrainingReviewPage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  return <ReviewWorkspace />;
}
