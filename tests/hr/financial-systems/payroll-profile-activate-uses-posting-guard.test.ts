// HR-1 financial-systems — activate/deactivate go through the
// central posting guard (training-mode + support-readonly). The
// gate MUST fire for payroll-adjacent state changes so a support
// user with a READ_ONLY session cannot flip payroll on, and a club
// in training mode cannot accidentally start paying real money.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  TrainingModeBlockedError,
  SupportReadOnlyError,
} from "@/lib/posting-guard";
import { enableTrainingMode } from "@/lib/training";
import {
  requestAccess,
  approveAccess,
  startSession,
} from "@/lib/support-access";
import {
  activatePayrollProfile,
  deactivatePayrollProfile,
  upsertPayrollProfile,
} from "@/lib/hr/payroll-profile";
import { makeUser, principalFor, resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "../admin-workflows/_helpers";
import { seedActivationTrio } from "./_helpers";

async function superPrincipal() {
  const email = `super-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@spectre.app`;
  await makeUser({ email, role: "SUPER_ADMIN", clubId: null });
  return principalFor(email);
}

describe("HR financial-systems · activate/deactivate go through the posting guard", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("activatePayrollProfile throws TrainingModeBlockedError when the club is in training mode", async () => {
    const fx = await makeAdminHrFixture();
    await seedActivationTrio(fx.payrollAdmin, fx.employee.id);
    // Turn training mode ON for the club.
    await enableTrainingMode(fx.clubAdmin, { clubId: fx.club.id });
    await expect(
      activatePayrollProfile(fx.payrollAdmin, fx.employee.id),
    ).rejects.toBeInstanceOf(TrainingModeBlockedError);
  });

  it("deactivatePayrollProfile is also blocked by training mode (verb=void)", async () => {
    const fx = await makeAdminHrFixture();
    await seedActivationTrio(fx.payrollAdmin, fx.employee.id);
    await activatePayrollProfile(fx.payrollAdmin, fx.employee.id);
    await enableTrainingMode(fx.clubAdmin, { clubId: fx.club.id });
    await expect(
      deactivatePayrollProfile(fx.payrollAdmin, fx.employee.id, "test"),
    ).rejects.toBeInstanceOf(TrainingModeBlockedError);
  });

  it("READ_ONLY support session blocks activatePayrollProfile (verb=post)", async () => {
    const fx = await makeAdminHrFixture();
    // Prep the trio using the club's payroll admin (support session
    // hasn't started yet).
    await seedActivationTrio(fx.payrollAdmin, fx.employee.id);

    const sp = await superPrincipal();
    const grant = await requestAccess(sp, {
      clubId: fx.club.id,
      reason: "Investigate activation issue per support ticket",
      mode: "READ_ONLY",
    });
    await approveAccess(sp, grant.id);
    await startSession(sp, { grantId: grant.id });

    await expect(
      activatePayrollProfile(sp, fx.employee.id),
    ).rejects.toBeInstanceOf(SupportReadOnlyError);
  });

  it("READ_ONLY support session blocks deactivatePayrollProfile (verb=void)", async () => {
    const fx = await makeAdminHrFixture();
    await seedActivationTrio(fx.payrollAdmin, fx.employee.id);
    await activatePayrollProfile(fx.payrollAdmin, fx.employee.id);

    const sp = await superPrincipal();
    const grant = await requestAccess(sp, {
      clubId: fx.club.id,
      reason: "Investigate deactivation issue per support ticket",
      mode: "READ_ONLY",
    });
    await approveAccess(sp, grant.id);
    await startSession(sp, { grantId: grant.id });

    await expect(
      deactivatePayrollProfile(sp, fx.employee.id, "audit"),
    ).rejects.toBeInstanceOf(SupportReadOnlyError);
  });

  it("upsertPayrollProfile (draft CRUD) is NOT gated by posting guard — draft edits are permitted in training", async () => {
    // Deliberate: draft edits do not enable real payroll flow, so
    // the founder brief specifies NO posting guard on upsert. This
    // test pins that behaviour so someone tightening the guard
    // later must consciously loosen this test.
    const fx = await makeAdminHrFixture();
    await enableTrainingMode(fx.clubAdmin, { clubId: fx.club.id });
    const row = await upsertPayrollProfile(fx.payrollAdmin, fx.employee.id, {
      jurisdiction: "CA-ON", payGroup: "BIWEEKLY_HOURLY", payFrequency: "BIWEEKLY",
    });
    expect(row.jurisdiction).toBe("CA-ON");
    expect(row.activatedAt).toBeNull();
  });
});
