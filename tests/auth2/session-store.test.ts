// AUTH-2 (2026-09-26) — server-side session authority tests.
//
// Covers §32 categories: session lifecycle, immediate revocation,
// copied-cookie revocation, session fixation, legacy rejection, cookie
// security invariants, and the cross-portal isolation surface exposed
// by the session-store itself (surface-mismatch rejection).

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createSession,
  findValidSession,
  revokeSession,
  revokeAllForUser,
  revokeAllForEmployee,
  setSessionActiveClub,
  hashBearer,
  mintBearer,
  SURFACE_ADMIN,
  SURFACE_EMPLOYEE,
  SESSION_TTL_MS,
  setSessionLogger,
  type SessionLogPayload,
} from "@/lib/services/session-store";

/** Insert (or update) a Club, User, and Employee for testing. */
async function makeFixtures(tag: string) {
  const club = await prisma.club.upsert({
    where: { id: `sess-test-club-${tag}` },
    create: {
      id: `sess-test-club-${tag}`,
      name: `Session Test Club ${tag}`,
      slug: `sess-test-club-${tag}`,
      timezone: "America/Toronto",
    },
    update: {},
  });
  const user = await prisma.user.upsert({
    where: { email: `sess-user-${tag}@example.test` },
    create: {
      id: `sess-test-user-${tag}`,
      name: `Test User ${tag}`,
      email: `sess-user-${tag}@example.test`,
      role: "ADMIN",
      status: "ACTIVE",
      passwordHash: "$2a$10$abcdefghijklmnopqrstuv",
      clubId: club.id,
    },
    update: { clubId: club.id, status: "ACTIVE" },
  });
  const employee = await prisma.employee.upsert({
    where: { id: `sess-test-emp-${tag}` },
    create: {
      id: `sess-test-emp-${tag}`,
      clubId: club.id,
      employeeNumber: `sess-${tag}`,
      firstName: "Test",
      lastName: "Employee",
      status: "ACTIVE",
      employeeLifecycle: "ACTIVE",
    },
    update: { clubId: club.id, status: "ACTIVE", employeeLifecycle: "ACTIVE" },
  });
  return { club, user, employee };
}

beforeAll(async () => {
  // Clean any leftover Session rows for these fixtures — tests should
  // be idempotent regardless of prior runs.
  await prisma.session.deleteMany({
    where: { OR: [{ userId: { startsWith: "sess-test-user-" } }, { employeeId: { startsWith: "sess-test-emp-" } }] },
  });
});

beforeEach(() => {
  // Reset the logger so per-test spies do not leak.
  setSessionLogger(() => {});
});

describe("session-store — token architecture", () => {
  it("mintBearer produces a fresh random token each call", () => {
    const a = mintBearer();
    const b = mintBearer();
    expect(a).not.toEqual(b);
    // base64url; 32 bytes → 43 chars (no padding).
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashBearer is deterministic sha256 hex", () => {
    const bearer = "abc";
    const h1 = hashBearer(bearer);
    const h2 = hashBearer(bearer);
    expect(h1).toEqual(h2);
    // sha256 hex → 64 lowercase hex chars.
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("raw bearer is never persisted — DB row stores only tokenHash", async () => {
    const { user, club } = await makeFixtures("token-persist");
    const { bearer, session } = await createSession({
      surface: SURFACE_ADMIN,
      userId: user.id,
      clubId: club.id,
    });
    const row = await prisma.session.findUnique({ where: { id: session.id } });
    expect(row).not.toBeNull();
    expect(row!.tokenHash).toEqual(hashBearer(bearer));
    // The raw bearer must appear nowhere in the row.
    const raw = JSON.stringify(row);
    expect(raw).not.toContain(bearer);
  });
});

describe("session-store — CREATE + VALIDATE", () => {
  it("creates a valid admin session that findValidSession resolves", async () => {
    const { user, club } = await makeFixtures("create-admin");
    const { bearer, session } = await createSession({
      surface: SURFACE_ADMIN,
      userId: user.id,
      clubId: club.id,
    });
    const found = await findValidSession(bearer, SURFACE_ADMIN);
    expect(found?.id).toEqual(session.id);
    expect(found?.userId).toEqual(user.id);
    expect(found?.clubId).toEqual(club.id);
  });

  it("creates a valid employee session that findValidSession resolves", async () => {
    const { employee, club } = await makeFixtures("create-emp");
    const { bearer, session } = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: employee.id,
      clubId: club.id,
    });
    const found = await findValidSession(bearer, SURFACE_EMPLOYEE);
    expect(found?.id).toEqual(session.id);
    expect(found?.employeeId).toEqual(employee.id);
    expect(found?.clubId).toEqual(club.id);
  });

  it("rejects invalid identity mapping — admin surface requires userId", async () => {
    const { club } = await makeFixtures("invalid-admin");
    await expect(
      createSession({ surface: SURFACE_ADMIN, clubId: club.id }),
    ).rejects.toThrow(/userId/);
  });

  it("rejects invalid identity mapping — employee surface requires employeeId", async () => {
    const { club } = await makeFixtures("invalid-emp");
    await expect(
      createSession({ surface: SURFACE_EMPLOYEE, clubId: club.id }),
    ).rejects.toThrow(/employeeId/);
  });

  it("rejects invalid identity mapping — employee surface may not carry activeClubId", async () => {
    const { employee, club } = await makeFixtures("invalid-emp-active");
    await expect(
      createSession({
        surface: SURFACE_EMPLOYEE,
        employeeId: employee.id,
        clubId: club.id,
        activeClubId: club.id,
      }),
    ).rejects.toThrow(/activeClubId/);
  });
});

describe("session-store — VALIDATE fail-closed", () => {
  it("returns null for an empty bearer", async () => {
    expect(await findValidSession("", SURFACE_ADMIN)).toBeNull();
    expect(await findValidSession(null, SURFACE_ADMIN)).toBeNull();
    expect(await findValidSession(undefined, SURFACE_ADMIN)).toBeNull();
  });

  it("returns null for a malformed / unknown bearer", async () => {
    expect(await findValidSession("not-a-real-token", SURFACE_ADMIN)).toBeNull();
    expect(await findValidSession(mintBearer(), SURFACE_ADMIN)).toBeNull();
  });

  it("rejects an admin bearer presented against the employee surface", async () => {
    const { user, club } = await makeFixtures("surface-mismatch-a");
    const { bearer } = await createSession({
      surface: SURFACE_ADMIN,
      userId: user.id,
      clubId: club.id,
    });
    expect(await findValidSession(bearer, SURFACE_EMPLOYEE)).toBeNull();
  });

  it("rejects an employee bearer presented against the admin surface", async () => {
    const { employee, club } = await makeFixtures("surface-mismatch-e");
    const { bearer } = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: employee.id,
      clubId: club.id,
    });
    expect(await findValidSession(bearer, SURFACE_ADMIN)).toBeNull();
  });

  it("rejects an expired session", async () => {
    const { user, club } = await makeFixtures("expired");
    const { bearer, session } = await createSession({
      surface: SURFACE_ADMIN,
      userId: user.id,
      clubId: club.id,
      ttlMs: 1000, // 1 second
    });
    expect(await findValidSession(bearer, SURFACE_ADMIN)).not.toBeNull();
    // Force expiry via DB update rather than sleep.
    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await findValidSession(bearer, SURFACE_ADMIN)).toBeNull();
  });
});

describe("session-store — REVOCATION (§16 primary acceptance)", () => {
  it("same-cookie immediate revocation — admin", async () => {
    const { user, club } = await makeFixtures("revoke-admin-same");
    const { bearer, session } = await createSession({
      surface: SURFACE_ADMIN,
      userId: user.id,
      clubId: club.id,
    });
    expect((await findValidSession(bearer, SURFACE_ADMIN))?.id).toEqual(session.id);
    await revokeSession(session.id, { revokedBy: "self", reason: "logout" });
    // Same bearer must now fail — no reissue, no waiting, no expiry.
    expect(await findValidSession(bearer, SURFACE_ADMIN)).toBeNull();
  });

  it("same-cookie immediate revocation — employee", async () => {
    const { employee, club } = await makeFixtures("revoke-emp-same");
    const { bearer, session } = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: employee.id,
      clubId: club.id,
    });
    expect((await findValidSession(bearer, SURFACE_EMPLOYEE))?.id).toEqual(session.id);
    await revokeSession(session.id, { revokedBy: "self", reason: "logout" });
    expect(await findValidSession(bearer, SURFACE_EMPLOYEE)).toBeNull();
  });

  it("copied-cookie revocation — both copies fail after one revoke", async () => {
    const { employee, club } = await makeFixtures("revoke-copy");
    const { bearer, session } = await createSession({
      surface: SURFACE_EMPLOYEE,
      employeeId: employee.id,
      clubId: club.id,
    });
    // Both "browsers" hold the same bearer bytes.
    const copyA = bearer;
    const copyB = bearer;
    expect(await findValidSession(copyA, SURFACE_EMPLOYEE)).not.toBeNull();
    expect(await findValidSession(copyB, SURFACE_EMPLOYEE)).not.toBeNull();
    await revokeSession(session.id, { revokedBy: "admin", reason: "device-compromise" });
    expect(await findValidSession(copyA, SURFACE_EMPLOYEE)).toBeNull();
    expect(await findValidSession(copyB, SURFACE_EMPLOYEE)).toBeNull();
  });

  it("revokeAllForUser revokes every non-revoked admin session for that user", async () => {
    const { user, club } = await makeFixtures("revoke-all-user");
    const s1 = await createSession({ surface: SURFACE_ADMIN, userId: user.id, clubId: club.id });
    const s2 = await createSession({ surface: SURFACE_ADMIN, userId: user.id, clubId: club.id });
    const count = await revokeAllForUser(user.id, { revokedBy: "admin", reason: "test" });
    expect(count).toBeGreaterThanOrEqual(2);
    expect(await findValidSession(s1.bearer, SURFACE_ADMIN)).toBeNull();
    expect(await findValidSession(s2.bearer, SURFACE_ADMIN)).toBeNull();
  });

  it("revokeAllForEmployee revokes every non-revoked employee session", async () => {
    const { employee, club } = await makeFixtures("revoke-all-emp");
    const s1 = await createSession({ surface: SURFACE_EMPLOYEE, employeeId: employee.id, clubId: club.id });
    const s2 = await createSession({ surface: SURFACE_EMPLOYEE, employeeId: employee.id, clubId: club.id });
    const count = await revokeAllForEmployee(employee.id, { revokedBy: "admin", reason: "test" });
    expect(count).toBeGreaterThanOrEqual(2);
    expect(await findValidSession(s1.bearer, SURFACE_EMPLOYEE)).toBeNull();
    expect(await findValidSession(s2.bearer, SURFACE_EMPLOYEE)).toBeNull();
  });

  it("revoke is idempotent — repeat revokes do not overwrite revokedAt", async () => {
    const { user, club } = await makeFixtures("revoke-idempotent");
    const { session } = await createSession({ surface: SURFACE_ADMIN, userId: user.id, clubId: club.id });
    await revokeSession(session.id);
    const first = await prisma.session.findUnique({ where: { id: session.id } });
    const firstRevokedAt = first!.revokedAt!;
    await new Promise((r) => setTimeout(r, 10));
    await revokeSession(session.id);
    const second = await prisma.session.findUnique({ where: { id: session.id } });
    expect(second!.revokedAt).toEqual(firstRevokedAt);
  });
});

describe("session-store — SESSION FIXATION", () => {
  it("re-authentication produces a fresh bearer token", async () => {
    const { user, club } = await makeFixtures("fixation");
    const first = await createSession({ surface: SURFACE_ADMIN, userId: user.id, clubId: club.id });
    const second = await createSession({ surface: SURFACE_ADMIN, userId: user.id, clubId: club.id });
    expect(first.bearer).not.toEqual(second.bearer);
    expect(first.session.tokenHash).not.toEqual(second.session.tokenHash);
    // Both sessions coexist as independent server rows — session-fixation
    // hardening in session.ts revokes the prior row on re-auth; the
    // store itself simply issues fresh identities on every call.
  });
});

describe("session-store — activeClub mutation (admin)", () => {
  it("setSessionActiveClub only touches ADMIN sessions", async () => {
    const { user, employee, club } = await makeFixtures("active-club");
    const admin = await createSession({ surface: SURFACE_ADMIN, userId: user.id, clubId: club.id });
    const emp = await createSession({ surface: SURFACE_EMPLOYEE, employeeId: employee.id, clubId: club.id });
    await setSessionActiveClub(admin.session.id, "other-club-id");
    await setSessionActiveClub(emp.session.id, "other-club-id");
    const a = await prisma.session.findUnique({ where: { id: admin.session.id } });
    const e = await prisma.session.findUnique({ where: { id: emp.session.id } });
    expect(a!.activeClubId).toEqual("other-club-id");
    // Employee row untouched: its activeClubId stays null (session-store
    // rejects the write via a surface filter).
    expect(e!.activeClubId).toBeNull();
  });
});

describe("session-store — SECURITY LOGGING", () => {
  it("emits SESSION_CREATED, SESSION_REVOKED, SESSION_INVALID without bearer tokens", async () => {
    const { user, club } = await makeFixtures("log");
    const events: SessionLogPayload[] = [];
    setSessionLogger((p) => events.push(p));

    const { bearer, session } = await createSession({
      surface: SURFACE_ADMIN,
      userId: user.id,
      clubId: club.id,
    });
    await revokeSession(session.id, { reason: "logout" });
    await findValidSession(bearer, SURFACE_ADMIN); // triggers SESSION_INVALID
    await findValidSession("bogus-token", SURFACE_ADMIN); // triggers SESSION_INVALID

    // At least one CREATED, one revoke, one invalid.
    expect(events.some((e) => e.event === "SESSION_CREATED")).toBe(true);
    expect(events.some((e) => e.event === "SESSION_LOGOUT")).toBe(true);
    expect(events.some((e) => e.event === "SESSION_INVALID")).toBe(true);
    // No event may leak the raw bearer.
    for (const e of events) {
      expect(JSON.stringify(e)).not.toContain(bearer);
    }
  });
});
