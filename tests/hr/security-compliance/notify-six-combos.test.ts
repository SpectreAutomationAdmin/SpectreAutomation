// HR mobile-hotfix continuation (2026-08-30) §9 — Six-combo
// origin/destination proof for HR-change notifications.
//
// For EVERY canonical mutation of Address / SIN / Banking, from
// EITHER the employee side OR the admin side, both the employee AND
// authorised admins receive an appropriately-worded notification.
// This suite pins ALL SIX combinations plus the negative invariants:
//   * unrelated user receives nothing;
//   * cross-Club user receives nothing;
//   * neither the employee nor admin body contains the underlying
//     SIN/bank plaintext.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { upsertSin } from "@/lib/hr/sensitive-identity";
import { upsertBankAccount } from "@/lib/hr/bank-account";
import { updateEmployee } from "@/lib/hr/employees";
import {
  submitSelfBankAccount,
  submitSelfSin,
  updateOnboardingHomeAddress,
  acknowledgeSelfNameStep,
  acknowledgeSelfContactStep,
  acknowledgeSelfAddressStep,
} from "@/lib/hr/employee-self-service";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { acquireInvitationContext } from "@/lib/hr/invitations";
import type { EmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { resetDb, seedRbac, makeUser, principalFor } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";
import { createHash } from "crypto";

const IP_HASH = createHash("sha256").update("test|salt", "utf8").digest("hex");
const SYNTHETIC_SIN = "046 454 286";

interface ScenarioActor {
  fx: AdminHrFixture;
  employeeId: string;
  employeeUserId: string;
  employeePersonalEmail: string;
  actor: EmployeeOnboardingActor;
}

/**
 * Materialise an onboarding actor for an employee that ALSO has a
 * linked User row + a personalEmail so we can prove both channels
 * (IN_APP to the linked User + EMAIL to personalEmail) fire.
 */
async function makeScenario(name: string): Promise<ScenarioActor> {
  const fx = await makeAdminHrFixture(`HRNotify6 ${name}`);
  const personalEmail = `emp-${Math.random().toString(36).slice(2, 8)}@example.com`;
  // Give the employee a linked User row so IN_APP delivery works.
  await makeUser({ email: personalEmail, role: "STAFF", clubId: fx.club.id });
  const empUser = await principalFor(personalEmail);
  const employee = await prisma.employee.create({
    data: {
      clubId: fx.club.id,
      employeeNumber: `NC6-${Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "Lise",
      lastName: "Testee",
      personalEmail,
      userId: empUser.id,
      employeeLifecycle: "PRE_HIRE", status: "ACTIVE",
    },
  });
  const session = await createSession(fx.clubAdmin, employee.id);
  const result = await transitionSession(fx.clubAdmin, session.id, "INVITED", { actorSource: "STAFF" });
  const ctx = await acquireInvitationContext(result.invitation!.rawToken, { ipHash: IP_HASH });
  const actor: EmployeeOnboardingActor = {
    clubId: ctx.clubId,
    employeeId: ctx.employeeId,
    sessionId: ctx.sessionId,
    invitationId: ctx.invitationId,
    sessionState: "INVITED",
    redeemedAt: new Date().toISOString(),
  };
  return {
    fx, employeeId: employee.id, employeeUserId: empUser.id,
    employeePersonalEmail: personalEmail, actor,
  };
}

async function fetchNotesFor(clubId: string, employeeId: string) {
  return prisma.notification.findMany({
    where: { clubId, triggeredEntityType: "Employee", triggeredEntityId: employeeId },
    select: {
      subject: true, body: true, channel: true, toUserId: true, toEmail: true,
      metaJson: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

function totalPlaintextBlob(notes: Awaited<ReturnType<typeof fetchNotesFor>>): string {
  return notes.map((n) => `${n.subject}\n${n.body}\n${n.metaJson ?? ""}`).join("\n\n");
}

function bodiesFor(notes: Awaited<ReturnType<typeof fetchNotesFor>>, audience: "ADMIN" | "EMPLOYEE") {
  return notes.filter((n) => {
    try { return (n.metaJson ? JSON.parse(n.metaJson) : {}).audience === audience; }
    catch { return false; }
  });
}

describe("HR mobile-hotfix · §9 six origin×destination combos", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);

  beforeEach(async () => { await resetDb(); await seedRbac(); }, 60_000);

  // ---------------- ADDRESS ----------------

  it("(1) EMPLOYEE updates address → employee + admin both notified", async () => {
    const s = await makeScenario("addrEmp");
    await acknowledgeSelfNameStep(s.actor);
    await acknowledgeSelfContactStep(s.actor);
    await updateOnboardingHomeAddress(s.actor, {
      homeAddressLine1: "77 Test Way",
      homeCity: "Calgary",
    });
    const notes = await fetchNotesFor(s.fx.club.id, s.employeeId);
    const admin = bodiesFor(notes, "ADMIN");
    const employee = bodiesFor(notes, "EMPLOYEE");
    expect(admin.length).toBeGreaterThan(0);
    expect(employee.length).toBeGreaterThan(0);
    // Employee got both a linked-User IN_APP and an EMAIL to personalEmail.
    expect(employee.some((n) => n.channel === "IN_APP" && n.toUserId === s.employeeUserId)).toBe(true);
    expect(employee.some((n) => n.channel === "EMAIL" && n.toEmail === s.employeePersonalEmail)).toBe(true);
    // Copy sanity: employee copy uses second person; admin copy uses third.
    expect(employee[0].subject).toMatch(/Your address was updated/i);
    expect(admin[0].subject).toMatch(/Home address updated for /);
    // No street address leaked.
    expect(totalPlaintextBlob(notes)).not.toMatch(/77 Test Way/);
  });

  it("(2) ADMIN updates address → employee + admin both notified", async () => {
    const s = await makeScenario("addrAdm");
    await updateEmployee(s.fx.clubAdmin, s.employeeId, {
      homeAddressLine1: "8 Ridge",
      homeCity: "Cochrane",
      homeProvince: "AB",
    });
    const notes = await fetchNotesFor(s.fx.club.id, s.employeeId);
    expect(bodiesFor(notes, "ADMIN").length).toBeGreaterThan(0);
    expect(bodiesFor(notes, "EMPLOYEE").length).toBeGreaterThan(0);
    expect(totalPlaintextBlob(notes)).not.toMatch(/8 Ridge/);
  });

  // ---------------- BANKING ----------------

  it("(3) EMPLOYEE updates banking → employee + admin both notified", async () => {
    const s = await makeScenario("bankEmp");
    await submitSelfBankAccount(s.actor, {
      holderName: "Lise Testee",
      institutionNumber: "003",
      transitNumber: "12345",
      accountNumber: "9876543210",
    });
    const notes = await fetchNotesFor(s.fx.club.id, s.employeeId);
    const admin = bodiesFor(notes, "ADMIN");
    const employee = bodiesFor(notes, "EMPLOYEE");
    expect(admin.length).toBeGreaterThan(0);
    expect(employee.length).toBeGreaterThan(0);
    expect(employee[0].subject).toMatch(/Your direct deposit information was updated/i);
    expect(admin[0].subject).toMatch(/Direct deposit updated for /);
    // No digits leaked.
    const blob = totalPlaintextBlob(notes);
    expect(blob).not.toMatch(/9876543210/);
    expect(blob).not.toMatch(/12345/);
    expect(blob).not.toMatch(/\b003\b/);
  });

  it("(4) ADMIN updates banking → employee + admin both notified", async () => {
    const s = await makeScenario("bankAdm");
    await upsertBankAccount(s.fx.payrollAdmin, s.employeeId, {
      holderName: "Lise Testee",
      institutionNumber: "003",
      transitNumber: "12345",
      accountNumber: "9876543210",
    });
    const notes = await fetchNotesFor(s.fx.club.id, s.employeeId);
    expect(bodiesFor(notes, "ADMIN").length).toBeGreaterThan(0);
    expect(bodiesFor(notes, "EMPLOYEE").length).toBeGreaterThan(0);
    const blob = totalPlaintextBlob(notes);
    expect(blob).not.toMatch(/9876543210/);
  });

  // ---------------- SIN ----------------

  it("(5) EMPLOYEE updates SIN → employee + admin both notified", async () => {
    const s = await makeScenario("sinEmp");
    await submitSelfSin(s.actor, SYNTHETIC_SIN);
    const notes = await fetchNotesFor(s.fx.club.id, s.employeeId);
    const admin = bodiesFor(notes, "ADMIN");
    const employee = bodiesFor(notes, "EMPLOYEE");
    expect(admin.length).toBeGreaterThan(0);
    expect(employee.length).toBeGreaterThan(0);
    expect(employee[0].subject).toMatch(/Your Social Insurance Number information was updated/i);
    expect(admin[0].subject).toMatch(/SIN updated for /);
    // No 9-digit run.
    expect(totalPlaintextBlob(notes)).not.toMatch(/\d{9}/);
    // Not even the SIN broken into groups.
    expect(totalPlaintextBlob(notes)).not.toMatch(/046 ?454 ?286/);
  });

  it("(6) ADMIN updates SIN → employee + admin both notified", async () => {
    const s = await makeScenario("sinAdm");
    await upsertSin(s.fx.payrollAdmin, s.employeeId, SYNTHETIC_SIN);
    const notes = await fetchNotesFor(s.fx.club.id, s.employeeId);
    expect(bodiesFor(notes, "ADMIN").length).toBeGreaterThan(0);
    expect(bodiesFor(notes, "EMPLOYEE").length).toBeGreaterThan(0);
    expect(totalPlaintextBlob(notes)).not.toMatch(/\d{9}/);
  });

  // ---------------- NEGATIVES ----------------

  it("unrelated Club user is never included", async () => {
    const s = await makeScenario("neg1");
    await upsertSin(s.fx.payrollAdmin, s.employeeId, SYNTHETIC_SIN);
    const notes = await fetchNotesFor(s.fx.club.id, s.employeeId);
    // foreignClubAdmin lives in a DIFFERENT Club — must never appear.
    const foreignUserId = s.fx.foreignClubAdmin.id;
    expect(notes.every((n) => n.toUserId !== foreignUserId)).toBe(true);
  });

  it("cross-Club notification never fires — a Club-B write leaves Club-A silent", async () => {
    const a = await makeScenario("crossA");
    // Fire an admin write in a completely separate Club fixture.
    const b = await makeScenario("crossB");
    await upsertSin(b.fx.payrollAdmin, b.employeeId, SYNTHETIC_SIN);
    const notesA = await fetchNotesFor(a.fx.club.id, a.employeeId);
    expect(notesA.length).toBe(0);
  });

  it("body/subject NEVER contain a raw SIN or bank digit run", async () => {
    const s = await makeScenario("scrub");
    await upsertSin(s.fx.payrollAdmin, s.employeeId, SYNTHETIC_SIN);
    await upsertBankAccount(s.fx.payrollAdmin, s.employeeId, {
      holderName: "Lise Testee",
      institutionNumber: "003",
      transitNumber: "12345",
      accountNumber: "9876543210",
    });
    const notes = await fetchNotesFor(s.fx.club.id, s.employeeId);
    for (const n of notes) {
      const scrub = `${n.subject}\n${n.body}`;
      expect(scrub).not.toMatch(/\d{9}/);            // no SIN
      expect(scrub).not.toMatch(/\d{7,}/);           // no bank digit run
      expect(scrub).not.toMatch(/[a-f0-9]{32,}/i);   // no fingerprint hex
      expect(scrub).not.toMatch(/institution\s*\d/i);
      expect(scrub).not.toMatch(/transit\s*\d/i);
    }
  });
});
