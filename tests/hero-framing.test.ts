// HR portal hero framing (2026-08-26) — pure-function tests for the
// shared renderer + resolver. The renderer is the single source of
// truth for both the Employee Portal live hero AND the admin editor
// preview; if this test suite passes, the two surfaces cannot drift.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_EMPLOYEE_PORTAL_HERO_FRAMING,
  DEFAULT_HERO_FRAMING,
  HERO_FRAMING_BOUNDS,
  clampHeroFraming,
  heroImageStyle,
  resolveStoredHeroFraming,
} from "@/lib/employee-portal/hero-framing";

describe("clampHeroFraming — bounds enforcement", () => {
  it("returns defaults for null input", () => {
    expect(clampHeroFraming(null)).toEqual(DEFAULT_HERO_FRAMING);
    expect(clampHeroFraming(undefined)).toEqual(DEFAULT_HERO_FRAMING);
  });

  it("clamps focal below 0 to 0 and above 1 to 1", () => {
    expect(clampHeroFraming({ focalX: -0.5, focalY: 2.0, zoom: 1 })).toEqual({
      focalX: 0, focalY: 1, zoom: 1,
    });
  });

  it("clamps zoom to configured bounds", () => {
    expect(clampHeroFraming({ focalX: 0.5, focalY: 0.5, zoom: 0.1 })).toEqual({
      focalX: 0.5, focalY: 0.5, zoom: HERO_FRAMING_BOUNDS.zoomMin,
    });
    expect(clampHeroFraming({ focalX: 0.5, focalY: 0.5, zoom: 99 })).toEqual({
      focalX: 0.5, focalY: 0.5, zoom: HERO_FRAMING_BOUNDS.zoomMax,
    });
  });

  it("rejects NaN and non-finite values by using defaults", () => {
    expect(clampHeroFraming({ focalX: NaN, focalY: Infinity, zoom: -Infinity })).toEqual(
      DEFAULT_HERO_FRAMING,
    );
  });

  it("preserves in-range values", () => {
    expect(clampHeroFraming({ focalX: 0.3, focalY: 0.7, zoom: 1.5 })).toEqual({
      focalX: 0.3, focalY: 0.7, zoom: 1.5,
    });
  });
});

describe("resolveStoredHeroFraming — null → defaults", () => {
  it("returns both-defaults when row is null (no ClubMedia exists)", () => {
    expect(resolveStoredHeroFraming(null)).toEqual(DEFAULT_EMPLOYEE_PORTAL_HERO_FRAMING);
  });

  it("returns defaults when all six columns are null (row exists, no framing saved)", () => {
    expect(
      resolveStoredHeroFraming({
        desktopFocalX: null, desktopFocalY: null, desktopZoom: null,
        mobileFocalX: null, mobileFocalY: null, mobileZoom: null,
      }),
    ).toEqual(DEFAULT_EMPLOYEE_PORTAL_HERO_FRAMING);
  });

  it("consumes saved desktop values without affecting mobile", () => {
    const result = resolveStoredHeroFraming({
      desktopFocalX: 0.42, desktopFocalY: 0.62, desktopZoom: 1.15,
      mobileFocalX: null, mobileFocalY: null, mobileZoom: null,
    });
    expect(result.desktop).toEqual({ focalX: 0.42, focalY: 0.62, zoom: 1.15 });
    expect(result.mobile).toEqual(DEFAULT_HERO_FRAMING);
  });

  it("consumes saved mobile values without affecting desktop", () => {
    const result = resolveStoredHeroFraming({
      desktopFocalX: null, desktopFocalY: null, desktopZoom: null,
      mobileFocalX: 0.68, mobileFocalY: 0.55, mobileZoom: 1.3,
    });
    expect(result.mobile).toEqual({ focalX: 0.68, focalY: 0.55, zoom: 1.3 });
    expect(result.desktop).toEqual(DEFAULT_HERO_FRAMING);
  });

  it("clamps out-of-range persisted values (server-side belt-and-braces)", () => {
    const result = resolveStoredHeroFraming({
      desktopFocalX: -1, desktopFocalY: 2, desktopZoom: 99,
      mobileFocalX: 5, mobileFocalY: -5, mobileZoom: 0.1,
    });
    expect(result.desktop.focalX).toBe(0);
    expect(result.desktop.focalY).toBe(1);
    expect(result.desktop.zoom).toBe(HERO_FRAMING_BOUNDS.zoomMax);
    expect(result.mobile.zoom).toBe(HERO_FRAMING_BOUNDS.zoomMin);
  });
});

describe("heroImageStyle — CSS reproduction of the pre-feature default", () => {
  it("default framing produces object-position 50% 50% and NO transform", () => {
    const s = heroImageStyle(DEFAULT_HERO_FRAMING);
    expect(s.objectFit).toBe("cover");
    expect(s.objectPosition).toBe("50% 50%");
    expect(s.transform).toBeUndefined();
    expect(s.transformOrigin).toBeUndefined();
  });

  it("focal 0.42/0.62 renders as 42%/62%", () => {
    const s = heroImageStyle({ focalX: 0.42, focalY: 0.62, zoom: 1 });
    expect(s.objectPosition).toBe("42% 62%");
  });

  it("zoom > 1 produces a matching CSS transform pinned to the focal point", () => {
    const s = heroImageStyle({ focalX: 0.3, focalY: 0.7, zoom: 1.25 });
    expect(s.objectPosition).toBe("30% 70%");
    expect(s.transform).toBe("scale(1.25)");
    expect(s.transformOrigin).toBe("30% 70%");
  });

  it("zoom exactly 1.0 skips the transform (no unnecessary render layer)", () => {
    const s = heroImageStyle({ focalX: 0.5, focalY: 0.5, zoom: 1.0 });
    expect(s.transform).toBeUndefined();
  });

  it("out-of-range values are clamped before rendering", () => {
    const s = heroImageStyle({ focalX: 5, focalY: -1, zoom: 99 });
    expect(s.objectPosition).toBe("100% 0%");
    expect(s.transform).toBe(`scale(${HERO_FRAMING_BOUNDS.zoomMax})`);
  });
});
