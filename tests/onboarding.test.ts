import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ensureChecklistForMember, completeItem } from "@/lib/services/onboarding";
import { db, makeClub, makeMember, makeUser, resetDb, seedRbac, principalFor } from "./util/db";
import { ValidationError } from "@/lib/errors";

describe("Onboarding — checklist + completion", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("seeds a default checklist exactly once", async () => {
    const club = await makeClub("Onb");
    const m = await makeMember(club.id);
    await ensureChecklistForMember(m.id);
    await ensureChecklistForMember(m.id); // idempotent
    const items = await db().onboardingChecklistItem.findMany({ where: { memberId: m.id } });
    expect(items.length).toBeGreaterThanOrEqual(5);
  });

  it("completes individual items as the member themselves", async () => {
    const club = await makeClub("OnbSelf");
    const m = await makeMember(club.id);
    await db().member.update({ where: { id: m.id }, data: { status: "ONBOARDING" } });
    await makeUser({ email: "me@example.com", role: "MEMBER", clubId: club.id, memberId: m.id });
    const self = await principalFor("me@example.com");

    await ensureChecklistForMember(m.id);
    await completeItem(self, m.id, "WELCOME");
    const item = await db().onboardingChecklistItem.findUnique({
      where: { memberId_itemKey: { memberId: m.id, itemKey: "WELCOME" } },
    });
    expect(item?.completedAt).not.toBeNull();
  });

  it("COMPLETED requires all required items first; once met, member becomes ACTIVE", async () => {
    const club = await makeClub("OnbDone");
    const m = await makeMember(club.id);
    await db().member.update({ where: { id: m.id }, data: { status: "ONBOARDING" } });
    await makeUser({ email: "admin@example.com", role: "CLUB_ADMIN", clubId: club.id });
    const admin = await principalFor("admin@example.com");

    await ensureChecklistForMember(m.id);

    // Try to skip ahead.
    await expect(completeItem(admin, m.id, "COMPLETED")).rejects.toBeInstanceOf(ValidationError);

    // Complete the required items in order.
    const required = await db().onboardingChecklistItem.findMany({ where: { memberId: m.id, required: true } });
    for (const it of required) {
      if (it.itemKey === "COMPLETED") continue;
      await completeItem(admin, m.id, it.itemKey);
    }
    await completeItem(admin, m.id, "COMPLETED");

    const m2 = await db().member.findUnique({ where: { id: m.id } });
    expect(m2?.status).toBe("ACTIVE");
    expect(m2?.onboardingCompletedAt).not.toBeNull();
  });
});
