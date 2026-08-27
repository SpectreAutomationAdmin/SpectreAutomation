-- HR portal hero framing (2026-08-26) — normalized focal point + zoom
-- per ClubMedia asset. All columns nullable; a NULL value renders as
-- the Spectre default centered `object-position: 50% 50%` + zoom 1.0.
-- Zero back-fill required: existing rows keep their current visual
-- rendering until a tenant admin saves framing.

ALTER TABLE "ClubMedia" ADD COLUMN "desktopFocalX"    DOUBLE PRECISION;
ALTER TABLE "ClubMedia" ADD COLUMN "desktopFocalY"    DOUBLE PRECISION;
ALTER TABLE "ClubMedia" ADD COLUMN "desktopZoom"      DOUBLE PRECISION;
ALTER TABLE "ClubMedia" ADD COLUMN "mobileFocalX"     DOUBLE PRECISION;
ALTER TABLE "ClubMedia" ADD COLUMN "mobileFocalY"     DOUBLE PRECISION;
ALTER TABLE "ClubMedia" ADD COLUMN "mobileZoom"       DOUBLE PRECISION;
ALTER TABLE "ClubMedia" ADD COLUMN "framingUpdatedAt" TIMESTAMP(3);
ALTER TABLE "ClubMedia" ADD COLUMN "framingUpdatedBy" TEXT;
