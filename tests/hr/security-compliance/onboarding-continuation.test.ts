// HR-2B.3.2 §2 (2026-08-18) — Onboarding continuation resolver tests.
//
// The canonical `resolveOnboardingContinuation` service determines
// where an employee should land when they click their invitation
// link (whether fresh or resend, on any device, on any browser).
// These tests pin every interruption point the founder brief §2
// called out plus the terminal-state routing.
//
// Every assertion reads server-side persistent state ONLY. Browser
// storage / cookies never enter the calculation.

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { createSession, transitionSession } from "@/lib/hr/onboarding-sessions";
import { acquireInvitationContext } from "@/lib/hr/invitations";
import {
  acknowledgeSelfContactStep,
  acknowledgeSelfEmployment,
  acknowledgeSelfNameStep,
  attestSelfTd1,
  submitSelfBankAccount,
  submitSelfSin,
  submitSelfTaxProfile,
  updateSelfIdentity,
  uploadSelfPhoto,
} from "@/lib/hr/employee-self-service";
import type { EmployeeOnboardingActor } from "@/lib/hr/employee-actor";
import { resolveOnboardingContinuation, ONBOARDING_CONTINUATION_URLS } from "@/lib/hr/onboarding-continuation";
import { resetDb, seedRbac } from "../../util/db";
import { makeHrFixture } from "./_helpers";

const IP_HASH = createHash("sha256").update("test|salt", "utf8").digest("hex");
const SYNTHETIC_SIN = "046 454 286";

async function actorForFixture(name = "Continuation") {
  const { club, employee, clubAdmin } = await makeHrFixture(`${name} ${Math.random().toString(36).slice(2, 6)}`);
  const session = await createSession(clubAdmin, employee.id);
  const result = await transitionSession(clubAdmin, session.id, "INVITED", { actorSource: "STAFF" });
  const ctx = await acquireInvitationContext(result.invitation!.rawToken, { ipHash: IP_HASH });
  const actor: EmployeeOnboardingActor = {
    clubId: ctx.clubId,
    employeeId: ctx.employeeId,
    sessionId: ctx.sessionId,
    invitationId: ctx.invitationId,
    sessionState: "INVITED",
    redeemedAt: new Date().toISOString(),
  };
  return { club, employee, clubAdmin, actor };
}

async function resolveFor(actor: EmployeeOnboardingActor) {
  return resolveOnboardingContinuation({
    sessionId: actor.sessionId,
    employeeId: actor.employeeId,
    clubId: actor.clubId,
  });
}

describe("HR-2B.3.2 §2 · onboarding continuation resolver", () => {
  beforeEach(async () => {
    // Clear mailbox-side rows first (resetDb doesn't know about them)
    await prisma.club.updateMany({ data: { outboundMailboxConnectionId: null } }).catch(() => {});
    await prisma.emailMessage.deleteMany().catch(() => {});
    await prisma.mailboxSyncRun.deleteMany().catch(() => {});
    await prisma.graphSubscription.deleteMany().catch(() => {});
    await prisma.mailboxAccess.deleteMany().catch(() => {});
    await prisma.mailboxOAuthTransaction.deleteMany().catch(() => {});
    await prisma.mailboxConnection.deleteMany().catch(() => {});
    await resetDb();
    await seedRbac();
  });

  // ==== HR-2B.3.3 direct regression for the founder failure ==============
  //
  // BEFORE the fix, the resolver did:
  //   nameDone = Boolean(employee.preferredName?.trim())
  // Employees who submitted the Name form without entering an
  // optional preferredName looked "not done" — so the /about-you/
  // complete → Continue-to-payroll CTA (which routes through the
  // payroll hub → resolver) sent them BACKWARD to /about-you/name.
  // AFTER the fix, name completeness is a durable ack row.

  describe("§1 regression — preferredName is optional and does NOT gate Name completion", () => {
    it("Name ack + Contact ack + employment ack + photo → resolver advances to Payroll / sin (preferredName can be null)", async () => {
      const { actor, employee } = await actorForFixture("PreferredNameNull");
      // Explicitly do NOT set preferredName. Employee just clicks
      // through Name accepting whatever the Club recorded.
      await acknowledgeSelfNameStep(actor);
      await acknowledgeSelfContactStep(actor);
      await acknowledgeSelfEmployment(actor);
      await uploadSelfPhoto(actor, {
        bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        mimeType: "image/png",
      });
      const row = await prisma.employee.findUnique({ where: { id: employee.id } });
      expect(row!.preferredName).toBeNull();
      expect(await resolveFor(actor)).toBe(ONBOARDING_CONTINUATION_URLS.payrollSin);
    });

    it("preferredName present but Name ack absent → resolver returns Name (ack, not identity field, is the signal)", async () => {
      const { actor } = await actorForFixture("PreferredNameNoAck");
      // Employee has a preferredName value but never posted the Name
      // form (e.g. Club pre-filled it at Add Employee time). Must
      // still visit the Name step.
      await updateSelfIdentity(actor, { preferredName: "Chris" });
      expect(await resolveFor(actor)).toBe(ONBOARDING_CONTINUATION_URLS.aboutYouName);
    });
  });

  // ==== interruption points along the pipeline =========================

  it("brand-new session (nothing done) → About You / name", async () => {
    const { actor } = await actorForFixture("New");
    expect(await resolveFor(actor)).toBe(ONBOARDING_CONTINUATION_URLS.aboutYouName);
  });

  it("name saved (preferredName present) → About You / contact", async () => {
    const { actor } = await actorForFixture("PostName");
    await updateSelfIdentity(actor, { preferredName: "Chris" });
    await acknowledgeSelfNameStep(actor);
    expect(await resolveFor(actor)).toBe(ONBOARDING_CONTINUATION_URLS.aboutYouContact);
  });

  it("name + contact saved → About You / employment", async () => {
    const { actor } = await actorForFixture("PostContact");
    await updateSelfIdentity(actor, { preferredName: "Chris" });
    await acknowledgeSelfNameStep(actor);
    await updateSelfIdentity(actor, { personalEmail: "test@example.test" });
    await acknowledgeSelfContactStep(actor);
    expect(await resolveFor(actor)).toBe(ONBOARDING_CONTINUATION_URLS.aboutYouEmployment);
  });

  it("employment acknowledgement present → About You / photo", async () => {
    const { actor } = await actorForFixture("PostEmployment");
    await updateSelfIdentity(actor, { preferredName: "Chris" });
    await acknowledgeSelfNameStep(actor);
    await updateSelfIdentity(actor, { personalEmail: "test@example.test" });
    await acknowledgeSelfContactStep(actor);
    await acknowledgeSelfEmployment(actor);
    expect(await resolveFor(actor)).toBe(ONBOARDING_CONTINUATION_URLS.aboutYouPhoto);
  });

  it("photo uploaded → Payroll / sin (About You is fully done)", async () => {
    const { actor } = await actorForFixture("PostPhoto");
    await updateSelfIdentity(actor, { preferredName: "Chris" });
    await acknowledgeSelfNameStep(actor);
    await updateSelfIdentity(actor, { personalEmail: "test@example.test" });
    await acknowledgeSelfContactStep(actor);
    await acknowledgeSelfEmployment(actor);
    await uploadSelfPhoto(actor, {
      bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mimeType: "image/png",
    });
    expect(await resolveFor(actor)).toBe(ONBOARDING_CONTINUATION_URLS.payrollSin);
  });

  it("SIN saved → Payroll / direct-deposit", async () => {
    const { actor } = await actorForFixture("PostSin");
    await updateSelfIdentity(actor, { preferredName: "Chris" });
    await acknowledgeSelfNameStep(actor);
    await updateSelfIdentity(actor, { personalEmail: "test@example.test" });
    await acknowledgeSelfContactStep(actor);
    await acknowledgeSelfEmployment(actor);
    await uploadSelfPhoto(actor, {
      bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mimeType: "image/png",
    });
    await submitSelfSin(actor, SYNTHETIC_SIN);
    expect(await resolveFor(actor)).toBe(ONBOARDING_CONTINUATION_URLS.payrollDirectDeposit);
  });

  it("banking saved → Payroll / td1-federal", async () => {
    const { actor } = await actorForFixture("PostBanking");
    await updateSelfIdentity(actor, { preferredName: "Chris" });
    await acknowledgeSelfNameStep(actor);
    await updateSelfIdentity(actor, { personalEmail: "test@example.test" });
    await acknowledgeSelfContactStep(actor);
    await acknowledgeSelfEmployment(actor);
    await uploadSelfPhoto(actor, {
      bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mimeType: "image/png",
    });
    await submitSelfSin(actor, SYNTHETIC_SIN);
    await submitSelfBankAccount(actor, {
      holderName: "Bethany Nakamura",
      institutionNumber: "003",
      transitNumber: "12345",
      accountNumber: "1234567890",
    });
    expect(await resolveFor(actor)).toBe(ONBOARDING_CONTINUATION_URLS.payrollTd1Federal);
  });

  it("tax profile saved but no federal attestation → still Payroll / td1-federal", async () => {
    const { actor } = await actorForFixture("PostTaxNoFed");
    await updateSelfIdentity(actor, { preferredName: "Chris" });
    await acknowledgeSelfNameStep(actor);
    await updateSelfIdentity(actor, { personalEmail: "test@example.test" });
    await acknowledgeSelfContactStep(actor);
    await acknowledgeSelfEmployment(actor);
    await uploadSelfPhoto(actor, {
      bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mimeType: "image/png",
    });
    await submitSelfSin(actor, SYNTHETIC_SIN);
    await submitSelfBankAccount(actor, {
      holderName: "B N", institutionNumber: "003", transitNumber: "12345", accountNumber: "1234567890",
    });
    await submitSelfTaxProfile(actor, {
      province: "AB",
      td1FormVersion: "TD1-2026",
      effectiveFrom: new Date("2026-01-01"),
      federalClaim: "16129.00",
      provincialClaim: "22323.00",
    });
    // Federal attestation NOT yet made — the resolver must not skip it.
    expect(await resolveFor(actor)).toBe(ONBOARDING_CONTINUATION_URLS.payrollTd1Federal);
  });

  it("federal attestation done → Payroll / td1-provincial", async () => {
    const { actor } = await actorForFixture("PostFedAtt");
    await updateSelfIdentity(actor, { preferredName: "Chris" });
    await acknowledgeSelfNameStep(actor);
    await updateSelfIdentity(actor, { personalEmail: "test@example.test" });
    await acknowledgeSelfContactStep(actor);
    await acknowledgeSelfEmployment(actor);
    await uploadSelfPhoto(actor, {
      bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mimeType: "image/png",
    });
    await submitSelfSin(actor, SYNTHETIC_SIN);
    await submitSelfBankAccount(actor, {
      holderName: "B N", institutionNumber: "003", transitNumber: "12345", accountNumber: "1234567890",
    });
    await submitSelfTaxProfile(actor, {
      province: "AB",
      td1FormVersion: "TD1-2026",
      effectiveFrom: new Date("2026-01-01"),
      federalClaim: "16129.00",
      provincialClaim: "22323.00",
    });
    await attestSelfTd1(actor, "federal", "TD1-2026");
    expect(await resolveFor(actor)).toBe(ONBOARDING_CONTINUATION_URLS.payrollTd1Provincial);
  });


  it("both attestations done → HR-2B.4 Emergency (post-Payroll continuation)", async () => {
    // HR-2B.4 (2026-08-19) — post-payroll routing now flows through the
    // Emergency + Documents & Credentials stages before reaching the
    // ready-for-review boundary. This test previously expected
    // `payrollReview` because HR-2B.3 was the last stage the resolver
    // knew about; that URL still exists in the URL table but the
    // canonical resolver reaches Emergency FIRST (an emergency contact
    // hasn't been added, so Emergency is incomplete → route there).
    // Once Emergency + Documents complete, the same fixture would
    // resolve to `readyForReview` — see the HR-2B.4 tests for that
    // combined-completion path.
    const { actor } = await actorForFixture("PostAllAtt");
    await updateSelfIdentity(actor, { preferredName: "Chris" });
    await acknowledgeSelfNameStep(actor);
    await updateSelfIdentity(actor, { personalEmail: "test@example.test" });
    await acknowledgeSelfContactStep(actor);
    await acknowledgeSelfEmployment(actor);
    await uploadSelfPhoto(actor, {
      bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mimeType: "image/png",
    });
    await submitSelfSin(actor, SYNTHETIC_SIN);
    await submitSelfBankAccount(actor, {
      holderName: "B N", institutionNumber: "003", transitNumber: "12345", accountNumber: "1234567890",
    });
    await submitSelfTaxProfile(actor, {
      province: "AB",
      td1FormVersion: "TD1-2026",
      effectiveFrom: new Date("2026-01-01"),
      federalClaim: "16129.00",
      provincialClaim: "22323.00",
    });
    await attestSelfTd1(actor, "federal", "TD1-2026");
    await attestSelfTd1(actor, "provincial", "TD1AB-2026");
    expect(await resolveFor(actor)).toBe(ONBOARDING_CONTINUATION_URLS.emergency);
  });

  // ==== terminal state routing ==========================================

  it("SUBMITTED session → Payroll / complete (bypass resume flow)", async () => {
    const { actor, clubAdmin } = await actorForFixture("Submitted");
    // Advance session to IN_PROGRESS then SUBMITTED via staff path.
    await prisma.employeeOnboardingSession.update({
      where: { id: actor.sessionId },
      data: { state: "IN_PROGRESS" },
    });
    await transitionSession(clubAdmin, actor.sessionId, "SUBMITTED", {
      actorSource: "EMPLOYEE",
      actorEmployeeId: actor.employeeId,
    });
    expect(await resolveFor(actor)).toBe(ONBOARDING_CONTINUATION_URLS.payrollComplete);
  });

  it("REVOKED session → Payroll / complete (bypass — no resume for revoked)", async () => {
    const { actor, clubAdmin } = await actorForFixture("Revoked");
    await transitionSession(clubAdmin, actor.sessionId, "REVOKED", { actorSource: "STAFF" });
    expect(await resolveFor(actor)).toBe(ONBOARDING_CONTINUATION_URLS.payrollComplete);
  });

  it("nonexistent session (defence in depth) → expired", async () => {
    const result = await resolveOnboardingContinuation({
      sessionId: "cf_nonexistent",
      employeeId: "cf_nonexistent_e",
      clubId: "cf_nonexistent_c",
    });
    expect(result).toBe(ONBOARDING_CONTINUATION_URLS.expired);
  });

  // ==== cross-tenant safety =============================================

  it("actor from Club A cannot resolve a session that belongs to Club B", async () => {
    const a = await actorForFixture("Xtenant-A");
    const b = await actorForFixture("Xtenant-B");
    // Ask the resolver for Club B's session using Club A's employeeId/clubId.
    const result = await resolveOnboardingContinuation({
      sessionId: b.actor.sessionId,
      employeeId: a.actor.employeeId,
      clubId: a.actor.clubId,
    });
    // Session lookup is scoped by ALL three fields — no cross-tenant leak.
    expect(result).toBe(ONBOARDING_CONTINUATION_URLS.expired);
  });

  // ==== resend-preserves-continuation ===================================

  it("resend/reissue preserves the same continuation target (session + responses unchanged)", async () => {
    const { actor, clubAdmin } = await actorForFixture("Resend");
    // Advance to mid-flow: About You + SIN done, banking not.
    await updateSelfIdentity(actor, { preferredName: "Chris" });
    await acknowledgeSelfNameStep(actor);
    await updateSelfIdentity(actor, { personalEmail: "test@example.test" });
    await acknowledgeSelfContactStep(actor);
    await acknowledgeSelfEmployment(actor);
    await uploadSelfPhoto(actor, {
      bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mimeType: "image/png",
    });
    await submitSelfSin(actor, SYNTHETIC_SIN);
    const beforeReissue = await resolveFor(actor);
    expect(beforeReissue).toBe(ONBOARDING_CONTINUATION_URLS.payrollDirectDeposit);

    // Simulate a reissue: use canonical reissueInvitation service. The
    // session id + all persistent state stay intact — only the token
    // changes.
    const { reissueInvitation } = await import("@/lib/hr/invitations");
    await reissueInvitation(clubAdmin, actor.employeeId, {});

    // Continuation resolver reads the SAME sessionId → same target.
    const afterReissue = await resolveFor(actor);
    expect(afterReissue).toBe(ONBOARDING_CONTINUATION_URLS.payrollDirectDeposit);
    // And the SIN row still exists — not wiped by reissue.
    const sinRow = await prisma.employeeSensitiveIdentity.findFirst({
      where: { employeeId: actor.employeeId },
    });
    expect(sinRow?.sinLastThree).toBe("286");
  });
});
