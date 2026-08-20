// HR-2C §2, §41, §53 — Club media service (Employee Portal hero image).
//
// The service owns tenant + permission + MIME + size discipline for
// per-Club assets. Every write goes through `setClubMedia`; the proxy
// route is a thin wrapper. These tests pin the invariants the founder
// specified in §41 (private delivery, cross-tenant refused) and §2
// (canonical storage adapter, no isolated stack).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  setClubMedia,
  getClubMedia,
  clearClubMedia,
  readClubMediaBytes,
  CLUB_MEDIA_MAX_BYTES,
} from "@/lib/club/media";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "./_helpers";

// 1x1 PNG (transparent). Same bytes the founder-journey Playwright
// spec uses for profile-photo uploads.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

describe("HR-2C · ClubMedia service", () => {
  let fx: AdminHrFixture;

  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("HR2CMediaFix");
  });

  it("CLUB_ADMIN can upload an employee_portal_hero image", async () => {
    const result = await setClubMedia(fx.clubAdmin, fx.club.id, {
      category: "employee_portal_hero",
      bytes: TINY_PNG,
      mimeType: "image/png",
      displayName: "clubhouse.png",
    });
    expect(result.id).toBeTruthy();
    expect(result.category).toBe("employee_portal_hero");
    expect(result.storageKey).toMatch(new RegExp(`^clubs/${fx.club.id}/media/employee_portal_hero/`));

    const row = await getClubMedia(fx.club.id, "employee_portal_hero");
    expect(row).not.toBeNull();
    expect(row!.mimeType).toBe("image/png");
    expect(row!.sizeBytes).toBe(TINY_PNG.length);
  });

  it("re-upload REPLACES the same (clubId, category) row (upsert semantics)", async () => {
    await setClubMedia(fx.clubAdmin, fx.club.id, {
      category: "employee_portal_hero",
      bytes: TINY_PNG, mimeType: "image/png",
    });
    // Second byte-different image.
    const alt = Buffer.concat([TINY_PNG, Buffer.from([0x00, 0x01])]);
    await setClubMedia(fx.clubAdmin, fx.club.id, {
      category: "employee_portal_hero",
      bytes: alt, mimeType: "image/png",
    });
    const rows = await prisma.clubMedia.count({
      where: { clubId: fx.club.id, category: "employee_portal_hero" },
    });
    expect(rows).toBe(1);
  });

  it("bytes come back through readClubMediaBytes for the same clubId", async () => {
    await setClubMedia(fx.clubAdmin, fx.club.id, {
      category: "employee_portal_hero", bytes: TINY_PNG, mimeType: "image/png",
    });
    const asset = await readClubMediaBytes(fx.club.id, "employee_portal_hero");
    expect(asset).not.toBeNull();
    expect(asset!.mimeType).toBe("image/png");
    expect(asset!.bytes.equals(TINY_PNG)).toBe(true);
  });

  it("readClubMediaBytes for a DIFFERENT club never leaks bytes", async () => {
    await setClubMedia(fx.clubAdmin, fx.club.id, {
      category: "employee_portal_hero", bytes: TINY_PNG, mimeType: "image/png",
    });
    const cross = await readClubMediaBytes(fx.foreignClub.id, "employee_portal_hero");
    expect(cross).toBeNull();
  });

  it("AUDITOR_READ_ONLY cannot write hero image (settings:write refused)", async () => {
    await expect(
      setClubMedia(fx.auditor, fx.club.id, {
        category: "employee_portal_hero", bytes: TINY_PNG, mimeType: "image/png",
      }),
    ).rejects.toThrow(/permission/i);
  });

  it("cross-club write refused (settings:write is club-scoped)", async () => {
    await expect(
      setClubMedia(fx.foreignClubAdmin, fx.club.id, {
        category: "employee_portal_hero", bytes: TINY_PNG, mimeType: "image/png",
      }),
    ).rejects.toThrow(/permission/i);
  });

  it("unknown category rejected", async () => {
    let caught: unknown;
    try {
      await setClubMedia(fx.clubAdmin, fx.club.id, {
        category: "nonexistent_category" as unknown as "employee_portal_hero",
        bytes: TINY_PNG, mimeType: "image/png",
      });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { issues?: Array<{ message: string }> }).issues?.[0]?.message).toMatch(/must be one of/i);
  });

  it("disallowed MIME rejected", async () => {
    let caught: unknown;
    try {
      await setClubMedia(fx.clubAdmin, fx.club.id, {
        category: "employee_portal_hero",
        bytes: TINY_PNG, mimeType: "application/pdf",
      });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { issues?: Array<{ message: string }> }).issues?.[0]?.message).toMatch(/JPEG|PNG|WEBP|HEIC/i);
  });

  it("empty file rejected", async () => {
    let caught: unknown;
    try {
      await setClubMedia(fx.clubAdmin, fx.club.id, {
        category: "employee_portal_hero", bytes: Buffer.alloc(0), mimeType: "image/png",
      });
    } catch (err) { caught = err; }
    expect((caught as { issues?: Array<{ message: string }> }).issues?.[0]?.message).toMatch(/empty/i);
  });

  it("oversized file rejected", async () => {
    const oversized = Buffer.alloc(CLUB_MEDIA_MAX_BYTES + 1);
    let caught: unknown;
    try {
      await setClubMedia(fx.clubAdmin, fx.club.id, {
        category: "employee_portal_hero", bytes: oversized, mimeType: "image/png",
      });
    } catch (err) { caught = err; }
    expect((caught as { issues?: Array<{ message: string }> }).issues?.[0]?.message).toMatch(/limit/i);
  });

  it("clearClubMedia removes the row + is idempotent", async () => {
    await setClubMedia(fx.clubAdmin, fx.club.id, {
      category: "employee_portal_hero", bytes: TINY_PNG, mimeType: "image/png",
    });
    const first = await clearClubMedia(fx.clubAdmin, fx.club.id, "employee_portal_hero");
    expect(first.cleared).toBe(true);
    const second = await clearClubMedia(fx.clubAdmin, fx.club.id, "employee_portal_hero");
    expect(second.cleared).toBe(false);
    const row = await getClubMedia(fx.club.id, "employee_portal_hero");
    expect(row).toBeNull();
  });

  it("upload writes a club.media.update audit row with the sha256 (no bytes)", async () => {
    await setClubMedia(fx.clubAdmin, fx.club.id, {
      category: "employee_portal_hero", bytes: TINY_PNG, mimeType: "image/png",
    });
    const audit = await prisma.auditLog.findFirst({
      where: { action: "club.media.update" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    const serialized = JSON.stringify(audit);
    // Audit records sha256 + size + mime — never the raw base64 bytes.
    expect(serialized).toContain("employee_portal_hero");
    expect(serialized).not.toContain(TINY_PNG.toString("base64"));
  });
});
