// Sprint 2 B4.1 (2026-07-19) — Work Intake detail server page.
//
// Route: /app/user/work-intake/[id]
//
// Authentication + tenant + owner-scoped. Feature-flag gated
// (notFound() when off). Loads the canonical WorkIntakeItem + linked
// email + activity via the tenant-guarded reader.

import { notFound, redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { loadWorkIntakeDetail } from "@/lib/work-intake/detail-reader";
import WorkIntakeDetailClient from "@/components/work-intake/WorkIntakeDetailClient";

export default async function WorkIntakeDetailPage({ params }: { params: { id: string } }) {
  if (!isMailboxIntegrationEnabled()) notFound();
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  const detail = await loadWorkIntakeDetail({
    principal,
    clubId,
    intakeId: params.id,
  });
  if (!detail) notFound();
  return <WorkIntakeDetailClient detail={detail} currentUserId={principal.id} />;
}
