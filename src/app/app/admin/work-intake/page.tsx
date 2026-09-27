// WI-1 (2026-09-27) — Work Intake visual scaffold.
//
// Isolated, static, visual-only page. Zero backend integration.
// This page reproduces the approved Work Intake design at
// 1586×992 with representative scaffold content. Functionality
// (real feed data, KPI wiring, right-rail loaders, actions)
// arrives in later slices per §28.
//
// Explicitly NOT reused from Mission Control:
//   - EmailIntakeCard, IntelligenceReviewCard, PayrollActionCard,
//     FeedItem  → replaced by new presentational rows.
//   - loadMissionControlSnapshot                    → NOT called.
//   - loadPosition / buildInsight / commitments     → NOT called.
//   - FeedSyncedStatusPill / MissionControlLiveRefresh → NOT rendered.
//
// The existing Mission Control page at /app/admin remains untouched.

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import WorkIntakeScaffold from "@/components/work-intake/scaffold/WorkIntakeScaffold";

export const dynamic = "force-dynamic";
export const metadata = { title: "Work Intake" };

export default async function WorkIntakePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <WorkIntakeScaffold />;
}
