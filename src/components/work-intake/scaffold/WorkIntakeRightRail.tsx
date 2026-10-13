// WI-1 — right operational rail (§11). Static scaffold values.
//
// WI-CAL-1 (2026-10-13) — the Today's Commitments card is the
// EXACT same Mission Control component (approved reference
// implementation) consuming the SAME canonical TodayCommitmentsSnapshot.
// Prior WI-2B version collapsed the entire calendar to "N
// appointment(s) for today." without time, title, or source
// context — directive called this out as a founder-flagged defect.

import type { WiRailData } from "./scaffold-data";
import TodaysCommitments from "@/components/mission-control/TodaysCommitments";

export default function WorkIntakeRightRail({ data }: { data: WiRailData }) {
  const p = data.position;
  return (
    <>
      <section className="wi-rail-card">
        <div className="wi-rail-head">
          <span className="wi-rail-title">TODAY&rsquo;S POSITION</span>
          <span className="wi-rail-link">View ledger →</span>
        </div>
        <div className="wi-rail-row">
          <span>Member AR</span>
          <span className="wi-rail-value">{p.memberAr}</span>
        </div>
        <div className="wi-rail-row">
          <span>Over 60 days</span>
          <span className="wi-rail-value">{p.over60Days}</span>
        </div>
        <div className="wi-rail-row">
          <span>Tee times today</span>
          <span className="wi-rail-value">{p.teeTimesToday}</span>
        </div>
        <div className="wi-rail-row">
          <span>Reservations tonight</span>
          <span className="wi-rail-value">{p.reservationsTonight}</span>
        </div>
        <div className="wi-rail-row">
          <span>Covers projected</span>
          <span className="wi-rail-value">{p.coversProjected}</span>
        </div>
      </section>

      <section className="wi-rail-card">
        <div className="wi-rail-head">
          <span className="wi-rail-title">EXECUTIVE INSIGHT</span>
          <span className="wi-rail-link">More →</span>
        </div>
        <p className="wi-rail-insight">{data.insight.body}</p>
        <div className="wi-rail-source">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 3.5h8M2 6h8M2 8.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          Source: <span className="wi-rail-source-name">{data.insight.source}</span> · {data.insight.at}
        </div>
      </section>

      {/* WI-CAL-1B (2026-10-13) — mount the shared Mission Control
          component with ZERO outer wrapper, matching the admin
          page's JSX byte-for-byte.  The component already owns its
          own <section className="spectre-mc-rail-card
          spectre-mc-commitments"> — wrapping it in a sibling
          `wi-rail-card` nested the two cards (double border,
          doubled padding, mismatched height).  Work Intake's
          sidebar <aside> provides the outer positioning + width;
          the shared component's own section is now the sole card
          boundary, identical to Mission Control. */}
      <TodaysCommitments data={data.commitments.snapshot} />
    </>
  );
}
