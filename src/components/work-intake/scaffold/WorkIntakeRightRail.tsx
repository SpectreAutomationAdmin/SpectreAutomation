// WI-1 — right operational rail (§11). Static scaffold values.

import type { WiRailData } from "./scaffold-data";

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

      <section className="wi-rail-card">
        <div className="wi-rail-head">
          <span className="wi-rail-title">TODAY&rsquo;S COMMITMENTS</span>
        </div>
        <p className="wi-rail-empty">{data.commitments.empty}</p>
      </section>
    </>
  );
}
