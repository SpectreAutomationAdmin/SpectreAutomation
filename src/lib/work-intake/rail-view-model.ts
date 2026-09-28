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
      // The canonical snapshot returns a structured commitments list
      // (calendar events + proposed deadlines). WI-2B renders the
      // rail's compact "empty state" copy when the list is empty, and
      // a short summary otherwise. Rich per-item rendering is a
      // deliberate deferral to WI-2C where the review pane will
      // adopt the same commitment component tree.
      empty: composeCommitmentsSummary(commitments),
    },
  };
}

function composeCommitmentsSummary(c: TodayCommitmentsSnapshot): string {
  const events = c.outlookEventCount ?? 0;
  const proposals = c.spectreCommitmentCount ?? 0;
  const total = events + proposals;
  if (total === 0) {
    return "No appointments or proposed follow-ups for today.";
  }
  const parts: string[] = [];
  if (events > 0) parts.push(`${events} appointment${events === 1 ? "" : "s"}`);
  if (proposals > 0) parts.push(`${proposals} proposed follow-up${proposals === 1 ? "" : "s"}`);
  return `${parts.join(" · ")} for today.`;
}
