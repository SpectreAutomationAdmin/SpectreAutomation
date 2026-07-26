import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { login } from "@/lib/services/auth";
import { RateLimitError, AppError } from "@/lib/errors";
import { db, makeClub, makeUser, resetDb, seedRbac } from "./util/db";

describe("Auth — lockout and password handling", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });

  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("login succeeds with correct credentials", async () => {
    const club = await makeClub("A");
    await makeUser({ email: "ok@example.com", role: "CLUB_ADMIN", clubId: club.id });
    const { userId } = await login({ email: "ok@example.com", password: "password" });
    expect(userId).toBeTruthy();

    const u = await db().user.findUnique({ where: { id: userId } });
    expect(u?.failedLoginCount).toBe(0);
    expect(u?.lastLoginAt).not.toBeNull();
  });

  it("login fails with generic error for unknown user", async () => {
    await expect(login({ email: "nobody@example.com", password: "anything" })).rejects.toBeInstanceOf(AppError);
  });

  it("locks the account after 5 failed attempts", async () => {
    const club = await makeClub("A");
    await makeUser({ email: "victim@example.com", role: "CLUB_ADMIN", clubId: club.id });

    for (let i = 0; i < 4; i++) {
      await expect(login({ email: "victim@example.com", password: "wrong" })).rejects.toBeInstanceOf(AppError);
    }
    // 5th attempt triggers the lockout
    await expect(login({ email: "victim@example.com", password: "wrong" })).rejects.toBeInstanceOf(RateLimitError);

    // Even with the correct password we should be locked out now.
    await expect(login({ email: "victim@example.com", password: "password" })).rejects.toBeInstanceOf(RateLimitError);

    const u = await db().user.findUnique({ where: { email: "victim@example.com" } });
    expect(u?.failedLoginCount).toBeGreaterThanOrEqual(5);
    expect(u?.lockedUntil).not.toBeNull();
    expect(u?.status).toBe("LOCKED");
  });

  it("password hash is salted (different output for same plaintext)", async () => {
    const a = await bcrypt.hash("password", 10);
    const b = await bcrypt.hash("password", 10);
    expect(a).not.toBe(b);
  });

  it("disabled accounts cannot sign in", async () => {
    const club = await makeClub("A");
    const u = await makeUser({ email: "off@example.com", role: "CLUB_ADMIN", clubId: club.id });
    await db().user.update({ where: { id: u.id }, data: { status: "DISABLED" } });
    await expect(login({ email: "off@example.com", password: "password" })).rejects.toBeInstanceOf(AppError);
  });
});
