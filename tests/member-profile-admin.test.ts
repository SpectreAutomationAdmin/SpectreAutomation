// Admin-side profile edits: birthday, address, and contact info.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { updateProfile } from "@/lib/services/member-profile";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { db, makeClub, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";

describe("Member profile — admin edits (Phase 18)", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });

  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("Club Admin can update email, phone, birthday, and full address", async () => {
    const club = await makeClub("Cedar Hills");
    await makeUser({ email: "admin@cedar.test", role: "CLUB_ADMIN", clubId: club.id });
    const principal = await principalFor("admin@cedar.test");
    const member = await makeMember(club.id);

    await updateProfile(principal, member.id, {
      email: "newaddress@example.com",
      phone: "555-0142",
      dateOfBirth: "1972-04-18",
      addressLine1: "1 Fairway Drive",
      addressLine2: "Suite 200",
      city: "Halifax",
      state: "NS",
      postalCode: "B3J 1A1",
      country: "Canada",
    });

    const after = await db().member.findUnique({ where: { id: member.id } });
    expect(after?.email).toBe("newaddress@example.com");
    expect(after?.phone).toBe("555-0142");
    expect(after?.dateOfBirth?.toISOString().slice(0, 10)).toBe("1972-04-18");
    expect(after?.addressLine1).toBe("1 Fairway Drive");
    expect(after?.addressLine2).toBe("Suite 200");
    expect(after?.city).toBe("Halifax");
    expect(after?.state).toBe("NS");
    expect(after?.postalCode).toBe("B3J 1A1");
    expect(after?.country).toBe("Canada");

    const auditRows = await db().auditLog.findMany({
      where: { entityType: "Member", entityId: member.id, action: "member.profile.update" },
    });
    expect(auditRows.length).toBe(1);
  });

  it("blank string fields clear the column to null (not empty string)", async () => {
    const club = await makeClub("Cedar Hills");
    await makeUser({ email: "admin@cedar.test", role: "CLUB_ADMIN", clubId: club.id });
    const principal = await principalFor("admin@cedar.test");
    const member = await makeMember(club.id);

    // Seed values, then blank them.
    await db().member.update({
      where: { id: member.id },
      data: { addressLine1: "OLD", city: "OLD", dateOfBirth: new Date("1980-01-01") },
    });

    await updateProfile(principal, member.id, {
      addressLine1: "",
      city: "",
      dateOfBirth: "",
    });

    const after = await db().member.findUnique({ where: { id: member.id } });
    expect(after?.addressLine1).toBeNull();
    expect(after?.city).toBeNull();
    expect(after?.dateOfBirth).toBeNull();
  });

  it("a CONTROLLER (no members:write) cannot edit another member's profile", async () => {
    const club = await makeClub("Cedar Hills");
    await makeUser({ email: "ctrl@cedar.test", role: "CONTROLLER", clubId: club.id });
    const principal = await principalFor("ctrl@cedar.test");
    const member = await makeMember(club.id);

    await expect(
      updateProfile(principal, member.id, { email: "x@example.com" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects an invalid birthday string", async () => {
    const club = await makeClub("Cedar Hills");
    await makeUser({ email: "admin@cedar.test", role: "CLUB_ADMIN", clubId: club.id });
    const principal = await principalFor("admin@cedar.test");
    const member = await makeMember(club.id);

    await expect(
      updateProfile(principal, member.id, { dateOfBirth: "not-a-date" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("phone-only update leaves new fields untouched", async () => {
    const club = await makeClub("Cedar Hills");
    await makeUser({ email: "admin@cedar.test", role: "CLUB_ADMIN", clubId: club.id });
    const principal = await principalFor("admin@cedar.test");
    const member = await makeMember(club.id);

    await db().member.update({
      where: { id: member.id },
      data: { addressLine1: "Keep me", city: "Halifax" },
    });

    await updateProfile(principal, member.id, { phone: "555-9999" });

    const after = await db().member.findUnique({ where: { id: member.id } });
    expect(after?.phone).toBe("555-9999");
    expect(after?.addressLine1).toBe("Keep me");
    expect(after?.city).toBe("Halifax");
  });
});
