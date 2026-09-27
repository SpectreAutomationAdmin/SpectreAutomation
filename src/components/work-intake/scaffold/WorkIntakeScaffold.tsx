// WI-1 (2026-09-27) — Work Intake visual scaffold root.
// Composes hero + KPI strip + feed + right rail using ONLY new
// presentational components. Static scaffold content mirrors the
// approved reference verbatim. No legacy Work Intake card reuse.

import WorkIntakeHero from "./WorkIntakeHero";
import WorkIntakeKpiStrip from "./WorkIntakeKpiStrip";
import WorkIntakeFeedHead from "./WorkIntakeFeedHead";
import WorkIntakeFeed from "./WorkIntakeFeed";
import WorkIntakeRightRail from "./WorkIntakeRightRail";
import { WI_FEED_ROWS, WI_KPIS, WI_RAIL } from "./scaffold-data";

export default function WorkIntakeScaffold() {
  return (
    <div className="wi-root">
      <div className="wi-grid">
        <div className="wi-main">
          <WorkIntakeHero />
          <WorkIntakeKpiStrip cards={WI_KPIS} />
          <WorkIntakeFeedHead activeTab="my-feed" />
          <WorkIntakeFeed rows={WI_FEED_ROWS} />
        </div>
        <aside className="wi-rail" aria-label="Operational rail">
          <WorkIntakeRightRail data={WI_RAIL} />
        </aside>
      </div>
    </div>
  );
}
