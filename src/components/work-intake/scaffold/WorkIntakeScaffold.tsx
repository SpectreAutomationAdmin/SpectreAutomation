// WI-1 (2026-09-27) — Work Intake visual scaffold root.
// WI-2B (2026-09-27) — now data-driven. The presentation stays
// identical to the accepted WI-1 design; the caller supplies real
// domain data via props. Fallback fixtures live in scaffold-data.ts
// and are used only when a caller omits a prop (dev/local-preview
// convenience only — production pages always pass real data).

import type { ReactNode } from "react";
import type { CurrentWeatherObservation } from "@/lib/reporting/weather";
import WorkIntakeHero, { type HeroConfig } from "./WorkIntakeHero";
import WorkIntakeKpiStrip from "./WorkIntakeKpiStrip";
import WorkIntakeFeedHead from "./WorkIntakeFeedHead";
import WorkIntakeFeed from "./WorkIntakeFeed";
import WorkIntakeRightRail from "./WorkIntakeRightRail";
import type { WiFeedRow, WiKpi, WiRailData } from "./scaffold-data";
import { WI_FEED_ROWS, WI_KPIS, WI_RAIL } from "./scaffold-data";

interface Props {
  heroConfig?: HeroConfig;
  rows?: WiFeedRow[];
  kpis?: WiKpi[];
  rail?: WiRailData;
  /** WI-2C — live banner props. */
  dateLabel?: string;
  greeting?: string;
  firstName?: string;
  weather?: CurrentWeatherObservation | null;
  /** WI-2C — Mission Control refresh triad rendered inside the hero
   *  (FeedSyncedStatusPill + MissionControlLiveRefresh trigger). The
   *  page composes them so this presentational scaffold stays
   *  server-safe. */
  feedSyncedSlot?: ReactNode;
  /** WI-2C — LiveRefreshProvider wrapper. When present, wraps the
   *  entire scaffold subtree so nested client components share the
   *  same refresh context. */
  refreshProvider?: (children: ReactNode) => ReactNode;
}

export default function WorkIntakeScaffold({
  heroConfig, rows, kpis, rail,
  dateLabel, greeting, firstName, weather, feedSyncedSlot, refreshProvider,
}: Props = {}) {
  const feedRows = rows ?? WI_FEED_ROWS;
  const kpiCards = kpis ?? WI_KPIS;
  const railData = rail ?? WI_RAIL;
  const body = (
    <div className="wi-root">
      <div className="wi-grid">
        <div className="wi-main">
          <WorkIntakeHero
            config={heroConfig ?? { kind: "default" }}
            dateLabel={dateLabel}
            greeting={greeting}
            firstName={firstName}
            weather={weather}
            feedSyncedSlot={feedSyncedSlot}
          />
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
  return refreshProvider ? refreshProvider(body) : body;
}
