// HR portal hero framing (2026-08-26) — canonical types + renderer for
// Employee Portal hero image framing. Consumed by:
//
//   • EmployeePortalHero (desktop + mobile variants)
//   • HeroFramingEditor (admin preview at both aspect ratios)
//
// The single source of truth so admin preview and live portal can
// never drift apart. Normalized values (0..1 focal point, positive
// zoom scale) so the rendered result survives responsive resizing,
// image swaps, and viewport changes.

/**
 * Per-mode framing — normalized to survive responsive layout, image
 * resolution changes, and tenant swaps.
 *   focalX / focalY   0.0..1.0   (0.5 = image centre)
 *   zoom              1.0..2.5   (1.0 = tightest `object-cover` fit)
 */
export interface HeroFraming {
  focalX: number;
  focalY: number;
  zoom: number;
}

/** Complete framing set for one media asset. */
export interface EmployeePortalHeroFraming {
  desktop: HeroFraming;
  mobile: HeroFraming;
}

export type HeroFramingMode = "desktop" | "mobile";

// ---------------------------------------------------------------------------
// Bounds — enforced by the service, the admin editor, and the
// renderer so no consumer can produce blank canvas around the image.
// ---------------------------------------------------------------------------
export const HERO_FRAMING_BOUNDS = {
  focalMin: 0,
  focalMax: 1,
  zoomMin: 1,
  zoomMax: 2.5,
} as const;

/**
 * Spectre default framing. Applied whenever a `ClubMedia` row has
 * NULL framing values for a mode. Reproduces the pre-feature
 * `object-position: 50% 50%` + `object-cover` behavior EXACTLY —
 * every existing tenant's hero renders identically until an admin
 * explicitly saves new values.
 */
export const DEFAULT_HERO_FRAMING: HeroFraming = {
  focalX: 0.5,
  focalY: 0.5,
  zoom: 1.0,
};

export const DEFAULT_EMPLOYEE_PORTAL_HERO_FRAMING: EmployeePortalHeroFraming = {
  desktop: DEFAULT_HERO_FRAMING,
  mobile: DEFAULT_HERO_FRAMING,
};

/**
 * Clamp a raw HeroFraming to the enforced bounds. Rejects NaN / non-
 * finite inputs by returning the default.
 */
export function clampHeroFraming(raw: Partial<HeroFraming> | null | undefined): HeroFraming {
  if (!raw) return { ...DEFAULT_HERO_FRAMING };
  const focalX = clampFinite(raw.focalX, HERO_FRAMING_BOUNDS.focalMin, HERO_FRAMING_BOUNDS.focalMax, DEFAULT_HERO_FRAMING.focalX);
  const focalY = clampFinite(raw.focalY, HERO_FRAMING_BOUNDS.focalMin, HERO_FRAMING_BOUNDS.focalMax, DEFAULT_HERO_FRAMING.focalY);
  const zoom   = clampFinite(raw.zoom,   HERO_FRAMING_BOUNDS.zoomMin,  HERO_FRAMING_BOUNDS.zoomMax,  DEFAULT_HERO_FRAMING.zoom);
  return { focalX, focalY, zoom };
}

function clampFinite(value: number | null | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// ---------------------------------------------------------------------------
// Shape returned by the persistence layer. Every field is nullable so
// a `ClubMedia` row with no framing yet returns a valid object which
// we treat as "use defaults".
// ---------------------------------------------------------------------------
export interface StoredHeroFramingRow {
  desktopFocalX: number | null;
  desktopFocalY: number | null;
  desktopZoom: number | null;
  mobileFocalX: number | null;
  mobileFocalY: number | null;
  mobileZoom: number | null;
}

/**
 * Convert a stored row (any of the six values may be null) into a
 * complete resolved framing pair. Null values fall through to
 * `DEFAULT_HERO_FRAMING`, so the return value is always renderable.
 */
export function resolveStoredHeroFraming(
  row: StoredHeroFramingRow | null | undefined,
): EmployeePortalHeroFraming {
  if (!row) return { ...DEFAULT_EMPLOYEE_PORTAL_HERO_FRAMING };
  return {
    desktop: clampHeroFraming({
      focalX: row.desktopFocalX ?? DEFAULT_HERO_FRAMING.focalX,
      focalY: row.desktopFocalY ?? DEFAULT_HERO_FRAMING.focalY,
      zoom:   row.desktopZoom   ?? DEFAULT_HERO_FRAMING.zoom,
    }),
    mobile: clampHeroFraming({
      focalX: row.mobileFocalX ?? DEFAULT_HERO_FRAMING.focalX,
      focalY: row.mobileFocalY ?? DEFAULT_HERO_FRAMING.focalY,
      zoom:   row.mobileZoom   ?? DEFAULT_HERO_FRAMING.zoom,
    }),
  };
}

// ---------------------------------------------------------------------------
// Renderer — converts a resolved framing to inline CSS both consumers
// (portal + admin preview) can drop onto the `<img>` element.
//
// Implementation: `object-cover` + `object-position: {x}% {y}%` +
// `transform: scale(zoom)`. The scale is applied via CSS transform
// with `transform-origin: {x}% {y}%` so the zoom pivots around the
// same focal point the admin dragged to — panning + zooming feel
// intuitive.
//
// When zoom === 1.0 the transform is a no-op, which means default
// framing produces exactly the pre-feature CSS (`object-position:
// 50% 50%`) and no unexpected visual delta.
// ---------------------------------------------------------------------------
export interface HeroImageStyle {
  objectFit: "cover";
  objectPosition: string;
  transform?: string;
  transformOrigin?: string;
}

export function heroImageStyle(framing: HeroFraming): HeroImageStyle {
  const clamped = clampHeroFraming(framing);
  const xPct = round2(clamped.focalX * 100);
  const yPct = round2(clamped.focalY * 100);
  const style: HeroImageStyle = {
    objectFit: "cover",
    objectPosition: `${xPct}% ${yPct}%`,
  };
  if (Math.abs(clamped.zoom - 1) > 1e-3) {
    style.transform = `scale(${round3(clamped.zoom)})`;
    style.transformOrigin = `${xPct}% ${yPct}%`;
  }
  return style;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
