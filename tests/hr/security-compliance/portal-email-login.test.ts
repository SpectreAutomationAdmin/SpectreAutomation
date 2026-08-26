// HR mobile-hotfix (2026-08-25) — Employee Portal email-based login.
//
// Founder decision: portal username is the canonical Employee
// personalEmail, not employeeNumber. Existing bcrypt passwords are
// preserved. Passes MUST cover:
//   * valid email + password succeeds;
//   * normalisation (trim + lowercase) doesn't gate a valid login;
//   * unknown email fails neutrally with the same shape as wrong
//     password;
//   * wrong password fails neutrally;
//   * clubId scope (host-resolved to a specific Club) refuses a
//     cross-Club email match;
//   * clubId null (platform host) resolves a single-Club match;
//   * clubId null + same email in 2 Clubs returns ambiguous_across_clubs;
//   * AccountLock ticks up on wrong password; locked account fails
//     neutrally;
//   * successful login clears failedAttemptCount + lockedUntil +
//     stamps lastLoginAt;
//   * email change: old email stops authenticating, new email works,
//     password hash unchanged.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  verifyPortalPasswordByEmail,
  normaliseLoginEmail,
  PORTAL_PASSWORD_MIN,
} from "@/lib/hr/employee-portal-credential";
import { hashPassword } from "@/lib/services/auth";
import { resetDb, seedRbac, makeClub } from "../../util/db";

interface Fx {
  clubA: { id: string; name: string };
  clubB: { id: string; name: string };
  employee: { id: string; clubId: string; personalEmail: string };
  password: string;
}

const PW = "correct-horse-battery-staple";

async function makeEmployeeWithCredential(opts: {
  clubId: string;
  personalEmail: string;
  employeeNumber?: string;
  password: string;
  firstName?: string; lastName?: string;
}) {
  const emp = await prisma.employee.create({
    data: {
      clubId: opts.clubId,
      employeeNumber: opts.employeeNumber ?? `E-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: opts.firstName ?? "Test",
      lastName: opts.lastName ?? "Employee",
      personalEmail: opts.personalEmail,
      employeeLifecycle: "ACTIVE", status: "ACTIVE",
    },
  });
  const hash = await hashPassword(opts.password);
  await prisma.employeePortalCredential.create({
    data: {
      clubId: opts.clubId, employeeId: emp.id,
      passwordHash: hash, passwordUpdatedAt: new Date(),
    },
  });
  return emp;
}

async function makeFx(): Promise<Fx> {
  const clubA = await makeClub(`PortalLogin A ${Math.random().toString(36).slice(2, 6)}`);
  const clubB = await makeClub(`PortalLogin B ${Math.random().toString(36).slice(2, 6)}`);
  const employee = await makeEmployeeWithCredential({
    clubId: clubA.id,
    personalEmail: "chris@example.com",
    firstName: "Chris", lastName: "Turcato",
    password: PW,
  });
  return { clubA, clubB, employee: { id: employee.id, clubId: employee.clubId, personalEmail: employee.personalEmail! }, password: PW };
}

describe("HR mobile-hotfix · normaliseLoginEmail", () => {
  it("trims + lowercases", () => {
    expect(normaliseLoginEmail("  Chris@Example.COM ")).toBe("chris@example.com");
    expect(normaliseLoginEmail("")).toBe("");
    expect(normaliseLoginEmail(undefined)).toBe("");
    expect(normaliseLoginEmail(null)).toBe("");
  });
});

describe("HR mobile-hotfix · verifyPortalPasswordByEmail — success paths", () => {
  let fx: Fx;
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => { await resetDb(); await seedRbac(); fx = await makeFx(); }, 60_000);

  it("(A) valid email + password (Club-scoped) succeeds and marks lastLoginAt", async () => {
    const r = await verifyPortalPasswordByEmail({
      clubId: fx.clubA.id, email: fx.employee.personalEmail, password: PW,
    });
    expect(r.kind).toBe("success");
    if (r.kind === "success") {
      expect(r.employeeId).toBe(fx.employee.id);
      expect(r.clubId).toBe(fx.clubA.id);
    }
    const cred = await prisma.employeePortalCredential.findFirst({
      where: { employeeId: fx.employee.id },
    });
    expect(cred?.lastLoginAt).not.toBeNull();
    expect(cred?.failedAttemptCount).toBe(0);
  });

  it("(B) clubId=null (platform host) with a single global match succeeds", async () => {
    const r = await verifyPortalPasswordByEmail({
      clubId: null, email: fx.employee.personalEmail, password: PW,
    });
    expect(r.kind).toBe("success");
  });

  it("(C) accepts email with different casing / surrounding whitespace", async () => {
    const r = await verifyPortalPasswordByEmail({
      clubId: fx.clubA.id, email: "  CHRIS@Example.com  ", password: PW,
    });
    expect(r.kind).toBe("success");
  });
});

describe("HR mobile-hotfix · verifyPortalPasswordByEmail — failure paths (all neutral)", () => {
  let fx: Fx;
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => { await resetDb(); await seedRbac(); fx = await makeFx(); }, 60_000);

  it("(D) unknown email → not_recognised (no enumeration signal)", async () => {
    const r = await verifyPortalPasswordByEmail({
      clubId: fx.clubA.id, email: "ghost@nobody.com", password: PW,
    });
    expect(r.kind).toBe("not_recognised");
  });

  it("(E) wrong password → not_recognised + failedAttemptCount ticks", async () => {
    const r = await verifyPortalPasswordByEmail({
      clubId: fx.clubA.id, email: fx.employee.personalEmail, password: "totally-wrong-password",
    });
    expect(r.kind).toBe("not_recognised");
    const cred = await prisma.employeePortalCredential.findFirst({
      where: { employeeId: fx.employee.id },
    });
    expect(cred?.failedAttemptCount).toBe(1);
  });

  it("(F) clubId scope refuses a cross-Club match (Chris is in ClubA; login attempt scoped to ClubB)", async () => {
    const r = await verifyPortalPasswordByEmail({
      clubId: fx.clubB.id, email: fx.employee.personalEmail, password: PW,
    });
    expect(r.kind).toBe("not_recognised");
  });

  it("(G) missing email or password → not_recognised", async () => {
    expect((await verifyPortalPasswordByEmail({ clubId: fx.clubA.id, email: "", password: PW })).kind).toBe("not_recognised");
    expect((await verifyPortalPasswordByEmail({ clubId: fx.clubA.id, email: fx.employee.personalEmail, password: "" })).kind).toBe("not_recognised");
  });

  it("(H) AccountLock: 5 consecutive wrong passwords → 6th attempt with CORRECT password fails neutrally (locked)", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await verifyPortalPasswordByEmail({
        clubId: fx.clubA.id, email: fx.employee.personalEmail, password: `wrong-${i}`,
      });
      expect(r.kind).toBe("not_recognised");
    }
    const locked = await prisma.employeePortalCredential.findFirst({ where: { employeeId: fx.employee.id } });
    expect(locked?.lockedUntil).not.toBeNull();
    // A correct-password attempt while locked still returns not_recognised.
    const r = await verifyPortalPasswordByEmail({
      clubId: fx.clubA.id, email: fx.employee.personalEmail, password: PW,
    });
    expect(r.kind).toBe("not_recognised");
  });
});

describe("HR mobile-hotfix · Cross-Club ambiguity", () => {
  let fx: Fx;
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => { await resetDb(); await seedRbac(); fx = await makeFx(); }, 60_000);

  it("(I) SAME email at two different Clubs + clubId=null → ambiguous_across_clubs (service does NOT pick a winner)", async () => {
    // Second employee at ClubB with the same email + different password.
    await makeEmployeeWithCredential({
      clubId: fx.clubB.id, personalEmail: fx.employee.personalEmail,
      password: "different-password-here",
      firstName: "Other", lastName: "Person",
    });
    const r = await verifyPortalPasswordByEmail({
      clubId: null, email: fx.employee.personalEmail, password: PW,
    });
    expect(r.kind).toBe("ambiguous_across_clubs");
    if (r.kind === "ambiguous_across_clubs") {
      expect(r.clubIds.length).toBe(2);
      expect(r.clubIds).toContain(fx.clubA.id);
      expect(r.clubIds).toContain(fx.clubB.id);
    }
  });

  it("(J) SAME email at two Clubs + clubId=ClubA → unambiguous (Club-scoped lookup ignores ClubB)", async () => {
    await makeEmployeeWithCredential({
      clubId: fx.clubB.id, personalEmail: fx.employee.personalEmail,
      password: "different-password-here",
      firstName: "Other", lastName: "Person",
    });
    const r = await verifyPortalPasswordByEmail({
      clubId: fx.clubA.id, email: fx.employee.personalEmail, password: PW,
    });
    expect(r.kind).toBe("success");
    if (r.kind === "success") expect(r.clubId).toBe(fx.clubA.id);
  });
});

describe("HR mobile-hotfix · Email change — password preserved, old email stops authenticating", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => { await resetDb(); await seedRbac(); }, 60_000);

  it("(K) old@ works before change; after admin flips email, old@ fails and new@ works with same password", async () => {
    const club = await makeClub(`EmailChange ${Math.random().toString(36).slice(2, 6)}`);
    const emp = await makeEmployeeWithCredential({
      clubId: club.id, personalEmail: "old@example.com", password: PW,
    });
    // Before change: old email works.
    let r = await verifyPortalPasswordByEmail({ clubId: club.id, email: "old@example.com", password: PW });
    expect(r.kind).toBe("success");
    // Record the current password hash — must be UNCHANGED by an email flip.
    const credBefore = await prisma.employeePortalCredential.findUnique({ where: { employeeId: emp.id } });

    await prisma.employee.update({
      where: { id: emp.id },
      data: { personalEmail: "new@example.com" },
    });

    // Old email now fails neutrally.
    r = await verifyPortalPasswordByEmail({ clubId: club.id, email: "old@example.com", password: PW });
    expect(r.kind).toBe("not_recognised");
    // New email works with the SAME password (hash preserved).
    r = await verifyPortalPasswordByEmail({ clubId: club.id, email: "new@example.com", password: PW });
    expect(r.kind).toBe("success");
    // Hash byte-for-byte identical — no side-effect password rotation.
    const credAfter = await prisma.employeePortalCredential.findUnique({ where: { employeeId: emp.id } });
    expect(credAfter?.passwordHash).toBe(credBefore?.passwordHash);
  });
});
