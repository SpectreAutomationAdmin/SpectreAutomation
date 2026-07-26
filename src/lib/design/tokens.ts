// Spectre Design Language — Phase 1 token registry.
//
// Single source of truth for what `--spectre-*` CSS variables exist.
// The full authoritative narrative lives at
// `docs/design/Spectre Design Language.md`.
//
// Two independent consumers:
//   1. TypeScript components — typed handle to every registered token
//      so a rename is a compile-time break.
//   2. Guardrail tests — cross-check that every token here also
//      exists in `src/app/globals.css` and every Tailwind alias here
//      also exists in `tailwind.config.ts`.
//
// NOT for use in the Monthly Reporting Package (`/app/admin/reporting/**`),
// the MRP launcher / archive (`/app/admin/governance/monthly-package/**`
// or `/app/admin/governance/packages/**`), the POS lounge
// (`/app/admin/ops/pos/**` + `src/components/pos/**`), or the Member
// Portal (`/app/member/**`) — those surfaces render through their own
// styles until later slices explicitly migrate them.

export type CssVar = `--spectre-${string}`;

/**
 * Full registry of `--spectre-*` variables that MUST exist in
 * `src/app/globals.css`. Grouped by concern.
 *
 * Every value's description is a short one-liner explaining WHY the
 * token exists (its purpose). Two tokens may never carry the same
 * purpose — that would be duplication.
 */
export const SPECTRE_TOKENS = {
  surfaces: {
    "--spectre-canvas": "main application background outside surfaces",
    "--spectre-canvas-sunken": "nested empty areas, form field groups",
    "--spectre-surface": "cards, panels, table rows",
    "--spectre-surface-hover": "card / row hover state",
    "--spectre-surface-elevated": "dialogs, popovers, drawers",
    "--spectre-sidebar": "sidebar background",
    "--spectre-topbar": "top bar background",
  },
  borders: {
    "--spectre-border-hairline": "card outlines, table row rules",
    "--spectre-border-default": "form inputs, section dividers",
    "--spectre-border-strong": "focus outlines, table headers",
  },
  text: {
    "--spectre-text-primary": "body text, headings",
    "--spectre-text-secondary": "subheads, secondary paragraphs",
    "--spectre-text-muted": "labels, meta, timestamps",
    "--spectre-text-subtle": "placeholders, disabled labels",
    "--spectre-text-inverse": "text on accent-filled surfaces",
  },
  status: {
    "--spectre-status-success": "success text + iconography",
    "--spectre-status-warning": "warning text + iconography",
    "--spectre-status-error": "error text + iconography",
    "--spectre-status-info": "info text + iconography",
    "--spectre-status-success-bg": "success alert / badge background",
    "--spectre-status-warning-bg": "warning alert / badge background",
    "--spectre-status-error-bg": "error alert / badge background",
    "--spectre-status-info-bg": "info alert / badge background",
  },
  accent: {
    "--spectre-accent": "primary CTA fill, active nav bar, focus ring base",
    "--spectre-accent-hover": "primary CTA hover",
    "--spectre-accent-soft": "selected row backgrounds, ghost hover",
    "--spectre-accent-ring": "focus ring outer",
  },
  shadow: {
    "--spectre-shadow-subtle": "resting card",
    "--spectre-shadow-elevated": "card on hover",
    "--spectre-shadow-floating": "popover, dropdown",
    "--spectre-shadow-dialog": "dialog, drawer",
    "--spectre-shadow-focus": "focus ring on interactive controls",
  },
  radius: {
    "--spectre-radius-button": "button corner radius",
    "--spectre-radius-input": "input corner radius",
    "--spectre-radius-card": "card corner radius",
    "--spectre-radius-panel": "panel corner radius",
    "--spectre-radius-dialog": "dialog corner radius",
    "--spectre-radius-table": "table corner radius",
    "--spectre-radius-pill": "badge / pill / avatar radius",
  },
  motion: {
    "--spectre-motion-fast": "hover, focus, colour transitions",
    "--spectre-motion-base": "enter transitions, dropdowns",
    "--spectre-motion-slow": "drawer / dialog enter, theme switch",
    "--spectre-ease": "standard ease-out easing",
    "--spectre-ease-in-out": "state-reversal easing",
  },
  typography: {
    "--spectre-type-display-size": "display size",
    "--spectre-type-display-line": "display line-height",
    "--spectre-type-h1-size": "h1 size",
    "--spectre-type-h1-line": "h1 line-height",
    "--spectre-type-h2-size": "h2 size",
    "--spectre-type-h2-line": "h2 line-height",
    "--spectre-type-h3-size": "h3 size",
    "--spectre-type-h3-line": "h3 line-height",
    "--spectre-type-body-size": "body size",
    "--spectre-type-body-line": "body line-height",
    "--spectre-type-body-sm-size": "body-small size",
    "--spectre-type-body-sm-line": "body-small line-height",
    "--spectre-type-caption-size": "caption size",
    "--spectre-type-caption-line": "caption line-height",
    "--spectre-type-label-size": "label size (uppercase)",
    "--spectre-type-label-line": "label line-height",
    "--spectre-type-data-size": "tabular data size",
    "--spectre-type-data-line": "tabular data line-height",
    "--spectre-type-table-size": "table cell size",
    "--spectre-type-table-line": "table cell line-height",
    "--spectre-type-nav-size": "navigation item size",
    "--spectre-type-nav-line": "navigation item line-height",
    "--spectre-type-button-size": "button label size",
    "--spectre-type-button-line": "button label line-height",
  },
  spacing: {
    "--spectre-space-1": "4px — tightest adjacencies",
    "--spectre-space-2": "8px — chip padding, thin inline gaps",
    "--spectre-space-3": "12px — standard control padding-y",
    "--spectre-space-4": "16px — card / dialog inner padding",
    "--spectre-space-6": "24px — between grouped cards, section internals",
    "--spectre-space-8": "32px — between sections, workspace desktop padding",
    "--spectre-space-10": "40px — between chapter-scale groupings",
    "--spectre-space-12": "48px — page top padding, empty-state framing",
    "--spectre-space-16": "64px — above/below page headers",
    "--spectre-space-24": "96px — section-to-section rhythm on tall pages",
  },
  shellGeometry: {
    "--spectre-sidebar-w-expanded": "sidebar expanded width (248px)",
    "--spectre-sidebar-w-collapsed": "sidebar collapsed width (72px)",
    "--spectre-topbar-h": "top bar height (64px)",
    "--spectre-workspace-pad-x": "workspace horizontal padding (desktop)",
    "--spectre-workspace-pad-y": "workspace vertical padding (desktop)",
  },
} as const;

/** Union of every registered `--spectre-*` token name. */
export type SpectreTokenName = string;

/** Flat inventory used by boundary + presence tests. */
export function listSpectreTokenNames(): string[] {
  const acc: string[] = [];
  for (const group of Object.values(SPECTRE_TOKENS)) {
    for (const name of Object.keys(group)) acc.push(name);
  }
  return acc;
}

/**
 * Tailwind alias inventory — every alias registered under
 * `tailwind.config.ts` `theme.extend`. Kept in this file so the
 * tokens presence test doesn't need to reparse Tailwind config; it
 * greps for these identifiers as source-contract strings.
 */
export const SPECTRE_TAILWIND_ALIASES = [
  // colors — top-level namespace + child leaves that appear as quoted keys
  "spectre",
  // boxShadow
  "spectre-subtle",
  "spectre-elevated",
  "spectre-floating",
  "spectre-dialog",
  "spectre-focus",
  // radius
  "spectre-button",
  "spectre-input",
  "spectre-card",
  "spectre-panel",
  "spectre-dialog",
  "spectre-table",
  "spectre-pill",
  // motion
  "spectre-fast",
  "spectre-base",
  "spectre-slow",
  // spacing
  "spectre-1",
  "spectre-2",
  "spectre-3",
  "spectre-4",
  "spectre-6",
  "spectre-8",
  "spectre-10",
  "spectre-12",
  "spectre-16",
  "spectre-24",
] as const;

/**
 * Build the inline `style` object the shell wrapper attaches
 * per-request so `--spectre-accent` (+ derived tokens) reflects the
 * ACTUAL `Club.primaryColor` — no hardcoded Silver Springs value.
 *
 * Callers pass the exact colour from `getActiveBranding().primaryColor`;
 * we compute the hover/soft/ring derivatives from it. Any falsy or
 * malformed input silently degrades to the token defaults declared
 * in globals.css.
 *
 * Attach this to a wrapper `<div>` inside the layout, NEVER to
 * `<body>` (the root layout owns the body element).
 */
export function buildSpectreClubAccentStyle(
  primaryColor: string | null | undefined,
): React.CSSProperties | undefined {
  if (!primaryColor) return undefined;
  const parsed = parseHex(primaryColor);
  if (!parsed) return undefined;
  const { r, g, b } = parsed;
  const hover = darken(r, g, b, 0.14);
  const soft = `rgba(${r}, ${g}, ${b}, 0.10)`;
  const ring = `rgba(${r}, ${g}, ${b}, 0.28)`;
  return {
    ["--spectre-accent" as unknown as keyof React.CSSProperties]:
      primaryColor,
    ["--spectre-accent-hover" as unknown as keyof React.CSSProperties]:
      hover,
    ["--spectre-accent-soft" as unknown as keyof React.CSSProperties]:
      soft,
    ["--spectre-accent-ring" as unknown as keyof React.CSSProperties]:
      ring,
  } as React.CSSProperties;
}

function parseHex(v: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  return {
    r: (int >> 16) & 0xff,
    g: (int >> 8) & 0xff,
    b: int & 0xff,
  };
}

function darken(r: number, g: number, b: number, amount: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const factor = 1 - amount;
  return `rgb(${clamp(r * factor)}, ${clamp(g * factor)}, ${clamp(b * factor)})`;
}
