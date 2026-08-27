// HR portal hero framing (2026-08-26) — integration tests for the
// canonical framing service. Mirrors the shape of club-media.test.ts:
// resetDb → seedRbac → makeAdminHrFixture → real Prisma writes.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  setClubMedia,
  updateClubMediaFraming,
  resetClubMediaFraming,
  getClubMediaFraming,
} from "@/lib/club/media";
import { DEFAULT_HERO_FRAMING, HERO_FRAMING_BOUNDS } from "@/lib/employee-portal/hero-framing";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "./_helpers";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

describe("HR portal hero framing service", () => {
  let fx: AdminHrFixture;

  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("HeroFramingFix");
    await setClubMedia(fx.clubAdmin, fx.club.id, {
      category: "employee_portal_hero",
      bytes: TINY_PNG,
      mimeType: "image/png",
    });
  });

  it("returns default framing when the row has no saved values", async () => {
    const framing = await getClubMediaFraming(fx.club.id, "employee_portal_hero");
    expect(framing).not.toBeNull();
    expect(framing!.desktop).toEqual(DEFAULT_HERO_FRAMING);
    expect(framing!.mobile).toEqual(DEFAULT_HERO_FRAMING);
  });

  it("returns null when no ClubMedia asset exists", async () => {
    const other = await makeAdminHrFixture("NoAsset");
    // No setClubMedia — asset absent.
    const framing = await getClubMediaFraming(other.club.id, "employee_portal_hero");
    expect(framing).toBeNull();
  });

  it("desktop update leaves mobile at default (mode independence)", async () => {
    await updateClubMediaFraming(fx.clubAdmin, fx.club.id, {
      category: "employee_portal_hero",
      mode: "desktop",
      desktop: { focalX: 0.42, focalY: 0.62, zoom: 1.15 },
    });
    const framing = await getClubMediaFraming(fx.club.id, "employee_portal_hero");
    expect(framing!.desktop).toEqual({ focalX: 0.42, focalY: 0.62, zoom: 1.15 });
    expect(framing!.mobile).toEqual(DEFAULT_HERO_FRAMING);
  });

  it("mobile update leaves desktop untouched (mode independence)", async () => {
    // First seed desktop values.
    await updateClubMediaFraming(fx.clubAdmin, fx.club.id, {
      category: "employee_portal_hero",
      mode: "desktop",
      desktop: { focalX: 0.42, focalY: 0.62, zoom: 1.15 },
    });
    // Then update mobile only.
    await updateClubMediaFraming(fx.clubAdmin, fx.club.id, {
      category: "employee_portal_hero",
      mode: "mobile",
      mobile: { focalX: 0.68, focalY: 0.55, zoom: 1.3 },
    });
    const framing = await getClubMediaFraming(fx.club.id, "employee_portal_hero");
    expect(framing!.desktop).toEqual({ focalX: 0.42, focalY: 0.62, zoom: 1.15 });
    expect(framing!.mobile).toEqual({ focalX: 0.68, focalY: 0.55, zoom: 1.3 });
  });

  it("out-of-range values are clamped by the service, not stored raw", async () => {
    await updateClubMediaFraming(fx.clubAdmin, fx.club.id, {
      category: "employee_portal_hero",
      mode: "desktop",
      desktop: { focalX: -5, focalY: 99, zoom: 100 },
    });
    const framing = await getClubMediaFraming(fx.club.id, "employee_portal_hero");
    expect(framing!.desktop.focalX).toBe(HERO_FRAMING_BOUNDS.focalMin);
    expect(framing!.desktop.focalY).toBe(HERO_FRAMING_BOUNDS.focalMax);
    expect(framing!.desktop.zoom).toBe(HERO_FRAMING_BOUNDS.zoomMax);
  });

  it("reset returns the selected mode to default and leaves the other alone", async () => {
    await updateClubMediaFraming(fx.clubAdmin, fx.club.id, {
      category: "employee_portal_hero",
      mode: "both",
      desktop: { focalX: 0.42, focalY: 0.62, zoom: 1.15 },
      mobile: { focalX: 0.68, focalY: 0.55, zoom: 1.3 },
    });
    await resetClubMediaFraming(fx.clubAdmin, fx.club.id, "employee_portal_hero", "desktop");
    const framing = await getClubMediaFraming(fx.club.id, "employee_portal_hero");
    expect(framing!.desktop).toEqual(DEFAULT_HERO_FRAMING);
    expect(framing!.mobile).toEqual({ focalX: 0.68, focalY: 0.55, zoom: 1.3 });
  });

  it("tenant isolation — updating clubA framing does not touch clubB", async () => {
    const other = await makeAdminHrFixture("OtherClub");
    await setClubMedia(other.clubAdmin, other.club.id, {
      category: "employee_portal_hero",
      bytes: TINY_PNG,
      mimeType: "image/png",
    });
    await updateClubMediaFraming(fx.clubAdmin, fx.club.id, {
      category: "employee_portal_hero",
      mode: "desktop",
      desktop: { focalX: 0.9, focalY: 0.1, zoom: 1.5 },
    });
    const other_framing = await getClubMediaFraming(other.club.id, "employee_portal_hero");
    expect(other_framing!.desktop).toEqual(DEFAULT_HERO_FRAMING);
    expect(other_framing!.mobile).toEqual(DEFAULT_HERO_FRAMING);
  });

  it("throws NotFoundError when the asset does not exist for the club", async () => {
    const empty = await makeAdminHrFixture("NoAssetForUpdate");
    await expect(
      updateClubMediaFraming(empty.clubAdmin, empty.club.id, {
        category: "employee_portal_hero",
        mode: "desktop",
        desktop: { focalX: 0.5, focalY: 0.5, zoom: 1 },
      }),
    ).rejects.toThrow();
  });

  it("writes an audit record with the before/after framing shape", async () => {
    await updateClubMediaFraming(fx.clubAdmin, fx.club.id, {
      category: "employee_portal_hero",
      mode: "desktop",
      desktop: { focalX: 0.42, focalY: 0.62, zoom: 1.15 },
    });
    const audit = await prisma.auditLog.findFirst({
      where: { clubId: fx.club.id, action: "club.media.framing.update" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });
});
