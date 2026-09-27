// WI-1 (2026-09-27) — Work Intake visual scaffold root.
// Composes hero + KPI strip + feed + right rail using ONLY new
// presentational components. Static scaffold content mirrors the
// approved reference verbatim. No legacy Work Intake card reuse.

import WorkIntakeHero, { type HeroConfig } from "./WorkIntakeHero";
import WorkIntakeKpiStrip from "./WorkIntakeKpiStrip";
import WorkIntakeFeedHead from "./WorkIntakeFeedHead";
import WorkIntakeFeed from "./WorkIntakeFeed";
import WorkIntakeRightRail from "./WorkIntakeRightRail";
import { WI_FEED_ROWS, WI_KPIS, WI_RAIL } from "./scaffold-data";

interface Props {
  heroConfig?: HeroConfig;
}

export default function WorkIntakeScaffold({ heroConfig }: Props = {}) {
  return (
    <div className="wi-root">
      <div className="wi-grid">
        <div className="wi-main">
          <WorkIntakeHero config={heroConfig ?? { kind: "default" }} />
          <WorkIntakeKpiStrip cards={WI_KPIS} />
          <div className="wi-feed-card">
            <WorkIntakeFeedHead activeTab="my-feed" />
            <WorkIntakeFeed rows={WI_FEED_ROWS} />
          </div>
        </div>
        <aside className="wi-rail" aria-label="Operational rail">
          <WorkIntakeRightRail data={WI_RAIL} />
        </aside>
      </div>
    </div>
  );
}
