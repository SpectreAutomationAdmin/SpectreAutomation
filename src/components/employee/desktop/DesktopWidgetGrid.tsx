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
        // Uniform-cards pass (2026-08-26) — Year-end Tax Forms is
        // now the same 1-column card as the other six. The 7th card
        // sits in the first cell of row 3; the remaining two grid
        // tracks stay empty (uniformity wins over "fill every cell").
        className="grid grid-cols-3 gap-4 [@media(max-height:900px)]:gap-3"
        style={{
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          // Uniform-cards enforcement: every row matches the tallest
          // card in the grid, so descriptions that wrap at narrower
          // viewport widths don't produce visually mismatched
          // heights across the seven cards.
          gridAutoRows: "1fr",
        }}
        data-testid="portal-desktop-widgets-grid"
      >
        {widgets.map((w) => (
          <li key={w.key} className="min-w-0">
            <Card w={w} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Card({ w }: { w: DesktopWidget }) {
  const available = w.href !== null;
  const body = (
    // Vertical-centre pass (2026-08-26) — `items-center` on the
    // outer flex row makes the icon-rail, divider, text region and
    // chevron behave as one vertically-centred group inside the
    // card. The prior `items-stretch` produced a top-heavy layout
    // with dead space below the content on tall cards. Icons render
    // via `[&_svg]:h-10 [&_svg]:w-10` — a proven Tailwind pattern
    // that forces the source SVG (`width="56" height="56"` HTML
    // attrs) to CSS-render at 40 × 40 px on desktop.
    <div className="flex items-center h-full" data-widget-available={available ? "true" : "false"}>
      <div
        className="flex items-center justify-center pl-6 pr-5 text-club-green-700 shrink-0 [&_svg]:h-10 [&_svg]:w-10"
        aria-hidden="true"
        data-testid={`portal-desktop-widget-icon-${w.key}`}
      >
        {w.icon}
      </div>
      <div aria-hidden="true" className="h-14 w-px bg-club-gold/65 shrink-0" />
      <div className="flex-1 min-w-0 px-5 py-4">
        <div className="font-serif text-[20px] leading-tight text-club-ink break-words">{w.title}</div>
        <div className="text-[14px] text-stone-500 leading-snug mt-1 break-words">{w.description}</div>
      </div>
      <div className="flex items-center pr-5 text-stone-400 shrink-0" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </div>
    </div>
  );
  const cls =
    // All seven cards share the same 116 px min-height + `h-full`
    // so they fill their grid cell (which is itself `1fr`, meaning
    // uniform per-row height). Year-end Tax Forms is no longer a
    // compact promo banner — the founder brief explicitly rejects
    // special-casing by widget key.
    "block h-full min-h-[116px] rounded-2xl border border-stone-200/80 bg-white shadow-[0_1px_2px_rgba(15,20,15,0.04)] " +
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
