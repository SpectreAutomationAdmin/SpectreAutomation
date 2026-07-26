# Spectre Design Language

**Version 1.0 · Phase 1 (Foundation)**

This document is the single source of truth for Spectre's visual operating system. Every colour, weight, radius, shadow, and motion primitive that ships in Administration inherits from this file. If a design decision is not documented here, it does not exist.

The Monthly Reporting Package is explicitly excluded from this language — it operates under its own editorial system documented in [docs/spectre-executive-reporting-design-system.md](../spectre-executive-reporting-design-system.md). This document governs everything **outside** the Monthly Reporting Package.

---

## 1. Voice & Principles

Spectre Administration is **premium software**, not a publication. The interface should feel like a tool a controller would trust with their fiscal close — the same way a surgeon trusts their instruments. Every surface earns its place; nothing is decorative.

**References (aim for):** Apple Pro apps · Linear · Stripe Dashboard · Craft · Arc Browser · Figma · Porsche Design.

**Anti-references (avoid):** editorial layouts · newspaper mastheads · magazine spreads · gaming UI · cyberpunk · corporate templates · heavy gradients · glassmorphism · skeuomorphism · pure black · pure white.

**Six operating principles.**

1. **Neutral first, accent by exception.** Grays carry the interface. The club accent appears only when it changes what the user *does* (active nav item, primary CTA, focus ring).
2. **Geometry over ornament.** Precise 8-px grid. Sharp edges within a controlled radius scale. No decorative flourishes, textures, or illustrations.
3. **Motion is subtractive.** Transitions confirm state; they do not celebrate it. Nothing bounces, glows, or pulses.
4. **Density is a choice.** We offer both comfortable and dense variants where information volume warrants it (tables, forms).
5. **Every component earns its place.** If we cannot articulate its behavioural role in three words, it does not ship.
6. **Reduced motion is respected.** Every transition collapses under `prefers-reduced-motion: reduce`, scoped so the Monthly Reporting Package and other protected surfaces are unaffected.

---

## 2. Colour System

Every value below is a token. **No hex may be duplicated across two different token names.** Every colour has a purpose stated in the "Use" column.

Tokens are exposed as CSS variables at `:root` for the light theme and re-declared under `[data-theme="dark"]` for dark mode. Consumers reference tokens through Tailwind aliases (`bg-spectre-canvas`, `text-spectre-primary`, etc.) or through inline `style={{ color: 'var(--spectre-text-primary)' }}` where a class does not exist.

### 2.1 Light theme

#### Surfaces

| Token | Light value | Use |
|---|---|---|
| `--spectre-canvas` | `#f6f6f8` | Main application background outside surfaces |
| `--spectre-canvas-sunken` | `#eeeef1` | Nested empty areas, form field groups |
| `--spectre-surface` | `#fdfdfd` | Cards, panels, table rows |
| `--spectre-surface-hover` | `#f4f4f5` | Card / row hover state |
| `--spectre-surface-elevated` | `#fdfdfe` | Dialogs, popovers, drawers |
| `--spectre-sidebar` | `#f4f4f6` | Sidebar background |
| `--spectre-topbar` | `#fbfbfc` | Top bar background |

#### Borders

| Token | Light value | Use |
|---|---|---|
| `--spectre-border-hairline` | `rgba(15, 15, 20, 0.06)` | Card outlines, table row rules |
| `--spectre-border-default` | `rgba(15, 15, 20, 0.10)` | Form inputs, section dividers |
| `--spectre-border-strong` | `rgba(15, 15, 20, 0.16)` | Focus outlines, table headers |

#### Text

| Token | Light value | Use |
|---|---|---|
| `--spectre-text-primary` | `#17181b` | Body text, headings |
| `--spectre-text-secondary` | `rgba(23, 24, 27, 0.72)` | Subheads, secondary paragraphs |
| `--spectre-text-muted` | `rgba(23, 24, 27, 0.55)` | Labels, meta, timestamps |
| `--spectre-text-subtle` | `rgba(23, 24, 27, 0.38)` | Placeholders, disabled labels |
| `--spectre-text-inverse` | `#fdfdfe` | Text on accent-filled surfaces |

### 2.2 Dark theme

#### Surfaces

| Token | Dark value | Use |
|---|---|---|
| `--spectre-canvas` | `#0f1012` | Main application background |
| `--spectre-canvas-sunken` | `#0a0a0c` | Nested empty areas |
| `--spectre-surface` | `#17181b` | Cards, panels |
| `--spectre-surface-hover` | `#1c1d21` | Card / row hover state |
| `--spectre-surface-elevated` | `#1e1f24` | Dialogs, popovers |
| `--spectre-sidebar` | `#131418` | Sidebar background |
| `--spectre-topbar` | `#141519` | Top bar background |

#### Borders

| Token | Dark value | Use |
|---|---|---|
| `--spectre-border-hairline` | `rgba(255, 255, 255, 0.06)` | Card outlines, table row rules |
| `--spectre-border-default` | `rgba(255, 255, 255, 0.10)` | Form inputs, dividers |
| `--spectre-border-strong` | `rgba(255, 255, 255, 0.18)` | Focus, table headers |

#### Text

| Token | Dark value | Use |
|---|---|---|
| `--spectre-text-primary` | `#ececec` | Body text, headings |
| `--spectre-text-secondary` | `rgba(236, 236, 236, 0.74)` | Subheads |
| `--spectre-text-muted` | `rgba(236, 236, 236, 0.55)` | Labels, meta |
| `--spectre-text-subtle` | `rgba(236, 236, 236, 0.38)` | Placeholders |
| `--spectre-text-inverse` | `#0f1012` | Text on accent surfaces |

### 2.3 Accent (per-club, data-driven)

Populated at request time from `Club.primaryColor`. Never hardcoded. Defaults to Silver Springs green `#2f5832` when a tenant has not customised.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--spectre-accent` | `#2f5832` (default) | `#5a8f5e` (auto-lightened) | Primary CTA fill, active nav bar, focus ring base |
| `--spectre-accent-hover` | `#213a22` | `#4a7c4e` | Primary CTA hover |
| `--spectre-accent-soft` | `rgba(47, 88, 50, 0.10)` | `rgba(90, 143, 94, 0.14)` | Selected row backgrounds, ghost hover |
| `--spectre-accent-ring` | `rgba(47, 88, 50, 0.28)` | `rgba(90, 143, 94, 0.36)` | Focus ring outer |

**The accent NEVER glows.** No `box-shadow` blur radii above 4px on accent-coloured elements. This is the rule that separates Spectre from gaming UIs.

### 2.4 Status colours

| Token | Light value | Dark value | Use |
|---|---|---|---|
| `--spectre-status-success` | `#166534` | `#4ade80` | Success alerts, positive deltas |
| `--spectre-status-warning` | `#b45309` | `#fbbf24` | Warning alerts, aged AR |
| `--spectre-status-error` | `#b91c1c` | `#f87171` | Error alerts, failed operations |
| `--spectre-status-info` | `#1d4ed8` | `#60a5fa` | Info banners, help |

Status colours **never** appear on surfaces or borders — only on iconography, badges, alert accents, and text.

---

## 3. Typography

### 3.1 Families (maximum two)

- **Sans:** `Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
  – Everything visible. Interface, tables, data, labels, buttons.
- **Mono:** `"JetBrains Mono", "SF Mono", ui-monospace, monospace`
  – Code snippets, API keys, technical references only. Never used for data (tabular-nums on Inter does that job).

Serif is deliberately absent from this document. Editorial serif belongs to the Monthly Reporting Package.

### 3.2 Type scale

Every scale entry ships as a `--spectre-type-*-size` and `--spectre-type-*-line` token pair. Weights are declared inline via Tailwind (`font-medium` / `font-semibold`).

| Role | Size / Line | Weight | Letter-spacing | Use |
|---|---|---|---|---|
| **Display** | 32 / 40 | 600 | −0.02em | Page title on top-level admin views |
| **H1** | 24 / 32 | 600 | −0.015em | Section titles |
| **H2** | 20 / 28 | 600 | −0.01em | Card titles |
| **H3** | 16 / 24 | 600 | −0.005em | Subsection titles |
| **Body** | 14 / 22 | 400 | 0 | Default paragraph copy |
| **Body-small** | 13 / 20 | 400 | 0 | Meta, help text |
| **Caption** | 12 / 16 | 400 | 0 | Timestamps, tertiary meta |
| **Label** | 11 / 14 | 600 | 0.06em, UPPERCASE | Form labels, KPI labels |
| **Data** | 15 / 20 | 500 | 0, tabular-nums | Currency, counts in tables |
| **Table cell** | 13 / 20 | 400 | 0 | Standard table content |
| **Table header** | 11 / 16 | 600 | 0.06em, UPPERCASE | Column headers |
| **Navigation** | 13 / 20 | 500 | 0 | Sidebar items |
| **Button** | 13 / 16 | 500 | 0 | Buttons, CTAs |

### 3.3 Font-feature-settings

All text: `"cv11" 1, "ss01" 1` (Inter's single-story `a` + tabular fig substitutes).
All numeric data: additionally `"tnum" 1, "cv08" 1` (tabular numerals with slashed zero for legibility on dashboards).

---

## 4. Spacing

Only these values may be used. Everything else is a bug.

| Token | Pixel | Tailwind alias | Use |
|---|---|---|---|
| `--spectre-space-1` | 4 | `spectre-1` | Icon-to-label, tightest adjacencies |
| `--spectre-space-2` | 8 | `spectre-2` | Chip padding, thin inline gaps |
| `--spectre-space-3` | 12 | `spectre-3` | Standard control padding-y |
| `--spectre-space-4` | 16 | `spectre-4` | Card / dialog inner padding |
| `--spectre-space-6` | 24 | `spectre-6` | Between grouped cards, section internals |
| `--spectre-space-8` | 32 | `spectre-8` | Between sections, workspace padding (desktop) |
| `--spectre-space-10` | 40 | `spectre-10` | Between chapter-scale groupings |
| `--spectre-space-12` | 48 | `spectre-12` | Page top padding, empty-state framing |
| `--spectre-space-16` | 64 | `spectre-16` | Above/below page headers |
| `--spectre-space-24` | 96 | `spectre-24` | Section-to-section vertical rhythm on very tall pages |

**Workspace padding by breakpoint:** 32 px desktop → 20 px tablet → 16 px mobile.

---

## 5. Radius

| Element | Radius | Token |
|---|---|---|
| Button | 6 | `--spectre-radius-button` |
| Input | 6 | `--spectre-radius-input` |
| Card | 10 | `--spectre-radius-card` |
| Panel | 10 | `--spectre-radius-panel` |
| Dialog | 14 | `--spectre-radius-dialog` |
| Drawer | 14 (top corners only) | (composed inline) |
| Table | 8 | `--spectre-radius-table` |
| Workspace | 0 | — (workspace is flush inside the shell) |
| Pill / Badge | 999 | `--spectre-radius-pill` |

The workspace is **not** a floating rounded panel. It sits flush inside the shell, its edges defined by the sidebar and top bar. This is a deliberate change from earlier explorations — the workspace is *the room*, not *a document lying on a desk*.

---

## 6. Shadows

Shadows exist to communicate **elevation**, not to decorate. Every shadow is a multi-layer stack tinted with the canvas colour rather than pure black, so the lift reads as material rather than ink stain.

| Token | Definition | Use |
|---|---|---|
| `--spectre-shadow-subtle` | `0 1px 2px rgba(15,17,21,0.04)` | Resting card |
| `--spectre-shadow-elevated` | `0 1px 3px rgba(15,17,21,0.06), 0 4px 12px rgba(15,17,21,0.04)` | Card on hover |
| `--spectre-shadow-floating` | `0 4px 12px rgba(15,17,21,0.08), 0 12px 32px rgba(15,17,21,0.06)` | Popover, dropdown |
| `--spectre-shadow-dialog` | `0 8px 24px rgba(15,17,21,0.14), 0 24px 48px rgba(15,17,21,0.12)` | Dialog, drawer |
| `--spectre-shadow-focus` | `0 0 0 3px var(--spectre-accent-ring)` | Focus ring |
| `--spectre-shadow-hover` | equals `--spectre-shadow-elevated` | Hover state for interactive containers |

Dark-mode shadows use `rgba(0,0,0,0.35)` layers instead — the surface itself is dark, so pure-black shadows read as material rather than smudge.

---

## 7. Motion

Motion tokens are in milliseconds, easing is a shared cubic-bezier.

| Token | Value | Use |
|---|---|---|
| `--spectre-motion-fast` | 120 ms | Hover, focus, colour transitions |
| `--spectre-motion-base` | 160 ms | Enter transitions, dropdowns |
| `--spectre-motion-slow` | 200 ms | Drawer / dialog enter, theme switch |
| `--spectre-ease` | `cubic-bezier(0.4, 0, 0.2, 1)` | Standard easing, ease-out feel |
| `--spectre-ease-in-out` | `cubic-bezier(0.4, 0, 0.6, 1)` | State reversals |

### 7.1 Per-context motion

- **Hover.** 120 ms colour transition on background + border only. No `transform`, no scale, no lift.
- **Focus.** Instant ring appearance (no transition); ring is `--spectre-shadow-focus`.
- **Dialog.** 200 ms enter — 4 px `translateY(-4px) → 0` + opacity `0 → 1`. Backdrop fades 160 ms.
- **Dropdown.** 160 ms enter — 4 px `translateY(-4px) → 0` + opacity. No slide-in from off-screen.
- **Navigation.** Sidebar collapse: 200 ms width transition. Item hover: 120 ms background.
- **Loading.** Spinner rotates at 1000 ms per revolution. Skeletons pulse at 1600 ms.

### 7.2 Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  [class*="spectre-"] {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
    transition-delay: 0ms !important;
  }
}
```

Scoped to `[class*="spectre-"]` only. The Monthly Reporting Package's chart animations and any other non-Spectre motion are unaffected.

---

## 8. Iconography

Spectre ships with a single icon set — a small, stroke-based library of 24 × 24 SVGs with a **1.75 stroke width** and rounded caps + joins. This is close to the Lucide icon system's proportions but redrawn to Spectre's stroke weight for internal consistency.

**Rules.**

- Icons are always monochromatic (`currentColor`).
- Size choices are 14 / 16 / 20 / 24 px only.
- Icons pair with text at 8 px separation.
- Standalone icons (icon-only buttons) carry a `visually-hidden` label for screen readers.
- Coloured "status" glyphs (success check, error x) inherit their colour from the status token — the icon itself is neutral.

Icons are React components under `src/components/spectre/icons/*.tsx` and re-exported from a barrel.

---

## 9. Theme system

- Default: **Light.**
- User preference stored in `localStorage` under key `spectre-theme` with values `light` | `dark` | `system`.
- A tiny inline script in the root layout reads the preference before hydration and sets `document.documentElement.dataset.theme`, preventing FOUC.
- A React context provides `theme`, `resolvedTheme`, and `setTheme` for downstream consumers.
- The theme toggle in the top bar cycles `light → dark → system → light`.

Theme values live in the token block at `:root` (light default) and are overridden by `[data-theme="dark"]`. `system` follows `prefers-color-scheme` via a matchMedia listener that stamps the same `data-theme` attribute.

---

## 10. Component authoring rules

Every component must be explicable via at least three of the following six vectors:

1. **Spacing** (4-8-12-16 grid)
2. **Corners** (radius scale)
3. **Typography** (which scale entry)
4. **Motion** (which duration / easing)
5. **Interaction** (hover / focus / active / disabled states)
6. **Hierarchy** (semantic layering — surface / elevated / floating / dialog)

If a component's answer to "why does this look like Spectre?" is a *colour* rather than any of the above, it has not yet earned its place.

---

## 11. Excluded from this language

- The **Monthly Reporting Package** (`/app/admin/reporting/**` and every package-adjacent surface — see [CLAUDE.md](../../CLAUDE.md) for the full protected route list).
- The **Member Portal** (`/app/member/**`) — governed by the tenant's own branding, not this language.
- The **POS lounge** (`/app/admin/ops/pos/**`) — under a separate feature freeze.
- **Editorial voice** — no mastheads, no italic-serif conditions, no `Volume XVIII` treatments. That is the Monthly Reporting Package's territory.
- **Green as identity.** The accent is per-club, data-driven, and secondary; it never carries the interface.
