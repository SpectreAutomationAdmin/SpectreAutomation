import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { hasPermission, isSuperAdmin } from "@/lib/rbac";
import { db, makeClub, makeUser, resetDb, seedRbac, principalFor } from "./util/db";

describe("RBAC — permission resolution", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("SUPER_ADMIN can do anything across all clubs", async () => {
    await makeUser({ email: "super@example.com", role: "SUPER_ADMIN", clubId: null });
    const club = await makeClub("Test A");
    const p = await principalFor("super@example.com");

    expect(isSuperAdmin(p)).toBe(true);
    expect(hasPermission(p, club.id, "members:write")).toBe(true);
    expect(hasPermission(p, club.id, "gl:close_period")).toBe(true);
    expect(hasPermission(p, null, "clubs:create")).toBe(true);
  });

  it("CLUB_ADMIN can manage members at their club but not another", async () => {
    const clubA = await makeClub("A");
    const clubB = await makeClub("B");
    await makeUser({ email: "admin-a@example.com", role: "CLUB_ADMIN", clubId: clubA.id });
    const p = await principalFor("admin-a@example.com");

    expect(hasPermission(p, clubA.id, "members:write")).toBe(true);
    expect(hasPermission(p, clubB.id, "members:write")).toBe(false);
  });

  it("FINANCE_ADMIN can read GL but cannot post journal entries", async () => {
    const club = await makeClub("F");
    await makeUser({ email: "fin@example.com", role: "FINANCE_ADMIN", clubId: club.id });
    const p = await principalFor("fin@example.com");

    expect(hasPermission(p, club.id, "gl:read")).toBe(true);
    expect(hasPermission(p, club.id, "gl:post")).toBe(false);
    expect(hasPermission(p, club.id, "ar:write")).toBe(true);
    expect(hasPermission(p, club.id, "ar:void")).toBe(false);
  });

  it("AUDITOR_READ_ONLY can read AR but cannot write", async () => {
    const club = await makeClub("Aud");
    await makeUser({ email: "auditor@example.com", role: "AUDITOR_READ_ONLY", clubId: club.id });
    const p = await principalFor("auditor@example.com");

    expect(hasPermission(p, club.id, "ar:read")).toBe(true);
    expect(hasPermission(p, club.id, "gl:read")).toBe(true);
    expect(hasPermission(p, club.id, "ap:read")).toBe(true);
    expect(hasPermission(p, club.id, "gl:post")).toBe(false);
    expect(hasPermission(p, club.id, "ar:write")).toBe(false);
    expect(hasPermission(p, club.id, "members:write")).toBe(false);
  });

  it("MEMBER can read own account permissions only", async () => {
    const club = await makeClub("M");
    await makeUser({ email: "m@example.com", role: "MEMBER", clubId: club.id });
    const p = await principalFor("m@example.com");

    expect(hasPermission(p, club.id, "self:account:read")).toBe(true);
    expect(hasPermission(p, club.id, "self:payment_methods:write")).toBe(true);
    expect(hasPermission(p, club.id, "members:write")).toBe(false);
    expect(hasPermission(p, club.id, "ar:read")).toBe(false);
  });

  it("BOARD_READ_ONLY can read board package only", async () => {
    const club = await makeClub("B2");
    await makeUser({ email: "board@example.com", role: "BOARD_READ_ONLY", clubId: club.id });
    const p = await principalFor("board@example.com");
    expect(hasPermission(p, club.id, "reports:board")).toBe(true);
    expect(hasPermission(p, club.id, "members:read")).toBe(false);
  });
});
