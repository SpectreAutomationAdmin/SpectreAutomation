// WI-2B (2026-09-27) — right-rail view-model adapter.
//
// Maps the canonical snapshot's `position`, `insight`, and
// `todaysCommitments` into the shape the accepted WI-1 right rail
// (`WiRailData`) expects. No business logic — this is a pure shape
// transform.

import type {
  Insight,
  Position,
} from "@/lib/mission-control/index";
import type { TodayCommitmentsSnapshot } from "@/lib/mission-control/commitments";
import type { WiRailData } from "@/components/work-intake/scaffold/scaffold-data";

interface Input {
  position: Position;
  insight: Insight;
  commitments: TodayCommitmentsSnapshot;
}

/** Format a money integer as "$1,234.56". `Position` values arrive
 *  from `MemberAccount.aggregate` as whole cents-in-dollars floats. */
function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}

export function toRailData({ position, insight, commitments }: Input): WiRailData {
  return {
    position: {
      memberAr: money(position.memberARCurrent),
      over60Days: money(position.memberAROver60),
      teeTimesToday: position.teeTimesToday,
      reservationsTonight: position.reservationsTonight,
      coversProjected: position.reservationsCovers,
    },
    insight: {
      body: insight.narrative,
      source: insight.source,
      at: insight.sourceTimeLabel,
    },
    commitments: {
      // WI-CAL-1 (2026-10-13) — pass the FULL canonical commitments
      // snapshot through to the rail so the Work Intake page can
      // render the same approved Mission Control `TodaysCommitments`
      // component (time + title + source eyebrow + consent hint).
      // Prior WI-2B shape (`{ empty: string }`) collapsed every
      // day's calendar to "N appointment(s) for today." — a founder-
      // reported defect caught during staging review.
      snapshot: commitments,
    },
  };
}
