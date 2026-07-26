# Board Attention Engine

The Board Attention Engine surfaces a universal three-state verdict
(**GREEN / YELLOW / RED**) across the five Chair's Dashboard pillar
panels in the Monthly Board Reporting Package. The chair sees where
attention is required **before** reading any number.

This document is the API + threshold-authoring guide. It composes
with three other reporting standards:

| Layer | Document |
|---|---|
| 1 — what reports must answer | [docs/spectre-framework.md](spectre-framework.md) |
| 2 — how reports must look | [docs/spectre-executive-reporting-design-system.md](spectre-executive-reporting-design-system.md) |
| 3 — what must be visible above the fold | [docs/spectre-first-scroll-reporting-standard.md](spectre-first-scroll-reporting-standard.md) |
| 4 — **how attention is computed (this document)** | docs/board-attention-engine.md |

## Scope

This pass wires the engine into:

1. The five Chair's Dashboard pillar panels (chapters III–VII):
   - III · Operations
   - IV · Financial Health
   - V · Capital
   - VI · Membership Health
   - VII · Experience Health
2. The Chair's Dashboard rollup ribbon (chapter II)
3. The cover Executive Briefing column compact attention indicator

The engine is **not** wired into the 11 downstream chapters (Board
Briefing, At-a-Glance KPIs, Financial Statements, the long-form
stewardship chapters, etc.) — those chapters carry their own
narrative + commentary structures. The chair's first reads at the
top of the package are where the attention engine earns its keep;
extending later is a future PR.

## Architecture

```
src/lib/reporting/attention/
  ├─ types.ts         Attention | "green" | "yellow" | "red"
  │                   ThresholdRule (4 kinds)
  │                   Thresholds map · PillarKey
  │
  ├─ thresholds.ts    DEFAULT_THRESHOLDS — central registry of
  │                   green/yellow/red bands per metric
  │
  ├─ engine.ts        evaluateMetric(key, value, overrides?) → Attention
  │                   evaluateRule(rule, value) → Attention
  │
  ├─ rollup.ts        worstOf · rollupChapter · rollupDashboard · countFlagged
  │
  ├─ labels.ts        labelFor(pillar, attention) → pillar-specific label
  │                   kpiToneFor(attention) → KpiTone (legacy palette mapping)
  │
  └─ index.ts         Barrel export
```

The engine is a **pure-function module** — no React, no DOM, no
network, no time. Trivially unit-testable.

## Threshold rules

Four rule shapes cover every metric in the package today:

| Rule kind | When to use | Example |
|---|---|---|
| `higher-better`  | Reading is favorable when above a floor; defines a floor + a hard-red threshold | Working Capital ($M); higher is better. greenAt: 3.50, redAt: 3.00 |
| `lower-better`   | Reading is favorable when below a ceiling; defines a ceiling + a hard-red threshold | Attrition rate; lower is better. greenAt: 6, redAt: 8 |
| `band-bounded`   | Reading is favorable inside a policy band; defines [min, max] + tolerance | Dues-to-Revenue inside 38–44% band, tolerance 2 |
| `vs-benchmark`   | Reading is a signed variance % vs benchmark; defines a favorable floor + a hard-red floor | Revenue +3.7% above plan. greenAtPct: 0, redAtPct: -5 |

```ts
type ThresholdRule =
  | { kind: "higher-better"; greenAt: number; redAt: number }
  | { kind: "lower-better";  greenAt: number; redAt: number }
  | { kind: "band-bounded";  min: number; max: number; tolerance: number }
  | { kind: "vs-benchmark";  greenAtPct: number; redAtPct: number };
```

## The engine API

```ts
import { evaluateMetric, rollupChapter, rollupDashboard,
         labelFor, kpiToneFor } from "@/lib/reporting/attention";

// Per-metric verdict.
const arAttention = evaluateMetric("financial.ar-current", 78.4);
// → "yellow" (78.4 < 80% greenAt floor)

// Pillar-specific status label.
const label = labelFor("financial", arAttention);
// → "Stable"

// KpiTone (legacy palette mapping).
const tone = kpiToneFor(arAttention);
// → "amber"

// Chapter-level rollup (worst-of the tile verdicts).
const chapterVerdict = rollupChapter(["green", "green", "yellow", "green"]);
// → "yellow"

// Dashboard-level rollup (worst-of the chapter verdicts).
const dashboardVerdict = rollupDashboard(["green", "yellow", "yellow", "yellow", "yellow"]);
// → "yellow"
```

## Pillar-specific labels

The engine produces a universal three-state verdict. Each pillar
renders that verdict in its own vocabulary (the executive reporting
voice; do not flatten to generic Green/Yellow/Red).

| Pillar | GREEN | YELLOW | RED |
|---|---|---|---|
| Operations | On Plan | Watch | Off Plan |
| Financial Health | Strong Position | Stable | Concern |
| Capital | Executing | Monitor | Delayed |
| Membership Health | Healthy | Watch | At Risk |
| Experience Health | Healthy | Watch | Concern |

## Authoring thresholds

Today the config is a TypeScript const at
[`src/lib/reporting/attention/thresholds.ts`](../src/lib/reporting/attention/thresholds.ts).

To retune a band, edit the value and re-run vitest. Conventions:

- Money values are in millions ($M) where the displayed unit is
  "$X.XXM"; otherwise in the displayed unit.
- `vs-benchmark` thresholds are signed percentage points: `+3.7`
  means "3.7% above benchmark"; `-5` means "5% below benchmark".
- `band-bounded.tolerance` is in the same unit as `min/max`. A
  reading within tolerance of either edge of `[min, max]` is YELLOW.

### Future migration path

The engine signature already accepts a `Thresholds` override:

```ts
evaluateMetric(key: string, value: number, overrides?: Thresholds): Attention
```

When a per-club override lands in Prisma as `Club.attentionThresholds: Json?`,
the service merges the per-club overrides on top of `DEFAULT_THRESHOLDS`
and passes the merged set into `evaluateMetric()`. No panel-side change
is required.

## UI surfacing

The engine drives three visible artifacts in the package:

### 1. Per-tile status badge

Each tile in a pillar panel renders a tone-coloured status badge
under its hero number (the existing visual status indicator pattern).
The badge text is `labelFor(pillar, attention)`; the badge colour
is `toneStatusChipClass(kpiToneFor(attention))`.

### 2. Chapter attention ribbon

A `ChapterAttentionRibbon` component renders above the 4-tile grid
of every pillar panel. Anatomy:

- smallcaps eyebrow ("Board attention")
- tone dot (engine's three-state colour)
- universal verdict ("GREEN" / "YELLOW" / "RED")
- summary count ("3 of 4 metrics flagged" or "All 4 metrics on plan")

Treatment is intentionally restrained — no SaaS-style alert banner,
no gradients, no emoji. The ribbon reads as a print-document
register, not as a notification UI.

### 3. Dashboard rollup ribbon (Chair's Dashboard top)

A `DashboardAttentionRollup` component renders above the 5-pillar
card grid on chapter II. Slightly larger verdict font + "X of 5
pillars flagged" summary so the chair's command-centre signal is
unmistakable.

### 4. Cover Executive Briefing compact indicator

A compact inline attention indicator sits in the eyebrow row of the
cover Executive Briefing column:

```
EXECUTIVE BRIEFING · ● YELLOW              MAY 2026
─────────────────────────────────────────────────────
[three briefing cards]
```

This answers the first-scroll standard's *"required actions / board
attention"* question without crowding the cover at 1280×800.

## Required Claude behaviour

When modifying a pillar panel or the engine:

1. State which pillar(s) the change touches.
2. State whether you are editing thresholds (config) or rule logic
   (engine) — never mix the two in the same PR.
3. Run `npx vitest run tests/lib/attention-engine.test.ts` first.
4. Run the full vitest source-contract suite to confirm the chapter
   ribbon + dashboard rollup still render.
5. Capture a Playwright screenshot of the affected panel; verify the
   verdict matches the change.
