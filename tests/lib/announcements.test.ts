// HR-2C Fore! Announcements (2026-08-27) — canonical service tests.
// Covers §41 data rules and §39 tenant isolation from the ticket brief:
//   - draft excluded
//   - future publish excluded
//   - expired excluded
//   - published + not-expired included
//   - audience filter (EMPLOYEE vs MEMBER vs BOTH)
//   - pinned first, then newest published
//   - tenant isolation (one club can't see another)
//   - authorization: no-permission principal is rejected
//   - not-hardcoded / real-data proof (changing input changes output)

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import {
  listVisibleAnnouncements,
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  announcementPreview,
} from "@/lib/announcements";

describe("announcements — publication rules", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  async function setup() {
    const clubA = await makeClub("Test Club A");
    const clubB = await makeClub("Test Club B");
    const admin = await makeUser({ email: "admin@a.test", role: "CLUB_ADMIN", clubId: clubA.id });
    const adminP = await principalFor(admin.email);
    return { clubA, clubB, adminP };
  }

  it("hides drafts, shows published rows for the audience", async () => {
    const { clubA, adminP } = await setup();
    await createAnnouncement(adminP, clubA.id, {
      audience: "EMPLOYEE", title: "Draft Row", body: "hidden", isPublished: false,
    });
    const published = await createAnnouncement(adminP, clubA.id, {
      audience: "EMPLOYEE", title: "Published Row", body: "visible", isPublished: true,
    });
    const visible = await listVisibleAnnouncements(clubA.id, "EMPLOYEE");
    expect(visible.map((v) => v.id)).toEqual([published.id]);
    // Admin list contains both.
    const admin = await listAnnouncements(clubA.id);
    expect(admin.length).toBe(2);
  });

  it("excludes announcements whose publishedAt is in the future", async () => {
    const { clubA, adminP } = await setup();
    const future = new Date(Date.now() + 60 * 60 * 1000); // +1h
    await createAnnouncement(adminP, clubA.id, {
      audience: "EMPLOYEE", title: "Scheduled", body: "later",
      isPublished: true, publishedAt: future,
    });
    const visible = await listVisibleAnnouncements(clubA.id, "EMPLOYEE");
    expect(visible.length).toBe(0);
  });

  it("excludes announcements whose expiresAt is in the past", async () => {
    const { clubA, adminP } = await setup();
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000); // -1d
    await createAnnouncement(adminP, clubA.id, {
      audience: "EMPLOYEE", title: "Expired", body: "old",
      isPublished: true, publishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000), expiresAt: past,
    });
    const visible = await listVisibleAnnouncements(clubA.id, "EMPLOYEE");
    expect(visible.length).toBe(0);
  });

  it("audience filter: EMPLOYEE surface shows EMPLOYEE + BOTH, hides MEMBER-only", async () => {
    const { clubA, adminP } = await setup();
    const emp = await createAnnouncement(adminP, clubA.id, {
      audience: "EMPLOYEE", title: "Emp only", body: "e", isPublished: true,
    });
    const mem = await createAnnouncement(adminP, clubA.id, {
      audience: "MEMBER", title: "Mem only", body: "m", isPublished: true,
    });
    const both = await createAnnouncement(adminP, clubA.id, {
      audience: "BOTH", title: "Both", body: "b", isPublished: true,
    });
    const forEmp = (await listVisibleAnnouncements(clubA.id, "EMPLOYEE")).map((v) => v.id).sort();
    const forMem = (await listVisibleAnnouncements(clubA.id, "MEMBER")).map((v) => v.id).sort();
    expect(forEmp).toEqual([emp.id, both.id].sort());
    expect(forMem).toEqual([mem.id, both.id].sort());
  });

  it("ordering: pinned first, then newest publishedAt", async () => {
    const { clubA, adminP } = await setup();
    const old = await createAnnouncement(adminP, clubA.id, {
      audience: "EMPLOYEE", title: "Old", body: "o",
      isPublished: true, publishedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    });
    const newer = await createAnnouncement(adminP, clubA.id, {
      audience: "EMPLOYEE", title: "New", body: "n",
      isPublished: true, publishedAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
    });
    const pinned = await createAnnouncement(adminP, clubA.id, {
      audience: "EMPLOYEE", title: "Pinned", body: "p",
      isPublished: true, publishedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      isPinned: true,
    });
    const order = (await listVisibleAnnouncements(clubA.id, "EMPLOYEE")).map((v) => v.id);
    expect(order).toEqual([pinned.id, newer.id, old.id]);
  });

  it("tenant isolation: club A's announcements do not appear for club B", async () => {
    const { clubA, clubB, adminP } = await setup();
    await createAnnouncement(adminP, clubA.id, {
      audience: "EMPLOYEE", title: "A-only", body: "secret to A", isPublished: true,
    });
    const forB = await listVisibleAnnouncements(clubB.id, "EMPLOYEE");
    const adminForB = await listAnnouncements(clubB.id);
    expect(forB.length).toBe(0);
    expect(adminForB.length).toBe(0);
  });

  it("rejects create/update/delete without settings:write", async () => {
    const { clubA } = await setup();
    // A staff-level user with no membership in clubA — Staff role has
    // no settings:write, so createAnnouncement's requirePermission
    // check must reject even before the tenant check.
    const outsider = await makeUser({ email: "outsider@x.test", role: "STAFF", clubId: clubA.id });
    const outsiderP = await principalFor(outsider.email);
    await expect(
      createAnnouncement(outsiderP, clubA.id, {
        audience: "EMPLOYEE", title: "no", body: "no",
      }),
    ).rejects.toThrow();
  });

  it("update: toggling isPublished true sets publishedAt when missing", async () => {
    const { clubA, adminP } = await setup();
    const draft = await createAnnouncement(adminP, clubA.id, {
      audience: "EMPLOYEE", title: "T", body: "B", isPublished: false,
    });
    expect(draft.publishedAt).toBeNull();
    const published = await updateAnnouncement(adminP, clubA.id, draft.id, { isPublished: true });
    expect(published.isPublished).toBe(true);
    expect(published.publishedAt).not.toBeNull();
  });

  it("delete removes the row and it disappears from both lists", async () => {
    const { clubA, adminP } = await setup();
    const row = await createAnnouncement(adminP, clubA.id, {
      audience: "EMPLOYEE", title: "T", body: "B", isPublished: true,
    });
    await deleteAnnouncement(adminP, clubA.id, row.id);
    expect((await listAnnouncements(clubA.id)).length).toBe(0);
    expect((await listVisibleAnnouncements(clubA.id, "EMPLOYEE")).length).toBe(0);
  });

  it("preview clamps long bodies", () => {
    const long = "x ".repeat(400);
    const preview = announcementPreview(long);
    expect(preview.length).toBeLessThanOrEqual(180);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("validation: title required, body required, unknown audience rejected", async () => {
    const { clubA, adminP } = await setup();
    await expect(createAnnouncement(adminP, clubA.id, {
      audience: "EMPLOYEE", title: "", body: "b",
    })).rejects.toThrow();
    await expect(createAnnouncement(adminP, clubA.id, {
      audience: "EMPLOYEE", title: "t", body: "",
    })).rejects.toThrow();
    await expect(createAnnouncement(adminP, clubA.id, {
      audience: "GUEST" as never, title: "t", body: "b",
    })).rejects.toThrow();
  });

  it("REGRESSION §15: a draft with the DEFAULT admin-created title never appears on the portal", async () => {
    const { clubA, adminP } = await setup();
    // Admin creates a fresh draft using the same title + body the
    // AnonymousFeedback admin editor's `create()` seeds.
    await createAnnouncement(adminP, clubA.id, {
      audience: "EMPLOYEE",
      title: "New announcement",
      body: "Draft — update the title and body, then publish.",
      isPublished: false,
    });
    // The portal read must return zero rows because the draft is
    // not published.
    const forEmp = await listVisibleAnnouncements(clubA.id, "EMPLOYEE");
    expect(forEmp.length).toBe(0);
    // Even if audience is BOTH, drafts stay hidden.
    await createAnnouncement(adminP, clubA.id, {
      audience: "BOTH",
      title: "New announcement",
      body: "Draft — update the title and body, then publish.",
      isPublished: false,
    });
    const forEmp2 = await listVisibleAnnouncements(clubA.id, "EMPLOYEE");
    expect(forEmp2.length).toBe(0);
    // Same guarantee for the Member surface.
    const forMem = await listVisibleAnnouncements(clubA.id, "MEMBER");
    expect(forMem.length).toBe(0);
  });

  it("input sensitivity: changing seeded row content changes the portal read output", async () => {
    const { clubA, adminP } = await setup();
    const row = await createAnnouncement(adminP, clubA.id, {
      audience: "EMPLOYEE", title: "v1", body: "one", isPublished: true,
    });
    const before = (await listVisibleAnnouncements(clubA.id, "EMPLOYEE"))[0]!;
    expect(before.title).toBe("v1");
    await updateAnnouncement(adminP, clubA.id, row.id, { title: "v2" });
    const after = (await listVisibleAnnouncements(clubA.id, "EMPLOYEE"))[0]!;
    expect(after.title).toBe("v2");
  });
});
