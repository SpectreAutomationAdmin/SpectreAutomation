// WI-2B (2026-09-27) — Work Intake KPI count service.
//
// Canonical count definitions for the four cards in the accepted
// WI-1 KPI strip. Two of the four numbers already exist on the
// Mission Control briefing snapshot; two are new derived counts that
// live here so both surfaces can share them.
//
//   ITEMS NEED YOUR ATTENTION → BriefingCounts.needJudgment
//                               (state === "judgment" on the merged
//                                feed — set by the domain loaders,
//                                never by title matching)
//
//   ITEMS READY FOR REVIEW    → BriefingCounts.readyForApproval
//                               (state === "approval" on the merged
//                                feed)
//
//   WAITING ON OTHERS         → WorkIntakeItem.count where
//                                 clubId matches AND
//                                 status IN ('OPEN','IN_PROGRESS') AND
//                                 ownerUserId IS NOT NULL AND
//                                 ownerUserId <> currentUserId
//                                 (tenant-scoped via
//                                  workIntakeReadableByPrincipal)
//
//   COMPLETED THIS WEEK       → WorkIntakeItem.count where
//                                 clubId matches AND
//                                 status = 'RESOLVED' AND
//                                 resolvedAt >= startOfLocalWeek
//                                 (Sunday 00:00 in club timezone)
//
// The two derived counts use `workIntakeReadableByPrincipal` for
// tenant + mailbox-visibility enforcement — identical to every other
// Work Intake read path. They do NOT bypass the tenant guard.

import { prisma } from "@/lib/prisma";
import { workIntakeReadableByPrincipal } from "@/lib/work-intake/tenant";
import {
  toLocalDateString,
  zonedTimeToUtc,
} from "@/lib/mission-control/arrival";

export interface WorkIntakeKpiCounts {
  needAttention: number;
  readyForReview: number;
  waitingOnOthers: number;
  completedThisWeek: number;
}

interface Input {
  userId: string;
  clubId: string;
  isClubAdmin?: boolean;
  isSuperAdmin?: boolean;
  clubTimezone: string;
  needAttentionFromBriefing: number;   // BriefingCounts.needJudgment
  readyForReviewFromBriefing: number;  // BriefingCounts.readyForApproval
  now?: Date;                          // override for tests
}

/** Compute the four KPI counts shown on /app/admin/work-intake.
 *
 *  The first two numbers come from the caller (usually a
 *  loadMissionControlSnapshot briefing), because those counts require
 *  the same merged / suppressed feed the snapshot loader already
 *  produced — recomputing them here would duplicate business logic.
 *  The remaining two are direct Prisma counts, tenant-scoped. */
export async function computeWorkIntakeKpiCounts(input: Input): Promise<WorkIntakeKpiCounts> {
  const now = input.now ?? new Date();
  const scope = workIntakeReadableByPrincipal({
    userId: input.userId,
    clubId: input.clubId,
    isClubAdmin: input.isClubAdmin ?? false,
    isSuperAdmin: input.isSuperAdmin ?? false,
  });

  const startOfWeek = startOfLocalWeekUtc(now, input.clubTimezone);

  const [waitingOnOthers, completedThisWeek] = await Promise.all([
    prisma.workIntakeItem.count({
      where: {
        AND: [
          scope,
          { status: { in: ["OPEN", "IN_PROGRESS"] } },
          { ownerUserId: { not: null } },
          { NOT: { ownerUserId: input.userId } },
        ],
      },
    }),
    prisma.workIntakeItem.count({
      where: {
        AND: [
          scope,
          { status: "RESOLVED" },
          { resolvedAt: { gte: startOfWeek } },
        ],
      },
    }),
  ]);

  return {
    needAttention: input.needAttentionFromBriefing,
    readyForReview: input.readyForReviewFromBriefing,
    waitingOnOthers,
    completedThisWeek,
  };
}

/** Return the UTC instant corresponding to Sunday 00:00 in the given
 *  club timezone, for a given "now". Uses Intl to derive the local
 *  weekday, then rewinds the calendar date accordingly and converts
 *  back to UTC — DST-safe. */
function startOfLocalWeekUtc(now: Date, timezone: string): Date {
  const localToday = toLocalDateString(now, timezone); // YYYY-MM-DD
  // Derive the local weekday index (0 = Sun … 6 = Sat) from Intl.
  const weekdayShort = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, weekday: "short",
  }).format(now);
  const idx = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(weekdayShort);
  const dayOffset = idx === -1 ? 0 : idx;

  const [y, m, d] = localToday.split("-").map(Number);
  const sundayUtcMs = Date.UTC(y, m - 1, d) - dayOffset * 86_400_000;
  const sundayIsoDate = `${new Date(sundayUtcMs).getUTCFullYear()}-` +
    `${String(new Date(sundayUtcMs).getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(new Date(sundayUtcMs).getUTCDate()).padStart(2, "0")}`;
  return zonedTimeToUtc(`${sundayIsoDate}T00:00:00`, timezone);
}
