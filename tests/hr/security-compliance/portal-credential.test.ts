// HR-2B.5 §5-9, §42, §45 — Employee Portal credential service.
//
// The credential service is security-critical: passwords are hashed
// exactly once (bcrypt), never returned or logged plaintext, and
// verification must be timing-uniform against unknown employees +
// currently-locked accounts.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { createEmployee } from "@/lib/hr/employees";
import {
  establishPortalPassword,
  verifyPortalPassword,
  selfHasPortalCredential,
  hasPortalCredential,
  PORTAL_PASSWORD_MIN,
} from "@/lib/hr/employee-portal-credential";
import { resetDb, seedRbac, makeClub } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";
import type { EmployeeOnboardingActor } from "@/lib/hr/employee-actor";

function actorFor(fx: { employeeId: string; clubId: string; sessionId: string }): EmployeeOnboardingActor {
  return {
    invitationId: "test-invitation",
    sessionId: fx.sessionId,
    employeeId: fx.employeeId,
    clubId: fx.clubId,
    sessionState: "IN_PROGRESS",
    redeemedAt: new Date().toISOString(),
  };
}

async function seedActor(clubId: string, opts?: { lastName?: string }) {
  const employee = await prisma.employee.create({
    data: {
      clubId,
      employeeNumber: `E-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "Chris",
      lastName: opts?.lastName ?? "Portal",
      personalEmail: `portal-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.com`,
    },
  });
  // A staff user must exist so the session has an initiator; keep it
  // local to this helper so the test remains self-contained.
  const initiator = await prisma.user.create({
    data: {
      email: `initiator-${Date.now()}-${Math.floor(Math.random() * 1000)}@example.com`,
      name: "Test Initiator",
      role: "CLUB_ADMIN",
      passwordHash: "test-only-hash",
      clubId,
      status: "ACTIVE",
    },
  });
  const session = await prisma.employeeOnboardingSession.create({
    data: {
      clubId,
      employeeId: employee.id,
      state: "IN_PROGRESS",
      initiatedByUserId: initiator.id,
    },
  });
  return actorFor({ employeeId: employee.id, clubId, sessionId: session.id });
}

describe("HR-2B.5 · EmployeePortalCredential service", () => {
  let fx: AdminHrFixture;

  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("PortalCredFix");
  });

  it("establishPortalPassword persists a bcrypt hash, never the plaintext", async () => {
    const actor = await seedActor(fx.club.id);
    const password = "correct horse battery staple";
    await establishPortalPassword(actor, { password, confirmPassword: password });

    const row = await prisma.employeePortalCredential.findUnique({
      where: { employeeId: actor.employeeId },
    });
    expect(row).not.toBeNull();
    expect(row!.passwordHash).not.toBe(password);
    // bcrypt hashes are $2a$ / $2b$ prefixed and ~60 chars.
    expect(row!.passwordHash).toMatch(/^\$2[aby]\$/);
    // Sanity: the hash actually verifies.
    expect(await bcrypt.compare(password, row!.passwordHash)).toBe(true);
  });

  it("password mismatch is rejected client- and server-side", async () => {
    const actor = await seedActor(fx.club.id);
    let caught: unknown;
    try {
      await establishPortalPassword(actor, {
        password: "long enough password abc",
        confirmPassword: "different long password",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { issues?: Array<{ message: string }> }).issues?.[0]?.message).toMatch(/do not match/i);
    // No credential row should exist.
    expect(await selfHasPortalCredential(actor)).toBe(false);
  });

  it("password shorter than PORTAL_PASSWORD_MIN is rejected", async () => {
    const actor = await seedActor(fx.club.id);
    const short = "abc";
    let caught: unknown;
    try {
      await establishPortalPassword(actor, { password: short, confirmPassword: short });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { issues?: Array<{ message: string }> }).issues?.[0]?.message).toMatch(/at least/i);
    expect(PORTAL_PASSWORD_MIN).toBeGreaterThanOrEqual(10);
  });

  it("verifyPortalPassword returns success on correct credentials", async () => {
    const actor = await seedActor(fx.club.id);
    const password = "another long passphrase 1234";
    await establishPortalPassword(actor, { password, confirmPassword: password });

    const emp = await prisma.employee.findUnique({ where: { id: actor.employeeId } });
    const result = await verifyPortalPassword({
      clubId: actor.clubId,
      employeeNumber: emp!.employeeNumber,
      password,
    });
    expect(result).not.toBeNull();
    expect(result!.employeeId).toBe(actor.employeeId);
    expect(result!.clubId).toBe(actor.clubId);
  });

  it("verifyPortalPassword returns null on wrong password without leaking existence", async () => {
    const actor = await seedActor(fx.club.id);
    const password = "another long passphrase 1234";
    await establishPortalPassword(actor, { password, confirmPassword: password });
    const emp = await prisma.employee.findUnique({ where: { id: actor.employeeId } });

    const wrong = await verifyPortalPassword({
      clubId: actor.clubId,
      employeeNumber: emp!.employeeNumber,
      password: "wrong password guess",
    });
    expect(wrong).toBeNull();
  });

  it("verifyPortalPassword returns null for unknown employee number (no enumeration)", async () => {
    const result = await verifyPortalPassword({
      clubId: fx.club.id,
      employeeNumber: "E-99999",
      password: "anything at all here",
    });
    expect(result).toBeNull();
  });

  it("verifyPortalPassword returns null for correct password on foreign club", async () => {
    const actor = await seedActor(fx.club.id);
    const password = "correct horse battery staple";
    await establishPortalPassword(actor, { password, confirmPassword: password });
    const emp = await prisma.employee.findUnique({ where: { id: actor.employeeId } });

    // Same employeeNumber string but wrong clubId (§8 tenant isolation).
    const wrongClub = await makeClub("Different Club");
    const cross = await verifyPortalPassword({
      clubId: wrongClub.id,
      employeeNumber: emp!.employeeNumber,
      password,
    });
    expect(cross).toBeNull();
  });

  it("5 failed attempts locks the account for ~15 minutes", async () => {
    const actor = await seedActor(fx.club.id);
    const password = "another long passphrase 1234";
    await establishPortalPassword(actor, { password, confirmPassword: password });
    const emp = await prisma.employee.findUnique({ where: { id: actor.employeeId } });

    for (let i = 0; i < 5; i++) {
      await verifyPortalPassword({
        clubId: actor.clubId,
        employeeNumber: emp!.employeeNumber,
        password: "wrong",
      });
    }
    const row = await prisma.employeePortalCredential.findUnique({
      where: { employeeId: actor.employeeId },
    });
    expect(row!.failedAttemptCount).toBe(5);
    expect(row!.lockedUntil).not.toBeNull();
    // Even the correct password fails while locked.
    const stillLocked = await verifyPortalPassword({
      clubId: actor.clubId,
      employeeNumber: emp!.employeeNumber,
      password,
    });
    expect(stillLocked).toBeNull();
  });

  it("successful login clears failed count + lockedUntil", async () => {
    const actor = await seedActor(fx.club.id);
    const password = "another long passphrase 1234";
    await establishPortalPassword(actor, { password, confirmPassword: password });
    const emp = await prisma.employee.findUnique({ where: { id: actor.employeeId } });

    // 3 failures (below lock threshold).
    for (let i = 0; i < 3; i++) {
      await verifyPortalPassword({
        clubId: actor.clubId,
        employeeNumber: emp!.employeeNumber,
        password: "wrong",
      });
    }
    // Success.
    const ok = await verifyPortalPassword({
      clubId: actor.clubId,
      employeeNumber: emp!.employeeNumber,
      password,
    });
    expect(ok).not.toBeNull();
    const row = await prisma.employeePortalCredential.findUnique({
      where: { employeeId: actor.employeeId },
    });
    expect(row!.failedAttemptCount).toBe(0);
    expect(row!.lockedUntil).toBeNull();
    expect(row!.lastLoginAt).not.toBeNull();
  });

  it("hasPortalCredential (admin) is tenant-scoped", async () => {
    const actor = await seedActor(fx.club.id);
    const password = "another long passphrase 1234";
    await establishPortalPassword(actor, { password, confirmPassword: password });

    expect(await hasPortalCredential(fx.clubAdmin, actor.employeeId)).toBe(true);
    // Foreign admin cannot check.
    await expect(
      hasPortalCredential(fx.foreignClubAdmin, actor.employeeId),
    ).rejects.toThrow();
  });

  it("rotation preserves single-row invariant (no duplicate credential rows)", async () => {
    const actor = await seedActor(fx.club.id);
    await establishPortalPassword(actor, { password: "first passphrase ok", confirmPassword: "first passphrase ok" });
    await establishPortalPassword(actor, { password: "second passphrase ok", confirmPassword: "second passphrase ok" });
    const count = await prisma.employeePortalCredential.count({ where: { employeeId: actor.employeeId } });
    expect(count).toBe(1);
  });

  it("rotation clears any prior lockout", async () => {
    const actor = await seedActor(fx.club.id);
    await establishPortalPassword(actor, { password: "first passphrase ok", confirmPassword: "first passphrase ok" });
    const emp = await prisma.employee.findUnique({ where: { id: actor.employeeId } });
    for (let i = 0; i < 5; i++) {
      await verifyPortalPassword({ clubId: actor.clubId, employeeNumber: emp!.employeeNumber, password: "wrong" });
    }
    let row = await prisma.employeePortalCredential.findUnique({ where: { employeeId: actor.employeeId } });
    expect(row!.lockedUntil).not.toBeNull();
    // Rotation clears.
    await establishPortalPassword(actor, { password: "second passphrase ok", confirmPassword: "second passphrase ok" });
    row = await prisma.employeePortalCredential.findUnique({ where: { employeeId: actor.employeeId } });
    expect(row!.lockedUntil).toBeNull();
    expect(row!.failedAttemptCount).toBe(0);
  });

  it("credential establishment writes an hr.portal_credential.set audit row without any password payload", async () => {
    const actor = await seedActor(fx.club.id);
    const password = "yet another passphrase 4567";
    await establishPortalPassword(actor, { password, confirmPassword: password });

    const audit = await prisma.auditLog.findFirst({
      where: { action: "hr.portal_credential.set" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    // No password material anywhere in the audit row.
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toMatch(/\$2[aby]\$/); // no bcrypt hash prefix
  });
});
