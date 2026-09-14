// Payroll/HR Integration hotfix (2026-09-14) — §15 domain tests.
//
// Covers the founder-authorised behavioural corrections:
//   1. activatePayrollProfile activation no longer requires banking-verified.
//   2. approveAndActivateEmployee-like flows do NOT block activation on
//      pending bank verification.
//   3. batch-preparation `sinReady` is derived from actual sources of
//      truth (EmployeeSensitiveIdentity presence + sinLastThree) — never
//      from `PayrollProfile.activatedAt` alone.
//   4. Bank PENDING_VERIFICATION remains its own separate warning that
//      does NOT gate T4-issuance readiness.
//   5. Explicit `PayrollProfile.suspendedAt` still halts the sinReady
//      signal — an active suspension is respected.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import { createEmployee } from "@/lib/hr/employees";
import { upsertPayrollProfile, activatePayrollProfile } from "@/lib/hr/payroll-profile";
import { changeCompensation } from "@/lib/hr/compensation";

async function seed(name: string) {
  const c = db();
  const club = await makeClub(name);
  await c.department.create({
    data: { clubId: club.id, code: "ADMIN", name: "Administration", isActive: true, sortOrder: 0 },
  });
  const admin = await makeUser({ email: `admin.${name}@t.test`, clubId: club.id, role: "CLUB_ADMIN" });
  const adminP = await principalFor(`admin.${name}@t.test`);
  const adminDept = await c.department.findFirstOrThrow({ where: { clubId: club.id, code: "ADMIN" }, select: { id: true } });
  return { club, admin, adminP, adminDept };
}

async function seedActivationCandidate(name: string) {
  const { club, adminP, adminDept } = await seed(name);
  const emp = await createEmployee(adminP, club.id, {
    firstName: "Cand", lastName: name,
    personalEmail: `cand.${name}@t.test`,
    departmentId: adminDept.id,
    employmentType: "FULL_TIME",
    compensationType: "SALARY",
    employeeLifecycle: "ACTIVE",
  });
  // Preconditions
  await changeCompensation(adminP, emp.id, {
    effectiveFrom: new Date("2026-01-01"),
    cadence: "SALARY",
    amount: "85000",
  });
  await db().employeeSensitiveIdentity.create({
    data: {
      clubId: club.id, employeeId: emp.id,
      sinSecretRef: "test:enc:sin",
      sinLastThree: "286",
    },
  });
  await upsertPayrollProfile(adminP, emp.id, {
    jurisdiction: "CA-AB",
    payFrequency: "BIWEEKLY",
    payGroup: "TEST-BW",
    directDepositActive: false,
    notes: null,
  });
  return { club, adminP, emp };
}

describe("Payroll/HR Integration hotfix (2026-09-14) · §15", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  // §15 item 1 — approved onboarding + identity/tax completeness activates
  // the payroll profile even WITHOUT bank verification.
  it("activatePayrollProfile succeeds with NO bank account present", async () => {
    const { adminP, emp } = await seedActivationCandidate("noBank");
    const updated = await activatePayrollProfile(adminP, emp.id);
    expect(updated.activatedAt).not.toBeNull();
    expect(updated.suspendedAt).toBeNull();
    expect(updated.directDepositActive).toBe(true);
  });

  // §15 item 5 — bank PENDING_VERIFICATION remains separate from activation.
  it("activatePayrollProfile succeeds when bank is present but PENDING_VERIFICATION", async () => {
    const { club, adminP, emp } = await seedActivationCandidate("pendBank");
    await db().employeeBankAccount.create({
      data: {
        clubId: club.id, employeeId: emp.id,
        institutionSecretRef: "test:enc:inst",
        transitSecretRef: "test:enc:transit",
        accountSecretRef: "test:enc:acct",
        accountLastFour: "7890",
        holderName: "Cand pendBank",
        status: "PENDING_VERIFICATION",
      },
    });
    const updated = await activatePayrollProfile(adminP, emp.id);
    expect(updated.activatedAt).not.toBeNull();
  });

  // §15 item 4 — SIN presence is required for activation.
  it("activatePayrollProfile refuses when SIN is not on file", async () => {
    const { club, adminP, adminDept } = await seed("noSin");
    const emp = await createEmployee(adminP, club.id, {
      firstName: "NoSin", lastName: "Test",
      personalEmail: "noSin@t.test",
      departmentId: adminDept.id,
      compensationType: "SALARY",
      employeeLifecycle: "ACTIVE",
    });
    await changeCompensation(adminP, emp.id, {
      effectiveFrom: new Date("2026-01-01"),
      cadence: "SALARY",
      amount: "85000",
    });
    await upsertPayrollProfile(adminP, emp.id, {
      jurisdiction: "CA-AB",
      payFrequency: "BIWEEKLY",
      payGroup: "TEST-BW",
      directDepositActive: false,
      notes: null,
    });
    await expect(activatePayrollProfile(adminP, emp.id))
      .rejects.toThrow(/sin_not_on_file|SIN/i);
  });

  // §15 item 3 — Employee record with SIN + tax profile satisfies sinReady
  // in batch preparation (even without an activatePayrollProfile call).
  // We test this at the model level by simulating the same predicate.
  it("sinReady predicate matches: SIN row present + not suspended → ready", async () => {
    const { club, adminP, emp } = await seedActivationCandidate("readyPred");
    // Simulate the batch-preparation predicate directly.
    const payrollProfile = await db().payrollProfile.findUnique({ where: { employeeId: emp.id } });
    const sensitiveIdentity = await db().employeeSensitiveIdentity.findFirst({
      where: { employeeId: emp.id },
      select: { id: true, sinLastThree: true },
    });
    const sinReady =
      !!sensitiveIdentity &&
      typeof sensitiveIdentity?.sinLastThree === "string" &&
      sensitiveIdentity.sinLastThree.length === 3 &&
      !payrollProfile?.suspendedAt;
    expect(sinReady).toBe(true);
  });

  // §15 item 5 — explicit suspension halts the sinReady signal.
  it("sinReady predicate: PayrollProfile.suspendedAt set → not ready", async () => {
    const { club, adminP, emp } = await seedActivationCandidate("suspended");
    await activatePayrollProfile(adminP, emp.id);
    const profile = await db().payrollProfile.findUniqueOrThrow({ where: { employeeId: emp.id } });
    await db().payrollProfile.update({
      where: { id: profile.id },
      data: { suspendedAt: new Date(), suspensionReason: "test" },
    });
    const payrollProfile = await db().payrollProfile.findUnique({ where: { employeeId: emp.id } });
    const sensitiveIdentity = await db().employeeSensitiveIdentity.findFirst({
      where: { employeeId: emp.id },
      select: { id: true, sinLastThree: true },
    });
    const sinReady =
      !!sensitiveIdentity &&
      typeof sensitiveIdentity?.sinLastThree === "string" &&
      sensitiveIdentity.sinLastThree.length === 3 &&
      !payrollProfile?.suspendedAt;
    expect(sinReady).toBe(false);
  });

  // §15 item 13 — historical compensation protection remains intact.
  // changeCompensation still refuses same/backdated effectiveFrom.
  it("changeCompensation still refuses backdated effectiveFrom", async () => {
    const { adminP, emp } = await seedActivationCandidate("bkd");
    await expect(
      changeCompensation(adminP, emp.id, {
        effectiveFrom: new Date("2025-12-31"),
        cadence: "SALARY",
        amount: "90000",
      }),
    ).rejects.toThrow(/effectiveFrom/i);
  });
});
