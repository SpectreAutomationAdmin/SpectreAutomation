// WI-2A (2026-09-27) — Work Intake review page.
//
// Visual scaffold only. Static fixture data; the review page's real
// wiring (extraction, vendor matching, GL suggestion, workflow
// transitions, Spectre AI) is deliberately deferred to WI-2B+.

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import WorkIntakeReviewScaffold from "@/components/work-intake/review/WorkIntakeReviewScaffold";
import { REVIEW_WORK_ITEM } from "@/components/work-intake/review/review-scaffold-data";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review · Capital Invoice" };

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default async function WorkIntakeReviewPage({ params: _params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // WI-2A — visual scaffold uses the fixed reference work-item for
  // every slug. WI-2B will fetch a real item by params.id.
  return <WorkIntakeReviewScaffold item={REVIEW_WORK_ITEM} />;
}
