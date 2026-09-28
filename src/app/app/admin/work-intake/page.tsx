// WI-1 (2026-09-27) — Work Intake page.
// WI-2B (2026-09-27) — functional migration.
//
// The page now consumes the same canonical `loadMissionControlSnapshot`
// used by Mission Control and adapts the result into the accepted
// WI-1 presentation via the view-model helpers in
// `src/lib/work-intake/`. No parallel query layer; no fixture rows in
// production; no title-matching UI inference.
//
// Not yet migrated in WI-2B (deferred to a later slice, called out in
// the founder report):
//   - Work Intake search input (no domain search backend today)
//   - Filter chips (only ?view=active|history exists on Mission
//     Control; other chips need a new query API)
//   - AI Insights / Starred / Archived tabs (no domain concepts yet)
//   - Detailed inner Review page fields (per §35 — WI-2A internals
//     stay fixture-backed; only the route is authorised)

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { getClubMedia, getClubMediaFraming } from "@/lib/club/media";
import { loadMissionControlSnapshot } from "@/lib/mission-control";
import WorkIntakeScaffold from "@/components/work-intake/scaffold/WorkIntakeScaffold";
import { toFeedRows } from "@/lib/work-intake/feed-view-model";
import { toRailData } from "@/lib/work-intake/rail-view-model";
import { computeWorkIntakeKpiCounts } from "@/lib/work-intake/kpi-counts";
import type { WiKpi } from "@/components/work-intake/scaffold/scaffold-data";

export const dynamic = "force-dynamic";
export const metadata = { title: "Work Intake" };

export default async function WorkIntakePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId(user);

  // WI-1D — tenant-scoped Work Intake hero.
  const media = await getClubMedia(clubId, "work_intake_hero");
  const framing = media ? await getClubMediaFraming(clubId, "work_intake_hero") : null;
  const heroConfig = media
    ? {
        kind: "tenant" as const,
        url: `/api/clubs/${clubId}/work-intake-hero?v=${encodeURIComponent(media.sha256 || media.uploadedAt.toISOString())}`,
        focalX: (framing?.desktop.focalX ?? 0.5) * 100,
        focalY: (framing?.desktop.focalY ?? 0.5) * 100,
        zoom: framing?.desktop.zoom ?? 1,
      }
    : { kind: "default" as const };

  // WI-2B — canonical Work Intake snapshot. Same authoritative loader
  // used by Mission Control (§27). The "active" filter matches the
  // default Mission Control view — RESOLVED / SUPPRESSED items are
  // excluded from the feed but remain counted in "Completed this week".
  const snapshot = await loadMissionControlSnapshot(principal, clubId, { feedFilter: "active" });

  const clubTimezone = snapshot.clubTimezone.ianaZone;

  const rows = toFeedRows(snapshot.workItems, { clubTimezone });

  // KPI counts — needJudgment + readyForApproval come from the
  // snapshot's briefing (single source of truth); waitingOnOthers +
  // completedThisWeek are new Prisma counts tenant-scoped via
  // workIntakeReadableByPrincipal.
  const counts = await computeWorkIntakeKpiCounts({
    userId: principal.id,
    clubId,
    clubTimezone,
    needAttentionFromBriefing: snapshot.briefing.needJudgment,
    readyForReviewFromBriefing: snapshot.briefing.readyForApproval,
    now: snapshot.syncedAt,
  });

  const kpis: WiKpi[] = [
    {
      icon: "calendar",
      value: counts.needAttention,
      label: "Items need your attention",
      trend: { direction: "flat", delta: "No change", tone: "neutral" },
    },
    {
      icon: "clock",
      value: counts.readyForReview,
      label: "Items ready for review",
      trend: { direction: "flat", delta: "No change", tone: "neutral" },
    },
    {
      icon: "people",
      value: counts.waitingOnOthers,
      label: "Waiting on others",
      trend: { direction: "flat", delta: "No change", tone: "neutral" },
    },
    {
      icon: "check",
      value: counts.completedThisWeek,
      label: "Completed this week",
      trend: { direction: "flat", delta: "No change", tone: "neutral" },
    },
  ];

  const rail = toRailData({
    position: snapshot.position,
    insight: snapshot.insight,
    commitments: snapshot.todaysCommitments,
  });

  return (
    <WorkIntakeScaffold
      heroConfig={heroConfig}
      rows={rows}
      kpis={kpis}
      rail={rail}
    />
  );
}
