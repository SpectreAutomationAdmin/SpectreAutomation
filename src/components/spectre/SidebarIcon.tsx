// Sprint 3 · Checkpoint 15N (2026-07-27) — Variant D sidebar icon
// system. Single centralized SVG set, typed key, one call site per
// nav item.
//
// Reference: public/design-concepts/mission-control/variant-d-instrument.html
// (§`.nav-item svg`). Every icon uses the same specification:
//   • viewBox 0 0 24 24
//   • stroke   currentColor
//   • stroke-width 1.9
//   • linecap / linejoin round
//   • fill      none
//   • rendered size 15×15 to match the reference (was 16 pre-15N)
//
// This file is the ONLY place raw sidebar-nav SVG markup lives.
// Nav data (src/components/sidebar-nav-data.ts) references icons
// by NavigationIconKey — an unknown key is a compile-time error
// (const-narrowed enum + explicit switch).

import type { CSSProperties } from "react";

export type NavigationIconKey =
  | "mission-control"
  | "search"
  | "membership"
  | "people"
  | "finance"
  | "accounts-payable"
  | "operations"
  | "hospitality"
  | "governance-reporting"
  | "analytics"
  | "communications"
  | "data"
  | "configuration"
  | "security"
  | "settings"
  | "mfa"
  | "design-system";

interface Props {
  name: NavigationIconKey;
  /** Rendered pixel size (width + height). Default 15 to match the Variant D reference. */
  size?: number;
  className?: string;
  style?: CSSProperties;
}

const SVG_BASE = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
};

export default function SidebarIcon({ name, size = 15, className, style }: Props) {
  const common = {
    ...SVG_BASE,
    width: size,
    height: size,
    className,
    style,
  };
  switch (name) {
    // Variant D exact reference (dashboard/instrument gauge glyph).
    case "mission-control":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="3.5" />
        </svg>
      );
    // Variant D exact.
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
      );
    // Variant D exact — person + arc for member/group.
    case "membership":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 20c1.5-4 5-6 8-6s6.5 2 8 6" />
        </svg>
      );
    // People (HR staff) — two-figure silhouette. Distinct from
    // Membership (single person + arc) so the sidebar keeps the two
    // domains visually separate: Membership is the private-club
    // roster; People is the club's own employees.
    case "people":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3 20c1-3.4 3.6-5 6-5s5 1.6 6 5" />
          <circle cx="16.5" cy="9.5" r="2.6" />
          <path d="M16 15c2.4 0 4.4 1.4 5 5" />
        </svg>
      );
    // Variant D exact — ascending bar chart.
    case "finance":
      return (
        <svg {...common}>
          <path d="M4 20V9" />
          <path d="M9 20V4" />
          <path d="M14 20V13" />
          <path d="M19 20V7" />
        </svg>
      );
    // AP — invoice / document with lines. Same-family outline, matches
    // the Variant D document/receipt vocabulary at lines 670/721.
    case "accounts-payable":
      return (
        <svg {...common}>
          <path d="M6 3h9l4 4v14H6z" />
          <path d="M6 9h9" />
          <path d="M9 14h4" />
          <path d="M9 17h6" />
        </svg>
      );
    // Variant D exact — sun/gear radiating spokes for operations.
    case "operations":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3v3" />
          <path d="M12 18v3" />
          <path d="M5 5l2.1 2.1" />
          <path d="M16.9 16.9L19 19" />
          <path d="M3 12h3" />
          <path d="M18 12h3" />
          <path d="M5 19l2.1-2.1" />
          <path d="M16.9 7.1L19 5" />
        </svg>
      );
    // Hospitality — restrained wine glass. Bowl + stem + base. Outline
    // only; same stroke weight as the rest. Founder-required
    // per Checkpoint 15N Phase 3.
    case "hospitality":
      return (
        <svg {...common}>
          <path d="M8 3h8l-1 6a3 3 0 0 1-6 0z" />
          <path d="M12 15v6" />
          <path d="M8 21h8" />
        </svg>
      );
    // Governance & Reporting — Variant D "building" glyph
    // (institutional / board-house), works for the governance +
    // committee side of the section.
    case "governance-reporting":
      return (
        <svg {...common}>
          <path d="M4 21V8l8-4 8 4v13" />
          <path d="M9 21v-7h6v7" />
        </svg>
      );
    // Analytics — trend / spark line.
    case "analytics":
      return (
        <svg {...common}>
          <path d="M4 18l5-5 4 4 7-9" />
          <path d="M13 8h7v7" />
        </svg>
      );
    // Communications — envelope (same family as the reference AP work-summary).
    case "communications":
      return (
        <svg {...common}>
          <path d="M3 6h18v12H3z" />
          <path d="M3 6l9 7 9-7" />
        </svg>
      );
    // Data — stacked database cylinders.
    case "data":
      return (
        <svg {...common}>
          <ellipse cx="12" cy="6" rx="7" ry="2.5" />
          <path d="M5 6v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" />
          <path d="M5 12v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6" />
        </svg>
      );
    // Configuration — sliders (horizontal three-track panel).
    case "configuration":
      return (
        <svg {...common}>
          <path d="M4 6h11" />
          <circle cx="18" cy="6" r="2" />
          <path d="M4 12h6" />
          <circle cx="13" cy="12" r="2" />
          <path d="M17 12h3" />
          <path d="M4 18h11" />
          <circle cx="18" cy="18" r="2" />
        </svg>
      );
    // Variant D exact — padlock.
    case "security":
      return (
        <svg {...common}>
          <rect x="4" y="10" width="16" height="10" rx="1.5" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      );
    // Variant D exact — settings gear.
    case "settings":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      );
    // MFA — shield + check.
    case "mfa":
      return (
        <svg {...common}>
          <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
    // Design system — palette-like glyph for internal / super-admin use.
    case "design-system":
      return (
        <svg {...common}>
          <path d="M4 4h16v10H4z" />
          <path d="M4 18h10" />
          <circle cx="18" cy="18" r="2" />
        </svg>
      );
  }
}
