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
import { getActiveClubId } from "@/lib/active-club";
import { getClubMedia, getClubMediaFraming } from "@/lib/club/media";
import WorkIntakeScaffold from "@/components/work-intake/scaffold/WorkIntakeScaffold";

export const dynamic = "force-dynamic";
export const metadata = { title: "Work Intake" };

export default async function WorkIntakePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // WI-1D — tenant-scoped Work Intake hero.
  //   If a `work_intake_hero` ClubMedia row exists → use it + framing.
  //   Otherwise fall back to the Spectre-shipped clubhouse default.
  const clubId = await getActiveClubId(user);
  const media = await getClubMedia(clubId, "work_intake_hero");
  const framing = media ? await getClubMediaFraming(clubId, "work_intake_hero") : null;

  const heroConfig = media
    ? {
        kind: "tenant" as const,
        url: `/api/clubs/${clubId}/work-intake-hero?v=${encodeURIComponent(media.sha256 || media.uploadedAt.toISOString())}`,
        // WI-1E — ClubMedia stores normalized 0..1 focal values.
        // The hero component uses these as CSS `object-position: X% Y%`,
        // so multiply by 100 here. Fall back to 50% when framing has
        // never been saved.
        focalX: (framing?.desktop.focalX ?? 0.5) * 100,
        focalY: (framing?.desktop.focalY ?? 0.5) * 100,
        zoom: framing?.desktop.zoom ?? 1,
      }
    : { kind: "default" as const };

  return <WorkIntakeScaffold heroConfig={heroConfig} />;
}
