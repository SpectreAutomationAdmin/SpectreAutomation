// WI-2A (2026-09-27) — Work Intake review page (visual scaffold).
// WI-2B (2026-09-27) — routing contract now real.
//
// Per §13 + §35: the route must accept a real WorkIntakeItem id,
// authenticate the caller, and tenant-scope the record before
// rendering. The inner review UI (Invoice Details / Line Items /
// Context / Workflow / Spectre rail) intentionally remains
// fixture-backed for WI-2B — full field hydration is WI-2C's slice.
//
// The scaffold fixture slug "row-1" is preserved as a
// non-authenticated preview escape hatch used only by the WI-1/WI-2A
// acceptance suites. Every OTHER slug is treated as a real WI id and
// must pass loadWorkIntakeDetail's tenant + mailbox visibility
// checks; a miss falls through to Next.js notFound().

import { redirect, notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { loadWorkIntakeDetail } from "@/lib/work-intake/detail-reader";
import WorkIntakeReviewScaffold from "@/components/work-intake/review/WorkIntakeReviewScaffold";
import { REVIEW_WORK_ITEM } from "@/components/work-intake/review/review-scaffold-data";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review · Work Intake" };

/** Scaffold-only slug preserved for the WI-1/WI-2A acceptance tests.
 *  Every other slug is treated as a real WorkIntakeItem id. */
const SCAFFOLD_ONLY_SLUG = "row-1";

export default async function WorkIntakeReviewPage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId(user);

  const rawId = params.id ?? "";
  const intakeId = decodeURIComponent(rawId).trim();

  if (intakeId !== SCAFFOLD_ONLY_SLUG) {
    // WI-2B — real Work Intake id path. Tenant + mailbox-visibility
    // enforcement happens INSIDE loadWorkIntakeDetail
    // (workIntakeReadableByPrincipal). A miss (record not found OR
    // cross-tenant OR personal mailbox owned by another user) returns
    // null → notFound(). We never leak the reason.
    const detail = await loadWorkIntakeDetail({ principal, clubId, intakeId });
    if (!detail) notFound();
    // WI-2C will pass `detail` into the scaffold; for now the inner
    // UI still renders the accepted fixture per §35. The route
    // contract (auth + tenant + existence) is what WI-2B commits to.
  }

  return <WorkIntakeReviewScaffold item={REVIEW_WORK_ITEM} />;
}
