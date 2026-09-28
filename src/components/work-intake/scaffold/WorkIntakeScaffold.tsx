// WI-1 (2026-09-27) — Work Intake visual scaffold root.
// WI-2B (2026-09-27) — now data-driven. The presentation stays
// identical to the accepted WI-1 design; the caller supplies real
// domain data via props. Fallback fixtures live in scaffold-data.ts
// and are used only when a caller omits a prop (dev/local-preview
// convenience only — production pages always pass real data).

import WorkIntakeHero, { type HeroConfig } from "./WorkIntakeHero";
import WorkIntakeKpiStrip from "./WorkIntakeKpiStrip";
import WorkIntakeFeedHead from "./WorkIntakeFeedHead";
import WorkIntakeFeed from "./WorkIntakeFeed";
import WorkIntakeRightRail from "./WorkIntakeRightRail";
import type { WiFeedRow, WiKpi, WiRailData } from "./scaffold-data";
import { WI_FEED_ROWS, WI_KPIS, WI_RAIL } from "./scaffold-data";

interface Props {
  heroConfig?: HeroConfig;
  /** WI-2B — real feed rows adapted from canonical WorkIntakeItems.
   *  When omitted, falls back to the WI-1 scaffold fixture (dev-only). */
  rows?: WiFeedRow[];
  /** WI-2B — real KPI counts computed against canonical WorkIntakeItems. */
  kpis?: WiKpi[];
  /** WI-2B — right-rail data adapted from the canonical snapshot's
   *  Position + Insight + TodayCommitments. */
  rail?: WiRailData;
}

export default function WorkIntakeScaffold({ heroConfig, rows, kpis, rail }: Props = {}) {
  const feedRows = rows ?? WI_FEED_ROWS;
  const kpiCards = kpis ?? WI_KPIS;
  const railData = rail ?? WI_RAIL;
  return (
    <div className="wi-root">
      <div className="wi-grid">
        <div className="wi-main">
          <WorkIntakeHero config={heroConfig ?? { kind: "default" }} />
          <WorkIntakeKpiStrip cards={kpiCards} />
          <div className="wi-feed-card">
            <WorkIntakeFeedHead activeTab="my-feed" />
            <WorkIntakeFeed rows={feedRows} />
          </div>
        </div>
        <aside className="wi-rail" aria-label="Operational rail">
          <WorkIntakeRightRail data={railData} />
        </aside>
      </div>
    </div>
  );
}
