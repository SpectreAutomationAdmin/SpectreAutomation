// HR mobile-hotfix continuation (2026-08-28) — desktop 3×2 widget
// grid. Structure per accepted reference:
//
//   Scheduling      Paystubs             Time Off
//   Forms           Safety & Training    Clock In / Out
//
// Card composition mirrors the approved mobile card language:
//   [ icon ] · [ brass divider ] · [ serif title + description ] · [ chevron ]
//
// Non-navigational widgets stay visually identical to the others
// but render as aria-disabled + tabIndex=-1 so the affordance is
// honest.

import Link from "next/link";
import type { ReactNode } from "react";

export interface DesktopWidget {
  key: string;
  title: string;
  description: string;
  href: string | null;
  icon: ReactNode;
  tourTarget?: string;
  /**
   * Optional column span, 1–3. Used to give the seventh Year-end
   * Tax Forms card its own intentional full-row footprint rather
   * than reading as an accidental orphan. Defaults to 1.
   */
  spanCols?: 1 | 2 | 3;
}

export default function DesktopWidgetGrid({ widgets }: { widgets: DesktopWidget[] }) {
  return (
    <section
      className="hidden md:block"
      data-testid="portal-desktop-widgets"
      aria-label="Employee Portal shortcuts"
    >
      <ul
        // Final fidelity pass (2026-08-26) — 3×2 grid, uniform gap.
        // `gridAutoRows` is intentionally NOT `1fr`; per the founder
        // brief the card height must derive from the accepted
        // reference component dimension, NOT be squeezed to fit the
        // browser's remaining vertical space. Each card uses a fixed
        // `min-h-[160px]` so it holds the accepted proportion whether
        // the viewport is 768 px or 1080 px tall.
        className="grid grid-cols-3 gap-4 [@media(max-height:820px)]:gap-3"
        style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}
        data-testid="portal-desktop-widgets-grid"
      >
        {widgets.map((w) => {
          const span = w.spanCols ?? 1;
          const spanClass = span === 3 ? "col-span-3" : span === 2 ? "col-span-2" : "";
          return (
            <li key={w.key} className={`min-w-0 ${spanClass}`}>
              <Card w={w} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Card({ w }: { w: DesktopWidget }) {
  const available = w.href !== null;
  // Full-row-spanning cards (spanCols: 3) render as a compact promo-
  // style row rather than a full standard card — this keeps the
  // seventh widget's row lean so the one-screen desktop target still
  // fits at 1536 × 864 without shrinking the restored hero.
  const isBanner = w.spanCols === 3;
  const bodyPadY = isBanner ? "py-3" : "py-4";
  const iconSize = isBanner ? 30 : 38;
  const titleSize = isBanner ? "text-[18px]" : "text-[20px]";
  const descSize = isBanner ? "text-[13px]" : "text-[14px]";
  const dividerMy = isBanner ? "my-2.5" : "my-3";
  const body = (
    // Fill-the-card pass (2026-08-27) — internal presentation scaled
    // up so icon + title + description occupy the card area properly
    // instead of clustering in the middle with excessive white
    // space. Icon 32 → 38 px, title 18 → 20 px, description 13 →
    // 14 px, divider taller (my-3), padding widened. Card geometry
    // (min-h) is UNCHANGED — the fill comes from the content, not
    // from stretching the card.
    <div className="flex items-stretch h-full" data-widget-available={available ? "true" : "false"}>
      <div className="flex items-center justify-center pl-6 pr-5 text-club-green-700 shrink-0" aria-hidden="true" style={{ width: iconSize + 12 }}>
        <span className="[&_svg]:!h-full [&_svg]:!w-full block" style={{ width: iconSize, height: iconSize }}>{w.icon}</span>
      </div>
      <div aria-hidden="true" className={`${dividerMy} w-px bg-club-gold/65 shrink-0`} />
      <div className={`flex-1 min-w-0 px-5 ${bodyPadY} flex flex-col justify-center`}>
        <div className={`font-serif ${titleSize} leading-tight text-club-ink break-words`}>{w.title}</div>
        <div className={`${descSize} text-stone-500 leading-snug mt-1 break-words`}>{w.description}</div>
      </div>
      <div className="flex items-center pr-5 text-stone-400 shrink-0" aria-hidden="true">
        <svg width={isBanner ? 18 : 20} height={isBanner ? 18 : 20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </div>
    </div>
  );
  const cls =
    // Fill-the-card pass — standard cards min-h 116; the seventh
    // spanning card (spanCols:3) uses a compact 72 px promo-banner
    // row so it reads as an intentional final row rather than an
    // orphan and doesn't blow the one-screen vertical budget.
    `block ${isBanner ? "min-h-[72px]" : "min-h-[116px]"} rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(15,20,15,0.04)] ` +
    (available
      ? "hover:border-stone-300 hover:shadow-[0_3px_8px_rgba(15,20,15,0.07)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-club-green-700"
      : "cursor-default");
  if (available && w.href) {
    return (
      <Link href={w.href} className={cls} data-testid={`portal-desktop-widget-${w.key}`} data-tour-target={w.tourTarget} aria-label={w.title}>
        {body}
      </Link>
    );
  }
  return (
    <div className={cls} data-testid={`portal-desktop-widget-${w.key}`} data-tour-target={w.tourTarget} role="link" aria-disabled="true" tabIndex={-1}>
      {body}
    </div>
  );
}
