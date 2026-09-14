// Payroll-readiness + Tenant invitation integrity hotfix (2026-09-14).
// Covers §20 (TD1), §21 (payroll population + exclusion visibility),
// and §22 (invitation resend email).

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import { createEmployee } from "@/lib/hr/employees";
import { getEmployeeTaxReadiness } from "@/lib/hr/tax-readiness";
import { composeAdminInvitationEmail } from "@/lib/tenant-admin/invitation-email";

async function seedClub(name: string) {
  const c = db();
  const club = await makeClub(name);
  for (const [code, deptName] of [
    ["ADMIN", "Administration"],
  ] as const) {
    await c.department.create({
      data: { clubId: club.id, code, name: deptName, isActive: true, sortOrder: 0 },
    });
  }
  const admin = await makeUser({ email: `admin.${name}@t.test`, clubId: club.id, role: "CLUB_ADMIN" });
  const adminP = await principalFor(`admin.${name}@t.test`);
  const adminDept = await c.department.findFirstOrThrow({ where: { clubId: club.id, code: "ADMIN" }, select: { id: true } });
  return { club, admin, adminP, adminDept };
}

describe("Payroll-readiness · TD1 canonical resolver (§20)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  // §20 item 6 — resolver returns not-ready when no tax profile exists.
  it("returns NO_TAX_PROFILE for an Employee with no EmployeeTaxProfile row", async () => {
    const { club, adminP, adminDept } = await seedClub("noTax");
    const emp = await createEmployee(adminP, club.id, {
      firstName: "New", lastName: "Employee",
      personalEmail: "new@t.test", departmentId: adminDept.id,
      employeeLifecycle: "PRE_HIRE",
    });
    const r = await getEmployeeTaxReadiness(club.id, emp.id);
    expect(r.federal.ready).toBe(false);
    expect(r.provincial.ready).toBe(false);
    expect(r.taxProfileExists).toBe(false);
  });

  // §20 items 1-4 — federal + provincial ready when EmployeeTaxProfile exists.
  it("returns federal + provincial ready when EmployeeTaxProfile exists with province", async () => {
    const { club, adminP, adminDept } = await seedClub("tp");
    const emp = await createEmployee(adminP, club.id, {
      firstName: "Tax", lastName: "Profiled",
      personalEmail: "tax@t.test", departmentId: adminDept.id,
      employeeLifecycle: "PRE_HIRE",
    });
    await db().employeeTaxProfile.create({
      data: {
        clubId: club.id, employeeId: emp.id, province: "AB",
        td1FormVersion: "TD1AB-2026",
        effectiveFrom: new Date("2026-01-01"),
        federalClaimSecretRef: "test:fed",
        provincialClaimSecretRef: "test:prov",
      },
    });
    const r = await getEmployeeTaxReadiness(club.id, emp.id);
    expect(r.federal.ready).toBe(true);
    expect(r.provincial.ready).toBe(true);
    expect(r.province).toBe("AB");
    expect(r.td1FormVersion).toBe("TD1AB-2026");
  });

  // §20 item 6 — enriched completed-at timestamps come from acknowledgements when present.
  it("enriches completedAt from onboarding acknowledgements when present", async () => {
    const { club, admin, adminP, adminDept } = await seedClub("ack");
    const emp = await createEmployee(adminP, club.id, {
      firstName: "Marc", lastName: "Ack",
      personalEmail: "marc@t.test", departmentId: adminDept.id,
      employeeLifecycle: "PRE_HIRE",
    });
    await db().employeeTaxProfile.create({
      data: {
        clubId: club.id, employeeId: emp.id, province: "AB",
        td1FormVersion: "TD1AB-2026",
        effectiveFrom: new Date("2026-01-01"),
        federalClaimSecretRef: "test:fed",
        provincialClaimSecretRef: "test:prov",
      },
    });
    const session = await db().employeeOnboardingSession.create({
      data: {
        club: { connect: { id: club.id } },
        employee: { connect: { id: emp.id } },
        initiatedBy: { connect: { id: admin.id } },
        state: "IN_PROGRESS",
      },
    });
    const fedTs = new Date("2026-09-14T02:56:10Z");
    const provTs = new Date("2026-09-14T02:56:13Z");
    await db().employeeOnboardingAcknowledgement.create({
      data: {
        clubId: club.id, employeeId: emp.id, sessionId: session.id,
        kind: "td1_federal_attestation", acknowledgedAt: fedTs,
      },
    });
    await db().employeeOnboardingAcknowledgement.create({
      data: {
        clubId: club.id, employeeId: emp.id, sessionId: session.id,
        kind: "td1_provincial_attestation", acknowledgedAt: provTs,
      },
    });
    const r = await getEmployeeTaxReadiness(club.id, emp.id);
    expect(r.federalCompletedAt?.toISOString()).toBe(fedTs.toISOString());
    expect(r.provincialCompletedAt?.toISOString()).toBe(provTs.toISOString());
  });

  // §20 item 5 — batch-prep style consumers see ready regardless of ack presence
  //   (the batch calculator reads EmployeeTaxProfile, not acknowledgements).
  it("federal + provincial ready when profile exists but no acknowledgements", async () => {
    const { club, adminP, adminDept } = await seedClub("noack");
    const emp = await createEmployee(adminP, club.id, {
      firstName: "Only", lastName: "Profile",
      personalEmail: "only@t.test", departmentId: adminDept.id,
      employeeLifecycle: "PRE_HIRE",
    });
    await db().employeeTaxProfile.create({
      data: {
        clubId: club.id, employeeId: emp.id, province: "AB",
        td1FormVersion: "TD1AB-2026",
        effectiveFrom: new Date("2026-01-01"),
        federalClaimSecretRef: "test:fed",
        provincialClaimSecretRef: "test:prov",
      },
    });
    const r = await getEmployeeTaxReadiness(club.id, emp.id);
    expect(r.federal.ready).toBe(true);
    expect(r.provincial.ready).toBe(true);
    // completedAt falls back to effectiveFrom when acks absent.
    expect(r.federalCompletedAt).toBeNull();
    expect(r.provincialCompletedAt).toBeNull();
    expect(r.effectiveFrom?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("Tenant invitation email · resend variant (§22)", () => {
  // §22 item 13 — first invitation uses canonical composer with default subject.
  it("first invitation uses the canonical 'You've been invited' subject", () => {
    const composed = composeAdminInvitationEmail({
      clubName: "Coulee Ridge Golf & Country Club",
      inviterName: "Chris Turcato",
      displayName: "Marc Maldiney",
      isExistingUser: false,
      activationUrl: "https://staging.spectreautomation.com/invite/abc123",
      expiresAt: new Date("2026-09-21"),
    });
    expect(composed.subject).toContain("You've been invited");
    expect(composed.subject).toContain("Coulee Ridge Golf & Country Club");
    // Apostrophes in the HTML are HTML-entity-escaped, so we assert the
    // substring without the apostrophe. The text/plain body doesn't
    // duplicate the headline in the greeting — subject is the headline.
    expect(composed.html).toContain("been invited");
    // No resend preamble.
    expect(composed.html).not.toContain("fresh invitation link");
    expect(composed.text).not.toContain("fresh invitation link");
  });

  // §22 item 14 — resend uses same composer.
  // §22 item 19 — HTML body substantive (over 500 chars).
  // §22 item 20 — text fallback substantive.
  // §22 item 21 — body never equals "...".
  it("resend uses distinct subject + preamble but same composer", () => {
    const args = {
      clubName: "Coulee Ridge Golf & Country Club",
      inviterName: "Chris Turcato",
      displayName: "Marc Maldiney",
      isExistingUser: false,
      activationUrl: "https://staging.spectreautomation.com/invite/xyz789",
      expiresAt: new Date("2026-09-21"),
    };
    const first = composeAdminInvitationEmail({ ...args });
    const resent = composeAdminInvitationEmail({ ...args, isResend: true });

    // §22 item 14: same composer, produces different subject.
    expect(resent.subject).not.toBe(first.subject);
    expect(resent.subject).toContain("Resent");
    expect(resent.subject).toContain("Coulee Ridge Golf & Country Club");

    // Resent variant carries the distinguishing preamble.
    expect(resent.html).toContain("fresh invitation link");
    expect(resent.text).toContain("fresh invitation link");
    // Resent headline is distinct so Gmail can't thread it as identical.
    // (Apostrophes are HTML-escaped, so check the un-apostrophe substring.)
    expect(resent.html).toContain("your new invitation");
    expect(resent.html).not.toContain("been invited.");

    // §22 item 19 — HTML substantive.
    expect(resent.html.length).toBeGreaterThan(500);
    // §22 item 20 — text substantive.
    expect(resent.text.length).toBeGreaterThan(200);
    // §22 item 21 — body never equals "..." or is trivially empty.
    expect(resent.text.trim()).not.toBe("...");
    expect(resent.html.trim()).not.toBe("...");
    expect(resent.text).toContain(args.activationUrl);
    expect(resent.html).toContain(args.activationUrl);
  });

  it("both variants include recipient's name and inviter", () => {
    const args = {
      clubName: "Coulee Ridge",
      inviterName: "Chris Turcato",
      displayName: "Marc Maldiney",
      isExistingUser: false,
      activationUrl: "https://staging.spectreautomation.com/invite/tok",
      expiresAt: new Date("2026-09-21"),
    };
    for (const isResend of [false, true]) {
      const c = composeAdminInvitationEmail({ ...args, isResend });
      expect(c.text).toContain("Marc Maldiney");
      expect(c.text).toContain("Chris Turcato");
      expect(c.html).toContain("Marc Maldiney");
      expect(c.html).toContain("Chris Turcato");
      expect(c.subject).toContain("Coulee Ridge");
    }
  });
});
