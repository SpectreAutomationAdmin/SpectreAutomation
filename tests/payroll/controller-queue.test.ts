// Payroll MVP posting hotfix (2026-09-07) — Controller queue
// authorization tests for the Payroll Processing page.
//
// The queue must only be visible to the user identified by
// PayrollClubConfig.controllerUserId. Broad payroll:read is NOT
// sufficient. The Payroll Admin must never see the queue on the
// Processing page.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { loadControllerFinalApprovalQueue } from "@/lib/payroll/controller-queue";

async function seedTwoUsersOneWiCard(opts: { clubName: string }) {
  const c = db();
  const club = await makeClub(opts.clubName);
  const raelene = await makeUser({ email: `raelene.${club.id}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
  const chris   = await makeUser({ email: `chris.${club.id}@t.test`,   role: "CONTROLLER",    clubId: club.id });
  const other   = await makeUser({ email: `other.${club.id}@t.test`,   role: "STAFF",         clubId: club.id });
  const raeleneP = await principalFor(raelene.email);
  const chrisP   = await principalFor(chris.email);
  const otherP   = await principalFor(other.email);

  await c.payrollClubConfig.create({
    data: {
      clubId: club.id, enabled: true, provinceOfEmployment: "AB",
      payrollAdminUserId: raelene.id, controllerUserId: chris.id,
    },
  });

  // Seed one PAYROLL_FINAL_APPROVAL WI + origin, owned by Chris.
  const wi = await c.workIntakeItem.create({
    data: {
      clubId: club.id,
      classification: "PAYROLL_FINAL_APPROVAL",
      workDomain: "PAYROLL",
      workIntent: "APPROVE",
      workSubtype: "PAYROLL_FINAL_APPROVAL",
      ownerUserId: chris.id,
      status: "OPEN",
      displaySourceLabel: "Payroll",
      displaySender: "Payroll orchestration",
      displaySubject: "Payroll ready for final approval",
      displayPreview: "9 salaried employees · Please review and approve.",
      displayReceivedAt: new Date(),
    },
  });
  await c.workIntakeOrigin.create({
    data: {
      clubId: club.id, workIntakeItemId: wi.id,
      kind: "PAYROLL_FINAL_APPROVAL", referenceId: "batch_seed_id", role: "PRIMARY",
    },
  });

  return { club, raelene, chris, other, raeleneP, chrisP, otherP };
}

describe("loadControllerFinalApprovalQueue — authorization", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("returns the queue when the caller IS the configured Controller (Chris)", async () => {
    const s = await seedTwoUsersOneWiCard({ clubName: "Ctrl Queue A" });
    const queue = await loadControllerFinalApprovalQueue(s.chrisP, s.club.id);
    expect(queue.length).toBe(1);
    expect(queue[0].reviewHref).toContain("/app/admin/payroll/batches/");
  });

  it("returns [] when the caller is the Payroll Admin (Raelene)", async () => {
    const s = await seedTwoUsersOneWiCard({ clubName: "Ctrl Queue B" });
    const queue = await loadControllerFinalApprovalQueue(s.raeleneP, s.club.id);
    expect(queue).toEqual([]);
  });

  it("returns [] when the caller has payroll:approve but is not the configured Controller", async () => {
    const s = await seedTwoUsersOneWiCard({ clubName: "Ctrl Queue C" });
    // A GENERAL_MANAGER has payroll:approve globally, but the queue is
    // still gated on the DB-configured controllerUserId.
    const gm = await makeUser({
      email: `gm.${s.club.id}@t.test`,
      role: "GENERAL_MANAGER",
      clubId: s.club.id,
    });
    const gmP = await principalFor(gm.email);
    const queue = await loadControllerFinalApprovalQueue(gmP, s.club.id);
    expect(queue).toEqual([]);
  });

  it("returns [] when no Controller is configured on the club", async () => {
    const s = await seedTwoUsersOneWiCard({ clubName: "Ctrl Queue D" });
    await db().payrollClubConfig.update({
      where: { clubId: s.club.id }, data: { controllerUserId: null },
    });
    const queue = await loadControllerFinalApprovalQueue(s.chrisP, s.club.id);
    expect(queue).toEqual([]);
  });
});
