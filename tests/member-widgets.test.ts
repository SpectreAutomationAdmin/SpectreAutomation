// Member-hub widget service tests.
//
// Verifies:
//   - First-visit seeding of the default widget set
//   - Reorder persists and disables widgets not in the order list
//   - Add inserts at the end of the current enabled order (no surprise jump)
//   - Remove is a soft delete (row preserved)
//   - Cross-tenant edit attempts are rejected
//   - Unknown widget keys are rejected

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeMember, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import {
  listForMember, addWidget, removeWidget, reorderWidgets, setWidgetSize,
  defaultEnabledKeys, WIDGET_CATALOG, widgetEntry,
} from "@/lib/member-widgets";

describe("member-widgets — service", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("first visit seeds the default widget set", async () => {
    const club = await bootstrapAPClub("WID-1");
    const member = await makeMember(club.id);
    const first = await listForMember(member.id);
    expect(first.length).toBeGreaterThan(0);
    const keys = first.map((w) => w.widgetType).sort();
    expect(keys).toEqual(defaultEnabledKeys().sort());
    // Second call should NOT re-seed.
    const dbCount = await db().dashboardWidget.count({ where: { memberId: member.id } });
    const second = await listForMember(member.id);
    expect(second.length).toBe(first.length);
    expect(await db().dashboardWidget.count({ where: { memberId: member.id } })).toBe(dbCount);
  });

  it("reorder persists and orders the saved widgets", async () => {
    const club = await bootstrapAPClub("WID-2");
    const member = await makeMember(club.id);
    await listForMember(member.id); // seed
    const desired = ["UPCOMING_EVENTS", "ACCOUNT_BALANCE", "WEATHER"];
    await reorderWidgets({
      principalMemberId: member.id, memberId: member.id, orderedKeys: desired,
    });
    const after = await listForMember(member.id);
    const visible = after.filter((w) => w.enabled).map((w) => w.widgetType);
    expect(visible.slice(0, 3)).toEqual(desired);
  });

  it("reorder disables widgets not present in the supplied order", async () => {
    const club = await bootstrapAPClub("WID-3");
    const member = await makeMember(club.id);
    await listForMember(member.id);
    const keepOnly = ["ACCOUNT_BALANCE"];
    await reorderWidgets({ principalMemberId: member.id, memberId: member.id, orderedKeys: keepOnly });
    const after = await listForMember(member.id);
    const visible = after.filter((w) => w.enabled).map((w) => w.widgetType);
    expect(visible).toEqual(keepOnly);
    // Rows for the others should still exist, just enabled=false.
    const allRows = await db().dashboardWidget.findMany({ where: { memberId: member.id } });
    const disabled = allRows.filter((r) => !r.enabled).map((r) => r.widgetType).sort();
    expect(disabled.length).toBeGreaterThan(0);
  });

  it("add inserts a widget at the end of the visible order", async () => {
    const club = await bootstrapAPClub("WID-4");
    const member = await makeMember(club.id);
    await listForMember(member.id);
    const before = await listForMember(member.id);
    const beforeCount = before.filter((w) => w.enabled).length;
    // DRIVING_RANGE_CAMERA is not in defaults; should be added.
    await addWidget({ principalMemberId: member.id, memberId: member.id, widgetType: "DRIVING_RANGE_CAMERA" });
    const after = await listForMember(member.id);
    const visible = after.filter((w) => w.enabled);
    expect(visible.length).toBe(beforeCount + 1);
    expect(visible[visible.length - 1].widgetType).toBe("DRIVING_RANGE_CAMERA");
  });

  it("add is idempotent — re-adding doesn't duplicate the row", async () => {
    const club = await bootstrapAPClub("WID-5");
    const member = await makeMember(club.id);
    await listForMember(member.id);
    await addWidget({ principalMemberId: member.id, memberId: member.id, widgetType: "LEAGUES" });
    await addWidget({ principalMemberId: member.id, memberId: member.id, widgetType: "LEAGUES" });
    const rows = await db().dashboardWidget.findMany({
      where: { memberId: member.id, widgetType: "LEAGUES" },
    });
    expect(rows.length).toBe(1);
  });

  it("remove is a soft delete and is idempotent", async () => {
    const club = await bootstrapAPClub("WID-6");
    const member = await makeMember(club.id);
    await listForMember(member.id);
    await removeWidget({ principalMemberId: member.id, memberId: member.id, widgetType: "WEATHER" });
    const after = await listForMember(member.id);
    expect(after.find((w) => w.widgetType === "WEATHER")?.enabled).toBe(false);
    // Idempotent — calling again doesn't error.
    await removeWidget({ principalMemberId: member.id, memberId: member.id, widgetType: "WEATHER" });
    await removeWidget({ principalMemberId: member.id, memberId: member.id, widgetType: "NEVER_ADDED_BEFORE" as never })
      .catch((e) => expect(e).toBeInstanceOf(ValidationError));
  });

  it("rejects cross-member edits", async () => {
    const club = await bootstrapAPClub("WID-7");
    const m1 = await makeMember(club.id);
    const m2 = await makeMember(club.id);
    await expect(reorderWidgets({
      principalMemberId: m1.id, memberId: m2.id, orderedKeys: ["WEATHER"],
    })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addWidget({
      principalMemberId: m1.id, memberId: m2.id, widgetType: "WEATHER",
    })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeWidget({
      principalMemberId: m1.id, memberId: m2.id, widgetType: "WEATHER",
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects unknown widget keys on add", async () => {
    const club = await bootstrapAPClub("WID-8");
    const member = await makeMember(club.id);
    await listForMember(member.id);
    await expect(addWidget({
      principalMemberId: member.id, memberId: member.id, widgetType: "NOT_A_WIDGET",
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("catalog is non-empty and every key has a unique title", () => {
    expect(WIDGET_CATALOG.length).toBeGreaterThan(5);
    const titles = WIDGET_CATALOG.map((w) => w.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("seeds each widget with its catalog defaultSize, not a uniform default", async () => {
    const club = await bootstrapAPClub("WID-S1");
    const member = await makeMember(club.id);
    const seeded = await listForMember(member.id);
    expect(seeded.length).toBeGreaterThan(0);
    // Every default-enabled widget should land at its catalog defaultSize.
    for (const w of seeded) {
      expect(w.size).toBe(widgetEntry(w.widgetType).defaultSize);
    }
  });

  it("setWidgetSize toggles COMPACT <-> DETAILED and persists", async () => {
    const club = await bootstrapAPClub("WID-S2");
    const member = await makeMember(club.id);
    await listForMember(member.id);
    await setWidgetSize({
      principalMemberId: member.id, memberId: member.id,
      widgetType: "ACCOUNT_BALANCE", size: "COMPACT",
    });
    const a = (await listForMember(member.id)).find((w) => w.widgetType === "ACCOUNT_BALANCE");
    expect(a?.size).toBe("COMPACT");
    await setWidgetSize({
      principalMemberId: member.id, memberId: member.id,
      widgetType: "ACCOUNT_BALANCE", size: "DETAILED",
    });
    const b = (await listForMember(member.id)).find((w) => w.widgetType === "ACCOUNT_BALANCE");
    expect(b?.size).toBe("DETAILED");
  });

  it("setWidgetSize rejects unknown sizes and cross-member edits", async () => {
    const club = await bootstrapAPClub("WID-S3");
    const m1 = await makeMember(club.id);
    const m2 = await makeMember(club.id);
    await listForMember(m1.id);
    await expect(setWidgetSize({
      principalMemberId: m1.id, memberId: m1.id,
      widgetType: "ACCOUNT_BALANCE", size: "GIANT",
    })).rejects.toBeInstanceOf(ValidationError);
    await expect(setWidgetSize({
      principalMemberId: m1.id, memberId: m2.id,
      widgetType: "ACCOUNT_BALANCE", size: "COMPACT",
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("setWidgetSize refuses when the widget is not on the hub", async () => {
    const club = await bootstrapAPClub("WID-S4");
    const member = await makeMember(club.id);
    await listForMember(member.id);
    // DRIVING_RANGE_CAMERA is not a default — it isn't on the hub yet.
    await expect(setWidgetSize({
      principalMemberId: member.id, memberId: member.id,
      widgetType: "DRIVING_RANGE_CAMERA", size: "COMPACT",
    })).rejects.toBeInstanceOf(ValidationError);
  });
});
