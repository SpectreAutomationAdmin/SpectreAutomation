// HR-2C Employee Portal — canonical navigation icon set (2026-08-27).
// Single source of truth so the desktop sidebar, mobile widgets,
// and desktop widget grid render the SAME glyph for each
// destination and cannot drift again.
//
// Each icon accepts a `size` prop so the same source SVG can render
// at 22 px (sidebar / mobile card) OR 56 px (desktop widget card
// icon rail) without duplication.
//
// Never inline a differently-styled icon for these destinations in
// a component again — import from here.

interface IconProps {
  size?: number;
  /** Optional stroke override — sidebar rails use 1.7–1.8, widget
   *  cards use 1.7. Do NOT set higher than 2. */
  strokeWidth?: number;
  /** Screen-reader text — hidden by default (icons are decorative
   *  inside labelled buttons/links). Pass a label if the caller is
   *  a bare glyph without adjacent text. */
  title?: string;
}

function base(size: number, strokeWidth: number, title: string | undefined) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": title ? undefined : true,
    role: title ? "img" : undefined,
  };
}

export function IconHome({ size = 22, strokeWidth = 1.8, title }: IconProps = {}) {
  return (
    <svg {...base(size, strokeWidth, title)}>
      {title && <title>{title}</title>}
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />
    </svg>
  );
}

export function IconSchedule({ size = 22, strokeWidth = 1.7, title }: IconProps = {}) {
  return (
    <svg {...base(size, strokeWidth, title)}>
      {title && <title>{title}</title>}
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <line x1="3.5" y1="10" x2="20.5" y2="10" />
      <line x1="8" y1="3" x2="8" y2="7" />
      <line x1="16" y1="3" x2="16" y2="7" />
    </svg>
  );
}

/** Paystubs — dollar sign inside a circle. Renders the same in
 *  the sidebar (label "Pay") and the widget grid (label
 *  "Paystubs"). Route naming is unchanged. */
export function IconPaystubs({ size = 22, strokeWidth = 1.7, title }: IconProps = {}) {
  return (
    <svg {...base(size, strokeWidth, title)}>
      {title && <title>{title}</title>}
      <circle cx="12" cy="12" r="9" />
      <path d="M15 8.5H10.5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4H9" />
      <line x1="12" y1="6" x2="12" y2="8.5" />
      <line x1="12" y1="16.5" x2="12" y2="19" />
    </svg>
  );
}

/** Time Off — suitcase / briefcase per founder direction. */
export function IconTimeOff({ size = 22, strokeWidth = 1.7, title }: IconProps = {}) {
  return (
    <svg {...base(size, strokeWidth, title)}>
      {title && <title>{title}</title>}
      <path d="M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6" />
      <rect x="3.5" y="6" width="17" height="14" rx="2" />
      <line x1="3.5" y1="12.5" x2="20.5" y2="12.5" />
      <line x1="12" y1="11.5" x2="12" y2="13.5" />
    </svg>
  );
}

/** Documents — clipboard/form. */
export function IconDocuments({ size = 22, strokeWidth = 1.7, title }: IconProps = {}) {
  return (
    <svg {...base(size, strokeWidth, title)}>
      {title && <title>{title}</title>}
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 3h6a1 1 0 0 1 1 1v2H8V4a1 1 0 0 1 1-1z" />
      <line x1="8.5" y1="11" x2="15.5" y2="11" />
      <line x1="8.5" y1="15" x2="15.5" y2="15" />
    </svg>
  );
}

/** Safety & Training — graduation cap. */
export function IconTraining({ size = 22, strokeWidth = 1.7, title }: IconProps = {}) {
  return (
    <svg {...base(size, strokeWidth, title)}>
      {title && <title>{title}</title>}
      <path d="M2.5 9.5 12 5l9.5 4.5L12 14 2.5 9.5z" />
      <path d="M6.5 11.5v4c0 1 2.5 2.5 5.5 2.5s5.5-1.5 5.5-2.5v-4" />
      <line x1="21.5" y1="9.5" x2="21.5" y2="14" />
    </svg>
  );
}

/** Clock In / Out — clock face. */
export function IconClock({ size = 22, strokeWidth = 1.7, title }: IconProps = {}) {
  return (
    <svg {...base(size, strokeWidth, title)}>
      {title && <title>{title}</title>}
      <circle cx="12" cy="12" r="8.5" />
      <polyline points="12 7.5 12 12 16 14" />
    </svg>
  );
}

/** More — horizontal ellipsis. */
export function IconMore({ size = 22, strokeWidth = 1.8, title }: IconProps = {}) {
  return (
    <svg {...base(size, strokeWidth, title)}>
      {title && <title>{title}</title>}
      <circle cx="5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="19" cy="12" r="1.3" />
    </svg>
  );
}

/** Profile — user silhouette. Used in the simplified desktop
 *  sidebar's second nav item; matches the outlined line-icon
 *  system the rest of the portal already uses. */
export function IconProfile({ size = 22, strokeWidth = 1.7, title }: IconProps = {}) {
  return (
    <svg {...base(size, strokeWidth, title)}>
      {title && <title>{title}</title>}
      <circle cx="12" cy="8.5" r="4" />
      <path d="M4.5 20.5c1.6-3.5 5-5.5 7.5-5.5s5.9 2 7.5 5.5" />
    </svg>
  );
}

/** Anonymous Feedback — speech bubble. Replaces the Need Help
 *  headset icon in the sidebar's bottom card. */
export function IconFeedback({ size = 22, strokeWidth = 1.7, title }: IconProps = {}) {
  return (
    <svg {...base(size, strokeWidth, title)}>
      {title && <title>{title}</title>}
      <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z" />
      <line x1="8" y1="10" x2="16" y2="10" />
      <line x1="8" y1="13.5" x2="13.5" y2="13.5" />
    </svg>
  );
}
