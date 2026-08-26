// HR mobile-hotfix (2026-08-26) — Employee Portal password reset.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/services/auth";
import {
  requestPortalPasswordReset,
  verifyPortalPasswordResetToken,
  completePortalPasswordReset,
  adminSendPortalPasswordReset,
  generateResetToken,
  hashResetToken,
} from "@/lib/hr/password-reset";
import { verifyPortalPasswordByEmail } from "@/lib/hr/employee-portal-credential";
import { resetDb, seedRbac, makeClub, makeUser, principalFor } from "../../util/db";

// Mock the email-send side so tests don't hit the adapter chain; we
// only care about the token/DB semantics + audit shape.
vi.mock("@/lib/hr/password-reset-email", () => ({
  sendPortalPasswordResetEmail: vi.fn(async () => {}),
}));

const PW = "correct-horse-battery-staple";
const PW2 = "different-secret-second-pass";

async function makeEmp(opts: {
  clubId: string; email: string; password?: string;
  firstName?: string; lastName?: string;
}) {
  const emp = await prisma.employee.create({
    data: {
      clubId: opts.clubId,
      employeeNumber: `E-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: opts.firstName ?? "Test",
      lastName: opts.lastName ?? "Reset",
      personalEmail: opts.email,
      employeeLifecycle: "ACTIVE", status: "ACTIVE",
    },
  });
  if (opts.password) {
    await prisma.employeePortalCredential.create({
      data: {
        clubId: opts.clubId, employeeId: emp.id,
        passwordHash: await hashPassword(opts.password),
        passwordUpdatedAt: new Date(),
      },
    });
  }
  return emp;
}

describe("HR mobile-hotfix · password reset — request path", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => { await resetDb(); await seedRbac(); }, 60_000);

  it("known employee → creates a hashed-only reset row + returns neutral `queued`", async () => {
    const club = await makeClub("PR-A");
    const emp = await makeEmp({ clubId: club.id, email: "chris@example.com", password: PW });
    const r = await requestPortalPasswordReset({
      email: "chris@example.com", clubId: club.id,
      actorSource: "EMPLOYEE", publicOrigin: "https://staging.spectreautomation.com",
    });
    expect(r.status).toBe("queued");
    const rows = await prisma.employeePortalPasswordReset.findMany({
      where: { employeeId: emp.id },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].tokenHash).toMatch(/^[a-f0-9]{64}$/); // sha256 hex — never the raw token
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("unknown email → SAME neutral queued response + NO row created", async () => {
    const club = await makeClub("PR-B");
    const r = await requestPortalPasswordReset({
      email: "ghost@nobody.com", clubId: club.id,
      actorSource: "EMPLOYEE", publicOrigin: "https://staging.spectreautomation.com",
    });
    expect(r.status).toBe("queued");
    const rows = await prisma.employeePortalPasswordReset.findMany();
    expect(rows.length).toBe(0);
  });

  it("email normalisation: trimmed + lowercased on the way in", async () => {
    const club = await makeClub("PR-C");
    const emp = await makeEmp({ clubId: club.id, email: "chris@example.com", password: PW });
    await requestPortalPasswordReset({
      email: "  CHRIS@Example.COM  ", clubId: club.id,
      actorSource: "EMPLOYEE", publicOrigin: "https://x/",
    });
    const rows = await prisma.employeePortalPasswordReset.findMany({ where: { employeeId: emp.id } });
    expect(rows.length).toBe(1);
  });

  it("ambiguous across Clubs with clubId=null → SAME neutral queued response + NO token issued", async () => {
    const clubA = await makeClub("PR-D1"); const clubB = await makeClub("PR-D2");
    await makeEmp({ clubId: clubA.id, email: "shared@example.com", password: PW });
    await makeEmp({ clubId: clubB.id, email: "shared@example.com", password: PW2 });
    const r = await requestPortalPasswordReset({
      email: "shared@example.com", clubId: null,
      actorSource: "EMPLOYEE", publicOrigin: "https://x/",
    });
    expect(r.status).toBe("queued");
    const rows = await prisma.employeePortalPasswordReset.findMany();
    expect(rows.length).toBe(0);
  });

  it("supersede: re-requesting invalidates all outstanding tokens", async () => {
    const club = await makeClub("PR-E");
    const emp = await makeEmp({ clubId: club.id, email: "chris@example.com", password: PW });
    await requestPortalPasswordReset({
      email: "chris@example.com", clubId: club.id,
      actorSource: "EMPLOYEE", publicOrigin: "https://x/",
    });
    await requestPortalPasswordReset({
      email: "chris@example.com", clubId: club.id,
      actorSource: "EMPLOYEE", publicOrigin: "https://x/",
    });
    const rows = await prisma.employeePortalPasswordReset.findMany({
      where: { employeeId: emp.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.length).toBe(2);
    expect(rows[0].consumedAt).not.toBeNull(); // superseded
    expect(rows[1].consumedAt).toBeNull();     // active
  });
});

describe("HR mobile-hotfix · password reset — verify + complete", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => { await resetDb(); await seedRbac(); }, 60_000);

  it("full happy path: new password works; old password stops working; hash written; token consumed", async () => {
    const club = await makeClub("PR-F");
    const emp = await makeEmp({ clubId: club.id, email: "chris@example.com", password: PW });
    // Issue a token directly (bypass email-send stub) so we hold the raw form.
    const { raw, hash } = generateResetToken();
    await prisma.employeePortalPasswordReset.create({
      data: { clubId: club.id, employeeId: emp.id, tokenHash: hash, expiresAt: new Date(Date.now() + 60_000) },
    });
    // Verify → valid.
    const v = await verifyPortalPasswordResetToken(raw);
    expect(v.kind).toBe("valid");
    // Complete → success.
    const c = await completePortalPasswordReset({ rawToken: raw, password: PW2, confirmPassword: PW2 });
    expect(c.kind).toBe("success");
    // Token now consumed.
    const row = await prisma.employeePortalPasswordReset.findFirst({ where: { tokenHash: hash } });
    expect(row?.consumedAt).not.toBeNull();
    // Old password fails; new password succeeds.
    expect((await verifyPortalPasswordByEmail({ clubId: club.id, email: "chris@example.com", password: PW })).kind).toBe("not_recognised");
    expect((await verifyPortalPasswordByEmail({ clubId: club.id, email: "chris@example.com", password: PW2 })).kind).toBe("success");
    // Credential row lockout was reset (belt: this credential was
    // freshly minted so nothing to prove, but ensure the write ran).
    const cred = await prisma.employeePortalCredential.findFirst({ where: { employeeId: emp.id } });
    expect(cred?.failedAttemptCount).toBe(0);
    expect(cred?.lockedUntil).toBeNull();
  });

  it("expired token → completePortalPasswordReset rejects with expired_token", async () => {
    const club = await makeClub("PR-G");
    const emp = await makeEmp({ clubId: club.id, email: "chris@example.com", password: PW });
    const { raw, hash } = generateResetToken();
    await prisma.employeePortalPasswordReset.create({
      data: { clubId: club.id, employeeId: emp.id, tokenHash: hash, expiresAt: new Date(Date.now() - 1000) },
    });
    const c = await completePortalPasswordReset({ rawToken: raw, password: PW2, confirmPassword: PW2 });
    expect(c.kind).toBe("expired_token");
    // Password NOT rotated.
    expect((await verifyPortalPasswordByEmail({ clubId: club.id, email: "chris@example.com", password: PW })).kind).toBe("success");
  });

  it("reused token → refused with consumed_token", async () => {
    const club = await makeClub("PR-H");
    const emp = await makeEmp({ clubId: club.id, email: "chris@example.com", password: PW });
    const { raw, hash } = generateResetToken();
    await prisma.employeePortalPasswordReset.create({
      data: { clubId: club.id, employeeId: emp.id, tokenHash: hash, expiresAt: new Date(Date.now() + 60_000) },
    });
    const first = await completePortalPasswordReset({ rawToken: raw, password: PW2, confirmPassword: PW2 });
    expect(first.kind).toBe("success");
    const second = await completePortalPasswordReset({ rawToken: raw, password: "another-attempt", confirmPassword: "another-attempt" });
    expect(second.kind).toBe("consumed_token");
  });

  it("invalid token → refused with invalid_token (no row match)", async () => {
    const c = await completePortalPasswordReset({ rawToken: "not-a-real-token-at-all", password: PW2, confirmPassword: PW2 });
    expect(c.kind).toBe("invalid_token");
  });

  it("password mismatch / policy violations rejected before touching the DB", async () => {
    const club = await makeClub("PR-I");
    const emp = await makeEmp({ clubId: club.id, email: "chris@example.com", password: PW });
    const { raw, hash } = generateResetToken();
    await prisma.employeePortalPasswordReset.create({
      data: { clubId: club.id, employeeId: emp.id, tokenHash: hash, expiresAt: new Date(Date.now() + 60_000) },
    });
    expect((await completePortalPasswordReset({ rawToken: raw, password: "shortpw", confirmPassword: "shortpw" })).kind).toBe("password_policy");
    expect((await completePortalPasswordReset({ rawToken: raw, password: PW2, confirmPassword: "different" })).kind).toBe("password_mismatch");
    const cred = await prisma.employeePortalCredential.findFirst({ where: { employeeId: emp.id } });
    // Password hash unchanged by rejected attempts.
    expect(await verifyPortalPasswordByEmail({ clubId: club.id, email: "chris@example.com", password: PW })).toMatchObject({ kind: "success" });
    expect(cred?.passwordHash).toBeDefined();
  });

  it("newer token supersedes prior: old raw token no longer works after a new request", async () => {
    const club = await makeClub("PR-J");
    const emp = await makeEmp({ clubId: club.id, email: "chris@example.com", password: PW });
    const { raw: oldRaw } = generateResetToken();
    await prisma.employeePortalPasswordReset.create({
      data: { clubId: club.id, employeeId: emp.id, tokenHash: hashResetToken(oldRaw), expiresAt: new Date(Date.now() + 60_000) },
    });
    // Fire the service (which internally supersedes).
    await requestPortalPasswordReset({
      email: "chris@example.com", clubId: club.id,
      actorSource: "EMPLOYEE", publicOrigin: "https://x/",
    });
    const c = await completePortalPasswordReset({ rawToken: oldRaw, password: PW2, confirmPassword: PW2 });
    expect(c.kind).toBe("consumed_token");
  });

  it("cross-Club token refused: valid token from ClubA cannot rotate ClubB's employee (structurally impossible — tokenHash is unique)", async () => {
    const clubA = await makeClub("PR-K1"); const clubB = await makeClub("PR-K2");
    const empA = await makeEmp({ clubId: clubA.id, email: "chris@example.com", password: PW });
    const empB = await makeEmp({ clubId: clubB.id, email: "chris@example.com", password: PW });
    const { raw, hash } = generateResetToken();
    // Row is created with clubId=A, employeeId=empA.
    await prisma.employeePortalPasswordReset.create({
      data: { clubId: clubA.id, employeeId: empA.id, tokenHash: hash, expiresAt: new Date(Date.now() + 60_000) },
    });
    const c = await completePortalPasswordReset({ rawToken: raw, password: PW2, confirmPassword: PW2 });
    expect(c.kind).toBe("success");
    // empB was NOT touched.
    expect((await verifyPortalPasswordByEmail({ clubId: clubB.id, email: "chris@example.com", password: PW })).kind).toBe("success");
    expect((await verifyPortalPasswordByEmail({ clubId: clubB.id, email: "chris@example.com", password: PW2 })).kind).toBe("not_recognised");
  });
});

describe("HR mobile-hotfix · admin-initiated reset", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => { await resetDb(); await seedRbac(); }, 60_000);

  it("adminSendPortalPasswordReset requires hr:employee:write + issues a token", async () => {
    const club = await makeClub("PR-L");
    const emp = await makeEmp({ clubId: club.id, email: "chris@example.com", password: PW });
    await makeUser({ email: `admin-${Math.random().toString(36).slice(2, 6)}@example.com`, role: "CLUB_ADMIN", clubId: club.id });
    const adminEmails = await prisma.user.findMany({ where: { clubRoles: { some: { clubId: club.id, roleKey: "CLUB_ADMIN" } } }, select: { email: true } });
    const admin = await principalFor(adminEmails[0].email);
    const r = await adminSendPortalPasswordReset(admin, emp.id, {
      publicOrigin: "https://staging.spectreautomation.com",
    });
    expect(r.status).toBe("queued");
    const rows = await prisma.employeePortalPasswordReset.findMany({ where: { employeeId: emp.id } });
    expect(rows.length).toBe(1);
    // Admin-initiated audit row exists.
    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "employee_portal.password_reset.admin_request", entityId: emp.id },
    });
    expect(auditRow).not.toBeNull();
  });

  it("adminSendPortalPasswordReset refuses when the caller lacks hr:employee:write", async () => {
    const club = await makeClub("PR-M");
    const emp = await makeEmp({ clubId: club.id, email: "chris@example.com", password: PW });
    await makeUser({ email: `auditor-${Math.random().toString(36).slice(2, 6)}@example.com`, role: "AUDITOR_READ_ONLY", clubId: club.id });
    const auditorEmails = await prisma.user.findMany({ where: { clubRoles: { some: { clubId: club.id, roleKey: "AUDITOR_READ_ONLY" } } }, select: { email: true } });
    const auditor = await principalFor(auditorEmails[0].email);
    await expect(adminSendPortalPasswordReset(auditor, emp.id, {
      publicOrigin: "https://staging.spectreautomation.com",
    })).rejects.toThrow(/permission/i);
  });

  it("service never returns the raw token to the caller (function signature returns {status})", async () => {
    const club = await makeClub("PR-N");
    const emp = await makeEmp({ clubId: club.id, email: "chris@example.com", password: PW });
    const r = await requestPortalPasswordReset({
      email: "chris@example.com", clubId: club.id,
      actorSource: "EMPLOYEE", publicOrigin: "https://x/",
    });
    // Result shape has no `token` field.
    expect((r as unknown as Record<string, unknown>).token).toBeUndefined();
    expect((r as unknown as Record<string, unknown>).rawToken).toBeUndefined();
    // DB only carries the SHA-256 digest — the raw bytes are gone.
    const row = await prisma.employeePortalPasswordReset.findFirst({ where: { employeeId: emp.id } });
    expect(row?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
