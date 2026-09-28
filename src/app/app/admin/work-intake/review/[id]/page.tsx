// WI-2A (2026-09-27) — Work Intake review page (visual scaffold).
// WI-2B (2026-09-27) — routing contract now real.
// WI-2B.1 (2026-09-27) — canonical identity fix + real AP data bridge.
//
// Routing contract:
//   - Scaffold slug "row-1" → the WI-2A Fairway fixture (kept for
//     the WI-1/WI-2A acceptance suites only). NEVER served for any
//     other id.
//   - Every other slug → validated as a canonical
//     WorkIntakeItem.id via loadWorkIntakeDetail (auth + tenant +
//     personal-mailbox visibility). A miss → notFound(). The real
//     detail is adapted through review-detail-view-model into
//     RealReviewData and rendered by WorkIntakeReviewReal, which
//     reuses the accepted .wi-review-* CSS but never emits any
//     Fairway fixture value (§12).
//
// Mutation actions (Approve & Start, Send back) remain disabled on
// the real-data page per §17.

import { redirect, notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { prisma } from "@/lib/prisma";
import { loadWorkIntakeDetail } from "@/lib/work-intake/detail-reader";
import { loadLinkedIntelligenceForEmailIntakes } from "@/lib/mission-control/intelligence-review-intakes";
import { toRealReviewData } from "@/lib/work-intake/review-detail-view-model";
import WorkIntakeReviewScaffold from "@/components/work-intake/review/WorkIntakeReviewScaffold";
import WorkIntakeReviewReal from "@/components/work-intake/review/WorkIntakeReviewReal";
import { REVIEW_WORK_ITEM } from "@/components/work-intake/review/review-scaffold-data";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review · Work Intake" };

/** Scaffold-only slug preserved for the WI-1/WI-2A acceptance tests.
 *  Every other slug is treated as a real WorkIntakeItem id and NEVER
 *  renders the Fairway fixture (§12). */
const SCAFFOLD_ONLY_SLUG = "row-1";

export default async function WorkIntakeReviewPage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId(user);

  const rawId = params.id ?? "";
  const intakeId = decodeURIComponent(rawId).trim();

  if (intakeId === SCAFFOLD_ONLY_SLUG) {
    return <WorkIntakeReviewScaffold item={REVIEW_WORK_ITEM} />;
  }

  // WI-2B.1 — canonical id path. Every visibility check runs INSIDE
  // loadWorkIntakeDetail; a miss (cross-tenant / unknown / personal
  // mailbox owned by another user) returns null → notFound(). We
  // never leak the reason to the client.
  const detail = await loadWorkIntakeDetail({ principal, clubId, intakeId });
  if (!detail) notFound();

  // Pull AP intelligence for email-derived items — this is the same
  // projection Mission Control feeds into its AP invoice card.
  const linkedMap = await loadLinkedIntelligenceForEmailIntakes({
    clubId,
    emailIntakeIds: [detail.id],
  });
  const linked = linkedMap.get(detail.id);

  const clubRow = await prisma.club.findUnique({
    where: { id: clubId },
    select: { timezone: true },
  });
  const clubTimezone = clubRow?.timezone || "UTC";

  const realData = toRealReviewData({
    detail,
    linked,
    clubTimezone,
  });

  return <WorkIntakeReviewReal data={realData} />;
}
