# Monthly Reporting — Color Audit

**Surface:** `/app/admin/reporting/monthly` (page + helpers in [src/app/app/admin/reporting/monthly/page.tsx](src/app/app/admin/reporting/monthly/page.tsx) and the shell at [src/components/reporting/ReportingShell.tsx](src/components/reporting/ReportingShell.tsx)).
**Audit date:** 2026-06-03
**Audited against:** [docs/spectre-executive-reporting-design-system.md § Color Philosophy](spectre-executive-reporting-design-system.md#color-philosophy).

> **No code changed.** This document lists every color token currently
> rendered on the Monthly Reporting screens, identifies the ones that
> still feel SaaS-oriented, and proposes a replacement palette.

---

## What the design system requires

### Primary palette

| Role | Token | Hex |
|---|---|---|
| Deep editorial green | `club-green-900` | `#0f2410` |
| Mid editorial green | `club-green-800` | `#213a22` |
| Standard green (sparklines, "On plan" verdicts, dot fills) | `club-green-700` | `#284829` |
| Ivory parchment (body bg, summary sub-bg) | `club-cream` | `#f8f5ef` |
| Hairline ivory (dividers, card borders) | `club-sand` | `#ece5d3` |
| Muted gold (chapter numerals, period chip, partial chip) | `club-gold` | `#b08a4a` |

### Status indicators (must be desaturated relative to default SaaS palettes)

| State | Token | Hex |
|---|---|---|
| Live / favorable | `club-green-800` | `#213a22` |
| Partial / watch | `club-gold` | `#b08a4a` |
| Demo / under watch | `amber-700` → `amber-800` | `#b45309`–`#92400e` |
| Escalate (reserved, sparing) | `red-700` | `#b91c1c` |

### Banned

The spec explicitly forbids:
- Purple / violet / pink (any shade) — reads as SaaS
- Neon green, neon blue, neon orange — reads as alert system
- Gradient fills — reads as marketing site
- Pure `#000000` and pure `#ffffff` text on the report body
- **Tinted card backgrounds** — *"no `bg-blue-50`, no `bg-amber-50`) on report content. The card is paper. Paper is white-on-cream."*
- Stoplight colors at full saturation

---

## Methodology

I grep'd every color token across the page and the shell. Tokens fall into three groups:

- **Conformant** — match the spec exactly
- **Spec gap** — used but not named in the spec (e.g. hex strokes)
- **Violations** — explicitly banned or contradict the palette

Each finding is ranked by how loudly it reads as SaaS at first paint.

---

## Severity scale

| Rank | Definition |
|---|---|
| **Critical** | Explicitly banned by the spec and visible on the first paint of multiple chapters. |
| **High** | Pulled directly from a SaaS chip / dashboard convention; not on the named palette. |
| **Medium** | Slight saturation drift from the spec's named tone (e.g. `red-800` vs the spec's `red-700`). |
| **Low** | Defensible micro-choice (within spec range) but worth naming. |

---

## Findings

### Critical

#### C1 — Tinted chip backgrounds (`bg-amber-50` / `bg-red-50` / `bg-club-green-50`)

The spec is unambiguous: *"No tinted card backgrounds (no `bg-blue-50`, no `bg-amber-50`) on report content. The card is paper. Paper is white-on-cream."* Yet three chip components ship with light pastel-tinted backgrounds:

[page.tsx:1652-1656](src/app/app/admin/reporting/monthly/page.tsx#L1652-L1656) — `ToneChip`:
```tsx
const klass = {
  green:   "bg-club-green-50 text-club-green-800 ring-1 ring-club-green-200",
  amber:   "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
  red:     "bg-red-50 text-red-800 ring-1 ring-red-200",
  neutral: "bg-club-cream text-club-green-800/80 ring-1 ring-club-sand",
}[tone];
```

[page.tsx:1681-1685](src/app/app/admin/reporting/monthly/page.tsx#L1681-L1685) — `DataSourceChip`:
```tsx
const classes = source === "live"
  ? "bg-club-green-50 text-club-green-800 ring-club-green-200"
  : source === "partial"
    ? "bg-club-cream text-club-gold ring-club-gold/40"
    : "bg-amber-50 text-amber-800 ring-amber-200";
```

**Why this reads SaaS:** `bg-amber-50 text-amber-800 ring-amber-200` is the universal Tailwind "warning chip" silhouette — every admin starter ships with it. Same for `bg-red-50` (error chip) and `bg-club-green-50` (success chip). Three chips, three pastel-tinted backgrounds, three SaaS stoplights. Each appears on multiple chapters (DataSourceChip on every section, ToneChip on Capital Projects).

The *partial* state already uses the on-spec `bg-club-cream` background — the other two states have drifted away from it.

**Rank: Critical.** Banned literally by name in the spec; visible on every chapter.

---

#### C2 — Stoplight saturation on tone dots

[page.tsx:1702-1707](src/app/app/admin/reporting/monthly/page.tsx#L1702-L1707) — `dotForTone`:
```tsx
function dotForTone(tone: KpiTone): string {
  return tone === "green" ? "bg-club-green-500"
    : tone === "amber" ? "bg-amber-500"
    : tone === "red" ? "bg-red-500"
    : "bg-stone-300";
}
```

Each tone dot uses the brightest, most-saturated step of its color (`-500`). The spec is explicit: *"Status colors must be desaturated relative to default SaaS palettes. A board document does not use stoplight colors at full saturation."* The named palette puts the live tone at `club-green-700/800`, the watch tone at `amber-700/800`, and escalation at `red-700`.

`bg-club-green-500` (`#5b8c2c`), `bg-amber-500` (`#f59e0b`), `bg-red-500` (`#ef4444`) are precisely the stoplight saturation the spec forbids.

Tone dots render on every KPI tile (six per chapter on at-a-glance, sixteen on stewardship, four on operations, four on payroll, four on F&B) so the dots are the most-repeated colored element in the document.

**Rank: Critical.** Explicit spec violation; visually loudest on the page.

---

#### C3 — `bg-stone-300` neutral tone dot

[page.tsx:1706](src/app/app/admin/reporting/monthly/page.tsx#L1706):
```tsx
: "bg-stone-300";
```

The neutral variant of `dotForTone` uses `bg-stone-300` — an admin-stone neutral. The chrome audit (C-tier) already removed `stone-200`/`stone-500`/`stone-900` from the page; this is the last stone token still rendering. Spec requires every dot to come from the club palette.

**Rank: Critical.** Last stone-token rendering on the page; banned by both the chrome audit and the color philosophy.

---

### High

#### H1 — Pastel ring colors on chips (`ring-amber-200` / `ring-red-200` / `ring-club-green-200`)

Same chip code paths as C1. The chips render with not only tinted backgrounds but matched pastel ring outlines:
- `ring-amber-200` (`#fde68a`)
- `ring-red-200` (`#fecaca`)
- `ring-club-green-200`

The 1-px pastel border around a tinted chip is the second half of the SaaS warning-chip silhouette. Even if the background were repainted (resolving C1), the rings would keep the chips reading as SaaS warning/error/success badges.

The *partial* state uses `ring-club-gold/40` which is on-spec.

**Rank: High.** Tightly coupled to C1; same fix flow.

---

#### H2 — Hardcoded burnt-orange sparkline stroke (`#a85a1f`)

[page.tsx:1181](src/app/app/admin/reporting/monthly/page.tsx#L1181):
```tsx
<SparkCard
  title="F&B subsidy (% of dues)"
  unitSuffix="%"
  series={f.subsidyTrend}
  stroke="#a85a1f"
  ...
/>
```

The F&B subsidy chart uses `#a85a1f` — a burnt-orange hex literal. This is:
- Not in the named palette (the spec lists `club-gold` `#b08a4a` for muted-gold and `amber-700` `#b45309` for amber).
- Saturated enough to read as a "warning trend" line — a SaaS dashboard idiom for *trend that you should worry about*.
- Inconsistent with the other two sparklines on the page (`#284829` = `club-green-700`, which is on-spec).

The chart's lead caption explicitly says *"declining is favorable"* — the burnt-orange line is **not** signalling alarm; it's just a stylistic differentiator from the green lines. That's a SaaS reflex (color-code every metric differently so you can scan a dashboard), not a memo reflex.

**Rank: High.** One occurrence but visible on chapter VIII; not on the named palette.

---

### Medium

#### M1 — `text-red-800` chip text exceeds spec's `red-700`

[page.tsx:1655](src/app/app/admin/reporting/monthly/page.tsx#L1655) (`ToneChip`):
```tsx
red: "bg-red-50 text-red-800 ring-1 ring-red-200",
```

The spec names `red-700` (`#b91c1c`) as the escalation tone. The chip uses `text-red-800` (`#991b1b`) — one step darker. Both are desaturated, but the spec is specific.

The DataSourceChip demo state uses `text-amber-800`. The spec range for amber is *"`amber-700` → `amber-800`"* — both ends acceptable. `text-amber-800` is within range.

**Rank: Medium.** Drift within the desaturated family, not a SaaS reflex; but the spec named the tone precisely.

---

#### M2 — `text-amber-800` chip text drift across components

Same family as M1. Both `ToneChip.amber` and `DataSourceChip.demo` use `text-amber-800`. The toneHeadlineClass amber tone uses `text-amber-700`. Two adjacent components rendering "amber" at two different saturations.

The decision could go either way (collapse to `amber-700` or stay at `amber-800`), but the inconsistency is the finding.

**Rank: Medium.** Cosmetic; resolve once and apply uniformly.

---

### Low

#### L1 — `font-medium` on chips uses Tailwind's medium weight

[page.tsx:1658, 1690](src/app/app/admin/reporting/monthly/page.tsx#L1658) — both chip components carry `font-medium` on the chip text. The typography audit (F16) flagged `font-medium` as an off-spec weight elsewhere on the page. For chips, the spec allows uppercase smallcaps tracking to carry the weight without `font-medium`.

**Rank: Low.** Style detail not strictly color but adjacent.

---

### Conformant — preserve on remediation

These tokens are correctly on-spec and should survive a color repaint:

- **All `club-green-*` tokens** in body copy, eyebrows, headlines, hover states.
- **All `club-cream` / `club-sand` / `club-gold`** tokens across borders, backgrounds, period chip, chapter rail.
- **`text-amber-700`** in `toneHeadlineClass` for amber variance text (spec range).
- **`text-red-700`** in `toneHeadlineClass` for escalation variance text (spec exact match).
- **`text-club-green-800`** in `toneHeadlineClass` for live / favorable variance text (spec exact match).
- **SparkCard stroke `#284829`** on `Course utilization` and `Payroll ratio` — this hex resolves to `club-green-700`, which the spec explicitly names as the sparkline-stroke token.
- **All print-mode CSS** in [globals.css](src/app/globals.css) — color-fidelity rules and page-margin tokens are not color choices.
- **Deep green shell header** (`bg-club-green-900` in [ReportingShell.tsx:89](src/components/reporting/ReportingShell.tsx#L89)).

---

## Summary table

| ID | Element | Where | Current value | Rank |
|---|---|---|---|---|
| C1 | `ToneChip` green tinted bg + ring | [page.tsx:1653](src/app/app/admin/reporting/monthly/page.tsx#L1653) | `bg-club-green-50 ring-club-green-200` | **Critical** |
| C1 | `ToneChip` amber tinted bg + ring | [page.tsx:1654](src/app/app/admin/reporting/monthly/page.tsx#L1654) | `bg-amber-50 ring-amber-200` | **Critical** |
| C1 | `ToneChip` red tinted bg + ring | [page.tsx:1655](src/app/app/admin/reporting/monthly/page.tsx#L1655) | `bg-red-50 ring-red-200` | **Critical** |
| C1 | `DataSourceChip` live tinted bg | [page.tsx:1682](src/app/app/admin/reporting/monthly/page.tsx#L1682) | `bg-club-green-50 ring-club-green-200` | **Critical** |
| C1 | `DataSourceChip` demo tinted bg | [page.tsx:1685](src/app/app/admin/reporting/monthly/page.tsx#L1685) | `bg-amber-50 ring-amber-200` | **Critical** |
| C2 | Stoplight green dot | [page.tsx:1703](src/app/app/admin/reporting/monthly/page.tsx#L1703) | `bg-club-green-500` | **Critical** |
| C2 | Stoplight amber dot | [page.tsx:1704](src/app/app/admin/reporting/monthly/page.tsx#L1704) | `bg-amber-500` | **Critical** |
| C2 | Stoplight red dot | [page.tsx:1705](src/app/app/admin/reporting/monthly/page.tsx#L1705) | `bg-red-500` | **Critical** |
| C3 | Stone neutral dot | [page.tsx:1706](src/app/app/admin/reporting/monthly/page.tsx#L1706) | `bg-stone-300` | **Critical** |
| H1 | Pastel ring colors on tone chips | same as C1 | `ring-{amber,red,club-green}-200` | High |
| H2 | Burnt-orange sparkline stroke | [page.tsx:1181](src/app/app/admin/reporting/monthly/page.tsx#L1181) | `stroke="#a85a1f"` | High |
| M1 | `text-red-800` exceeds spec `red-700` | [page.tsx:1655](src/app/app/admin/reporting/monthly/page.tsx#L1655) | `text-red-800` | Medium |
| M2 | `text-amber-800` inconsistent with `text-amber-700` elsewhere | [page.tsx:1654, 1685](src/app/app/admin/reporting/monthly/page.tsx#L1654) | `text-amber-800` (chips) vs `text-amber-700` (variance text) | Medium |
| L1 | `font-medium` on chip text | [page.tsx:1658, 1690](src/app/app/admin/reporting/monthly/page.tsx#L1658) | `font-medium` | Low |

---

## Proposed replacement palette

The replacement applies the spec's own named tokens. No new tokens are introduced; the design system is preserved as-is. Three component families need repainting: chips, tone dots, sparkline strokes.

### Family 1 — chips (`ToneChip` + `DataSourceChip`)

The unifying principle: **all chips on the report are paper-on-paper**. The chip background is always `club-cream` (or fully transparent); the chip is delineated by a `club-sand` (or restrained `club-gold/40`) ring; the tone is carried entirely by the text color.

| Variant | Background | Ring | Text |
|---|---|---|---|
| Live / favorable / on plan / green | `bg-club-cream` | `ring-club-sand` | `text-club-green-800` |
| Partial / watch / gold | `bg-club-cream` | `ring-club-gold/40` | `text-club-gold` |
| Demo / amber | `bg-club-cream` | `ring-club-sand` | `text-amber-700` |
| Escalate / red | `bg-club-cream` | `ring-club-sand` | `text-red-700` |
| Neutral | `bg-club-cream` | `ring-club-sand` | `text-club-green-800/80` |

Optional alternative — **borderless chip** (most editorial):

| Variant | Background | Text |
|---|---|---|
| Live | none | `text-club-green-800` with a leading `•` glyph in `text-club-green-700` |
| Partial | none | `text-club-gold` with leading `•` in `text-club-gold` |
| Demo | none | `text-amber-700` with leading `•` in `text-amber-700` |

Borderless is the most memo-like; the chip-with-cream-bg-and-sand-ring is the practical compromise.

**Recommendation: chip-with-cream-bg-and-sand-ring.** Keeps the visual affordance for "this is a label" while shedding all pastel SaaS chrome.

---

### Family 2 — tone dots (`dotForTone`)

The dots are small (2-px circles) but render on every KPI tile. The fix is a one-step desaturation (the `-500` step → the `-700` step per spec).

| Tone | Current | Proposed |
|---|---|---|
| Green | `bg-club-green-500` | `bg-club-green-700` |
| Amber | `bg-amber-500` | `bg-amber-700` |
| Red | `bg-red-500` | `bg-red-700` |
| Neutral | `bg-stone-300` | `bg-club-sand` |

---

### Family 3 — sparkline strokes (`SparkCard`)

Three sparklines, currently using two strokes:

| Sparkline | Current stroke | Proposed |
|---|---|---|
| Course utilization (chapter VI) | `#284829` (= `club-green-700`) | unchanged |
| Payroll ratio (chapter VII) | `#284829` (= `club-green-700`) | unchanged |
| F&B subsidy (chapter VIII) | `#a85a1f` (burnt-orange) | **`#b08a4a` (= `club-gold`)** |

Rationale: the F&B subsidy chart is the *one* sparkline where a secondary tone has narrative meaning — *"declining is favorable, but watch the ceiling at 8 % of dues"*. Using `club-gold` (the spec's "watch / partial" tone) makes the choice palette-compliant *and* aligns the stroke color with the chart's narrative purpose.

If a uniform palette is preferred over differentiation, all three sparklines collapse to `club-green-700` — also acceptable per spec.

**Recommendation: F&B subsidy → `club-gold` (`#b08a4a`).** Differentiated, on-spec, narrative-faithful.

---

### Family 4 — text saturation drift cleanup

| Token | Current | Proposed |
|---|---|---|
| `ToneChip.red` text | `text-red-800` | `text-red-700` (matches spec + `toneHeadlineClass`) |
| `ToneChip.amber` text | `text-amber-800` | `text-amber-700` (collapses with `toneHeadlineClass` amber) |
| `DataSourceChip.demo` text | `text-amber-800` | `text-amber-700` (consistency) |

After this collapse, every amber rendering on the page reads at `amber-700` and every red rendering reads at `red-700`. Single named tone per status.

---

## Summary of net change

| Layer | Net effect |
|---|---|
| Chips | Pastel SaaS warning/success/error backgrounds + rings replaced by paper-on-paper cream with restrained sand/gold rings; text carries all the tone signal. |
| Tone dots | Stoplight saturation collapsed one step to the desaturated spec colors (`-700` instead of `-500`). |
| Stone admin neutral | Last `bg-stone-300` token replaced with `bg-club-sand`. |
| Sparkline strokes | One burnt-orange hex replaced with the spec's `club-gold`. |
| Tone text | `text-{red,amber}-800` collapsed to `-700` everywhere for single named tone per status. |

After these edits, the page contains **zero `-500`-tier saturated stoplight colors**, **zero pastel-tinted chip backgrounds**, **zero stone tokens**, and **zero hex-literal strokes outside the named palette**. The entire color surface comes from the spec's six primary tokens plus the four desaturated status tones.

---

## What this audit is not

- This audit does not prescribe a different palette — it applies the design system's own named tokens to elements that have drifted off.
- This audit does not assess color *contrast* for accessibility — `text-amber-700` on `bg-club-cream` should be checked against WCAG AA when remediation lands.
- This audit does not measure rendered colors in DevTools — the squint test and pixel-measurement responsibilities belong to the
  [`executive-reporting-design`](../.claude/skills/executive-reporting-design/SKILL.md) skill.

---

## When this audit is wrong

If the founder reads the audit and decides the current stoplight palette is *correct* — for example, because the chips need to scream "Demo data" loudly enough that a director never mistakes placeholder values for live ones — then the path forward is to amend the design system to allow the bright tones for *that specific purpose*, rather than restyling the chips. The audit exists to expose the gap between the spec and the implementation; resolving the gap by amending either side is acceptable.
