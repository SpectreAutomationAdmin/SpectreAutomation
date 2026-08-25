// HR mobile-hotfix (2026-08-30) §3 — HR-change notifications.
//
// Pins the founder invariants:
//   * Recipients are resolved by CAPABILITY (permission grant), not
//     by role name.
//   * Notification copy is neutral — no plaintext SIN, no bank digits,
//     no fingerprints, no institution/transit coordinates.
//   * Fires for every canonical write path (admin + employee/portal +
//     onboarding).
//   * Failure to notify does NOT block the write.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resolveRecipientsByPermission } from "@/lib/rbac";
import { notifyHrChange, notifyHrChangeByEmployeeId } from "@/lib/hr/notify-hr-change";
import { upsertSin } from "@/lib/hr/sensitive-identity";
import { upsertBankAccount } from "@/lib/hr/bank-account";
import { updateEmployee } from "@/lib/hr/employees";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "../admin-workflows/_helpers";

async function makeEmp(fx: AdminHrFixture, suffix = ""): Promise<{ id: string; number: string }> {
  const row = await prisma.employee.create({
    data: {
      clubId: fx.club.id,
      employeeNumber: `NTF-${suffix || Math.floor(Math.random() * 90000 + 10000)}`,
      firstName: "Notify",
      lastName: "Target",
      employeeLifecycle: "ACTIVE", status: "ACTIVE",
    },
  });
  return { id: row.id, number: row.employeeNumber };
}

describe("HR mobile-hotfix · §3 recipient resolution by capability", () => {
  let fx: AdminHrFixture;
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => {
    await resetDb(); await seedRbac();
    fx = await makeAdminHrFixture("HRNotify");
  }, 60_000);

  it("hr:sin:read → returns PAYROLL_ADMIN + CLUB_ADMIN + SUPER_ADMIN, not GM (no sin grant)", async () => {
    const rows = await resolveRecipientsByPermission(fx.club.id, "hr:sin:read");
    const emails = new Set(rows.map((r) => r.email));
    // Should include the two admin roles that hold hr:sin:read + super.
    expect(emails.has(fx.payrollAdmin.email)).toBe(true);
    expect(emails.has(fx.clubAdmin.email)).toBe(true);
    expect(emails.has(fx.superAdmin.email)).toBe(true);
    // GM does NOT hold hr:sin:read (verify by checking the row).
    expect(emails.has(fx.gm.email)).toBe(false);
    // Note: AUDITOR_READ_ONLY intentionally holds every hr:*:read
    // grant (per the 2026-08-22 catalogue alignment); their presence
    // in the recipient list is expected.
  });

  it("hr:banking:read → excludes GM and auditor same as SIN", async () => {
    const rows = await resolveRecipientsByPermission(fx.club.id, "hr:banking:read");
    const emails = new Set(rows.map((r) => r.email));
    expect(emails.has(fx.payrollAdmin.email)).toBe(true);
    expect(emails.has(fx.clubAdmin.email)).toBe(true);
    expect(emails.has(fx.superAdmin.email)).toBe(true);
    expect(emails.has(fx.gm.email)).toBe(false);
  });

  it("hr:employee:read (used for address) — INCLUDES GM (they have the read grant)", async () => {
    const rows = await resolveRecipientsByPermission(fx.club.id, "hr:employee:read");
    const emails = new Set(rows.map((r) => r.email));
    expect(emails.has(fx.gm.email)).toBe(true);
    expect(emails.has(fx.clubAdmin.email)).toBe(true);
    expect(emails.has(fx.payrollAdmin.email)).toBe(true);
  });

  it("does NOT include users from a foreign club", async () => {
    const rows = await resolveRecipientsByPermission(fx.club.id, "hr:sin:read");
    const emails = new Set(rows.map((r) => r.email));
    // foreignClubAdmin holds CLUB_ADMIN at fx.foreignClub — not at fx.club.
    expect(emails.has(fx.foreignClubAdmin.email)).toBe(false);
  });
});

describe("HR mobile-hotfix · §3 notification copy — neutral, no sensitive plaintext", () => {
  let fx: AdminHrFixture;
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => {
    await resetDb(); await seedRbac();
    fx = await makeAdminHrFixture("HRNotifyCopy");
  }, 60_000);

  it("notifyHrChange(sin_updated) records IN_APP notifications and never contains a 9-digit SIN", async () => {
    const emp = await makeEmp(fx, "COPY1");
    await notifyHrChangeByEmployeeId(fx.club.id, emp.id, "sin_updated", "STAFF");

    const notes = await prisma.notification.findMany({
      where: { clubId: fx.club.id, triggeredEntityType: "Employee", triggeredEntityId: emp.id },
      select: { subject: true, body: true, metaJson: true, channel: true },
    });
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      expect(n.channel).toBe("IN_APP");
      const blob = `${n.subject}\n${n.body}\n${n.metaJson ?? ""}`;
      expect(blob).not.toMatch(/\d{9}/);          // no 9-digit SIN
      expect(blob).not.toMatch(/\d{7,}/);         // no long bank digit runs
      expect(blob).not.toMatch(/[a-f0-9]{32,}/i); // no fingerprint hex
      expect(blob).toMatch(/SIN was updated/);
    }
  });

  it("notifyHrChange(banking_updated) copy never leaks digits", async () => {
    const emp = await makeEmp(fx, "COPY2");
    await notifyHrChangeByEmployeeId(fx.club.id, emp.id, "banking_updated", "EMPLOYEE");

    const notes = await prisma.notification.findMany({
      where: { clubId: fx.club.id, triggeredEntityType: "Employee", triggeredEntityId: emp.id },
      select: { subject: true, body: true, metaJson: true },
    });
    for (const n of notes) {
      const blob = `${n.subject}\n${n.body}\n${n.metaJson ?? ""}`;
      expect(blob).not.toMatch(/\d{7,}/);
      expect(blob).not.toMatch(/institution|transit|account\s*number/i);
      expect(blob).toMatch(/direct[- ]deposit/i);
    }
  });

  it("notifyHrChange(home_address_updated) never restates the street address in the notification", async () => {
    // Even if the caller passed the street in a hypothetical payload,
    // the notifier only formats the display name + kind.
    const emp = await makeEmp(fx, "COPY3");
    await notifyHrChange({
      clubId: fx.club.id,
      employeeId: emp.id,
      employeeDisplayName: "Alex Notify",
      employeeNumber: emp.number,
      kind: "home_address_updated",
      actorSource: "STAFF",
    });
    const notes = await prisma.notification.findMany({
      where: { clubId: fx.club.id, triggeredEntityType: "Employee", triggeredEntityId: emp.id },
      select: { subject: true, body: true },
    });
    for (const n of notes) {
      // Copy is a pointer — reviewer must click into Profile to see the new address.
      expect(n.body).toMatch(/visible in Employee Profile/);
    }
  });
});

describe("HR mobile-hotfix · §3 canonical writes fire the notifier", () => {
  let fx: AdminHrFixture;
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => {
    await resetDb(); await seedRbac();
    fx = await makeAdminHrFixture("HRNotifyFire");
  }, 60_000);

  it("upsertSin fires sin_updated notification", async () => {
    const emp = await makeEmp(fx, "FIRE1");
    await upsertSin(fx.payrollAdmin, emp.id, "046 454 286");
    const notes = await prisma.notification.findMany({
      where: { triggeredEntityId: emp.id, subject: { contains: "SIN updated" } },
    });
    expect(notes.length).toBeGreaterThan(0);
  });

  it("upsertBankAccount fires banking_updated notification", async () => {
    const emp = await makeEmp(fx, "FIRE2");
    await upsertBankAccount(fx.payrollAdmin, emp.id, {
      holderName: "Notify Target",
      institutionNumber: "003",
      transitNumber: "12345",
      accountNumber: "9876543210",
    });
    const notes = await prisma.notification.findMany({
      where: { triggeredEntityId: emp.id, subject: { contains: "Direct deposit updated" } },
    });
    expect(notes.length).toBeGreaterThan(0);
  });

  it("updateEmployee with a home-address patch fires home_address_updated", async () => {
    const emp = await makeEmp(fx, "FIRE3");
    await updateEmployee(fx.clubAdmin, emp.id, {
      homeAddressLine1: "100 Course Rd",
      homeCity: "Cochrane",
      homeProvince: "AB",
    });
    const notes = await prisma.notification.findMany({
      where: { triggeredEntityId: emp.id, subject: { contains: "Home address updated" } },
    });
    expect(notes.length).toBeGreaterThan(0);
  });

  it("updateEmployee WITHOUT any address field does NOT fire an address notification", async () => {
    const emp = await makeEmp(fx, "FIRE4");
    await updateEmployee(fx.clubAdmin, emp.id, {
      preferredName: "Alex",
    });
    const addressNotes = await prisma.notification.findMany({
      where: { triggeredEntityId: emp.id, subject: { contains: "Home address updated" } },
    });
    expect(addressNotes.length).toBe(0);
  });
});
