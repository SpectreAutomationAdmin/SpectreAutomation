// Phase 14 — Pilot launch hardening: training/support gates at posting
// boundaries, Jonas import templates, email bounce handling, opening-balance
// subledger upload, pilot retrospective rollup, implementation playbook,
// refined go-live checklist.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeUser, makeMember, resetDb, principalFor, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { TrainingModeBlockedError, SupportReadOnlyError } from "@/lib/posting-guard";
import { enableTrainingMode } from "@/lib/training";
import { requestAccess, approveAccess, startSession } from "@/lib/support-access";
import { postCharge, voidCharge } from "@/lib/services/ar";
import * as ap from "@/lib/ap/invoices";
import { rotate as rotateWebhook } from "@/lib/webhooks/rotation";
import { createSubscription } from "@/lib/webhooks";
import { upsertSet, postSet } from "@/lib/opening-balance";
import { createBatch, validateBatch, commitBatch } from "@/lib/imports";
import { listTemplates, applyTemplateToBatch, upsertTemplate } from "@/lib/import-templates";
import { recordEvent, isSuppressed, addSuppression, resendWithCorrectedEmail } from "@/lib/email-delivery";
import { createInvite } from "@/lib/member-invites";
import { uploadSubledger, subledgerSummary } from "@/lib/opening-balance";
import { createRetrospective, addItem, addAction, closeRetrospective, captureMetricSnapshot } from "@/lib/retrospective";
import { getPlaybook, cloneIntoProject, exportMarkdown } from "@/lib/playbook";
import { createProject, saveStep, ONBOARDING_STEPS, recordSignoff } from "@/lib/pilot-onboarding";
import { buildSnapshot } from "@/lib/go-live";
import { setRateLimiter, inMemoryRateLimit } from "@/lib/security/rate-limit";

async function adminPrincipal(clubId: string) {
  const email = `admin-${clubId}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}
async function controllerPrincipal(clubId: string) {
  const email = `ctrl-${clubId}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await makeUser({ email, role: "CONTROLLER", clubId });
  return principalFor(email);
}
async function superPrincipal() {
  const email = `super-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@spectre.app`;
  await makeUser({ email, role: "SUPER_ADMIN", clubId: null });
  return principalFor(email);
}

// ===========================================================================
// 14A — Training-mode enforcement at posting boundaries
// ===========================================================================
describe("Phase 14A — Training-mode enforcement", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); setRateLimiter(inMemoryRateLimit); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("AR.postCharge throws TrainingModeBlockedError when club is in training mode", async () => {
    const club = await bootstrapAPClub("TM-AR");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id);
    await enableTrainingMode(p, { clubId: club.id });
    await expect(postCharge(p, member.id, { description: "Dues", category: "DUES", amount: 100 })).rejects.toBeInstanceOf(TrainingModeBlockedError);
  });

  it("AR.voidCharge is blocked too", async () => {
    const club = await bootstrapAPClub("TM-ARV");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id);
    const charge = await postCharge(p, member.id, { description: "X", category: "DUES", amount: 50 });
    await enableTrainingMode(p, { clubId: club.id });
    await expect(voidCharge(p, charge.id, "test")).rejects.toBeInstanceOf(TrainingModeBlockedError);
  });

  it("AP.postInvoice is blocked", async () => {
    const club = await bootstrapAPClub("TM-AP");
    const p = await adminPrincipal(club.id);
    // Don't bother creating a full invoice — even a missing record path should
    // hit the guard. We need a real invoice for postInvoice to do anything
    // useful, but the guard fires *before* the existence check inside the
    // function, so a non-existent id will throw guard first.
    await enableTrainingMode(p, { clubId: club.id });
    // Create a minimal invoice we can attempt to post.
    const vendor = await db().vendor.create({ data: { clubId: club.id, vendorNumber: "V-TM", legalName: "VTM", status: "ACTIVE" } });
    const inv = await db().aPInvoice.create({ data: {
      clubId: club.id, vendorId: vendor.id, invoiceNumber: "I-TM-1", invoiceDate: new Date(),
      dueDate: new Date(), subtotal: 100, taxTotal: 0, total: 100, status: "APPROVED",
    } });
    await expect(ap.postInvoice(p, inv.id)).rejects.toBeInstanceOf(TrainingModeBlockedError);
  });

  it("Opening balance postSet blocks in training mode", async () => {
    const club = await bootstrapAPClub("TM-OB");
    const admin = await adminPrincipal(club.id);
    const ctrl = await controllerPrincipal(club.id);
    const cash = await db().account.upsert({
      where: { clubId_accountNumber: { clubId: club.id, accountNumber: "OB-1000" } }, update: {},
      create: { clubId: club.id, accountNumber: "OB-1000", name: "Cash", type: "ASSET", normalBalance: "DEBIT" },
    });
    const equity = await db().account.upsert({
      where: { clubId_accountNumber: { clubId: club.id, accountNumber: "OB-3000" } }, update: {},
      create: { clubId: club.id, accountNumber: "OB-3000", name: "Equity", type: "EQUITY", normalBalance: "CREDIT" },
    });
    const year = await db().fiscalYear.create({ data: { clubId: club.id, label: "FY", startDate: new Date(), endDate: new Date(Date.now() + 86400e3 * 365), status: "OPEN" } });
    const period = await db().fiscalPeriod.create({ data: { clubId: club.id, fiscalYearId: year.id, label: "P", startDate: new Date(), endDate: new Date(Date.now() + 86400e3 * 30), status: "OPEN", sequence: 1 } });
    const set = await upsertSet(ctrl, { clubId: club.id, label: "L", balanceLines: [{ accountId: cash.id, debit: 1, credit: 0 }, { accountId: equity.id, debit: 0, credit: 1 }] });
    await enableTrainingMode(admin, { clubId: club.id });
    await expect(postSet(ctrl, set.id, period.id)).rejects.toBeInstanceOf(TrainingModeBlockedError);
  });

  it("Import commit of financial domain (COA) is blocked", async () => {
    const club = await bootstrapAPClub("TM-IMP");
    const p = await adminPrincipal(club.id);
    const batch = await createBatch(p, {
      clubId: club.id, domain: "COA",
      rows: [{ number: "9999", name: "Test", type: "ASSET" }],
    });
    await validateBatch(p, batch.id);
    await enableTrainingMode(p, { clubId: club.id });
    await expect(commitBatch(p, { batchId: batch.id })).rejects.toBeInstanceOf(TrainingModeBlockedError);
  });

  it("Non-financial import (MEMBERS) is allowed during training", async () => {
    const club = await bootstrapAPClub("TM-MEM");
    const p = await adminPrincipal(club.id);
    await enableTrainingMode(p, { clubId: club.id });
    const batch = await createBatch(p, {
      clubId: club.id, domain: "MEMBERS",
      rows: [{ memberNumber: "TM-1", firstName: "A", lastName: "A", email: "a@x.com" }],
    });
    await validateBatch(p, batch.id);
    const committed = await commitBatch(p, { batchId: batch.id });
    expect(committed.status).toBe("COMMITTED");
  });
});

// ===========================================================================
// 14B — Support-readonly enforcement
// ===========================================================================
describe("Phase 14B — Support-readonly enforcement", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("READ_ONLY support session blocks AR posting", async () => {
    const club = await bootstrapAPClub("SR-AR");
    const sp = await superPrincipal();
    const member = await makeMember(club.id);
    const grant = await requestAccess(sp, { clubId: club.id, reason: "Debug request - need to look at member data", mode: "READ_ONLY" });
    await approveAccess(sp, grant.id);
    await startSession(sp, { grantId: grant.id });
    await expect(postCharge(sp, member.id, { description: "X", category: "DUES", amount: 10 })).rejects.toBeInstanceOf(SupportReadOnlyError);
  });

  it("READ_ONLY support session blocks webhook secret rotation", async () => {
    const club = await bootstrapAPClub("SR-WH");
    const sp = await superPrincipal();
    const admin = await adminPrincipal(club.id);
    const { subscription } = await createSubscription(admin, club.id, {
      name: "Partner", url: "https://partner.example.com", events: ["member.created"],
    });
    const grant = await requestAccess(sp, { clubId: club.id, reason: "Investigate rotation issue per ticket 99", mode: "READ_ONLY" });
    await approveAccess(sp, grant.id);
    await startSession(sp, { grantId: grant.id });
    await expect(rotateWebhook(sp, { subscriptionId: subscription.id })).rejects.toBeInstanceOf(SupportReadOnlyError);
  });

  it("ELEVATED support session permits writes that READ_ONLY would block", async () => {
    const club = await bootstrapAPClub("SR-EL");
    const sp = await superPrincipal();
    const member = await makeMember(club.id);
    const grant = await requestAccess(sp, { clubId: club.id, reason: "Emergency data fix per ticket 42", mode: "ELEVATED" });
    await approveAccess(sp, grant.id);
    await startSession(sp, { grantId: grant.id });
    const charge = await postCharge(sp, member.id, { description: "Emergency credit", category: "ADJUSTMENT", amount: 50 });
    expect(charge.id).toBeTruthy();
  });
});

// ===========================================================================
// 14C — Saved import templates
// ===========================================================================
describe("Phase 14C — Jonas import templates", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("listTemplates seeds shipped Jonas + generic templates on first read", async () => {
    const templates = await listTemplates();
    expect(templates.some((t) => t.key === "jonas.members.v1")).toBe(true);
    expect(templates.some((t) => t.key === "jonas.coa.v1")).toBe(true);
    expect(templates.some((t) => t.key === "generic.csv.members.v1")).toBe(true);
  });

  it("applyTemplateToBatch copies the saved mapping into the batch", async () => {
    const club = await bootstrapAPClub("TPL-1");
    const p = await adminPrincipal(club.id);
    // Build a Jonas-shaped batch.
    const batch = await createBatch(p, {
      clubId: club.id, domain: "MEMBERS",
      rows: [{ "Member #": "J-1", "First Name": "Alice", "Last Name": "Anders", "Email Address": "a@x.com" }],
    });
    const templates = await listTemplates({ clubId: club.id, domain: "MEMBERS" });
    const jonas = templates.find((t) => t.key === "jonas.members.v1")!;
    await applyTemplateToBatch(p, { templateId: jonas.id, batchId: batch.id });
    const refreshed = await db().importBatch.findUnique({ where: { id: batch.id } });
    expect(refreshed?.mappingJson).toContain("Member #");
    // Now validate + commit should succeed because columns map correctly.
    const v = await validateBatch(p, batch.id);
    expect(v.validRows).toBe(1);
  });

  it("applyTemplateToBatch refuses when required columns are missing", async () => {
    const club = await bootstrapAPClub("TPL-2");
    const p = await adminPrincipal(club.id);
    const batch = await createBatch(p, {
      clubId: club.id, domain: "MEMBERS",
      rows: [{ "Some Other Header": "X", "Another": "Y" }],
    });
    const templates = await listTemplates({ clubId: club.id, domain: "MEMBERS" });
    const jonas = templates.find((t) => t.key === "jonas.members.v1")!;
    await expect(applyTemplateToBatch(p, { templateId: jonas.id, batchId: batch.id })).rejects.toBeInstanceOf(ValidationError);
  });

  it("non-SUPER_ADMIN cannot create a GLOBAL template", async () => {
    const club = await bootstrapAPClub("TPL-3");
    const p = await adminPrincipal(club.id);
    await expect(upsertTemplate(p, { domain: "MEMBERS", key: "custom.v1", name: "Custom", source: "CUSTOM" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ===========================================================================
// 14D — Email bounce handling
// ===========================================================================
describe("Phase 14D — Email bounce handling", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("HARD_BOUNCE adds the address to the suppression list and FAILs the invite", async () => {
    const club = await bootstrapAPClub("EB-1");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id);
    const { invite } = await createInvite(p, { clubId: club.id, memberId: member.id });
    await recordEvent({ clubId: club.id, email: member.email, kind: "HARD_BOUNCE", inviteId: invite.id, provider: "ses", reason: "no such mailbox" });
    expect((await isSuppressed(member.email, club.id)).suppressed).toBe(true);
    const refreshed = await db().memberPortalInvite.findUnique({ where: { id: invite.id } });
    expect(refreshed?.status).toBe("FAILED");
  });

  it("SOFT_BOUNCE does NOT suppress the address", async () => {
    const club = await bootstrapAPClub("EB-2");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id);
    const { invite } = await createInvite(p, { clubId: club.id, memberId: member.id });
    await recordEvent({ clubId: club.id, email: member.email, kind: "SOFT_BOUNCE", inviteId: invite.id, reason: "temp" });
    expect((await isSuppressed(member.email, club.id)).suppressed).toBe(false);
  });

  it("createInvite refuses to send to a suppressed address", async () => {
    const club = await bootstrapAPClub("EB-3");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id);
    await addSuppression(p, { clubId: club.id, email: member.email, reason: "MANUAL" });
    await expect(createInvite(p, { clubId: club.id, memberId: member.id })).rejects.toBeInstanceOf(ConflictError);
  });

  it("resendWithCorrectedEmail issues a fresh invite to the new address", async () => {
    const club = await bootstrapAPClub("EB-4");
    const p = await adminPrincipal(club.id);
    const member = await makeMember(club.id);
    const { invite } = await createInvite(p, { clubId: club.id, memberId: member.id });
    await recordEvent({ clubId: club.id, email: member.email, kind: "HARD_BOUNCE", inviteId: invite.id });
    const { invite: fresh } = await resendWithCorrectedEmail(p, { inviteId: invite.id, newEmail: `corrected-${member.id}@example.com` });
    expect(fresh.email).toContain("corrected-");
    expect(fresh.status).toBe("PENDING");
  });
});

// ===========================================================================
// 14E — Subledger upload
// ===========================================================================
describe("Phase 14E — Opening-balance subledger upload", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("uploadSubledger AR resolves memberNumbers to ids and surfaces unresolved refs", async () => {
    const club = await bootstrapAPClub("SL-1");
    const ctrl = await controllerPrincipal(club.id);
    const member = await db().member.create({
      data: { clubId: club.id, memberNumber: "SL-001", firstName: "A", lastName: "A", email: `a${Date.now()}@x.com`, status: "ACTIVE", paymentMethodStatus: "NONE" },
    });
    await db().memberAccount.create({ data: { clubId: club.id, memberId: member.id } });
    // Need a set to attach to.
    const cash = await db().account.upsert({
      where: { clubId_accountNumber: { clubId: club.id, accountNumber: "OB-1000" } }, update: {},
      create: { clubId: club.id, accountNumber: "OB-1000", name: "Cash", type: "ASSET", normalBalance: "DEBIT" },
    });
    const equity = await db().account.upsert({
      where: { clubId_accountNumber: { clubId: club.id, accountNumber: "OB-3000" } }, update: {},
      create: { clubId: club.id, accountNumber: "OB-3000", name: "Equity", type: "EQUITY", normalBalance: "CREDIT" },
    });
    const set = await upsertSet(ctrl, {
      clubId: club.id, label: "S",
      balanceLines: [{ accountId: cash.id, debit: 100, credit: 0 }, { accountId: equity.id, debit: 0, credit: 100 }],
    });
    const result = await uploadSubledger(ctrl, {
      setId: set.id, kind: "AR",
      rows: [
        { entityRef: "SL-001", balance: 60 },
        { entityRef: "DOES-NOT-EXIST", balance: 40 },
      ],
    });
    expect(result.resolved.length).toBe(1);
    expect(result.errors.length).toBe(1);
    const summary = await subledgerSummary(ctrl, set.id);
    expect(summary.ar.total).toBe(60);
  });
});

// ===========================================================================
// 14F — Pilot retrospective rollup
// ===========================================================================
describe("Phase 14F — Pilot retrospective", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("createRetrospective + addItem + addAction + close lifecycle", async () => {
    const club = await bootstrapAPClub("RT-1");
    const p = await adminPrincipal(club.id);
    const retro = await createRetrospective(p, { clubId: club.id, timing: "WEEK_1", title: "Week 1" });
    await addItem(p, { retrospectiveId: retro.id, category: "WORKFLOW_FRICTION", title: "Reports navigation is hard" });
    const action = await addAction(p, { retrospectiveId: retro.id, title: "Add reports shortcut" });
    // Cannot close while action is OPEN.
    await expect(closeRetrospective(p, retro.id)).rejects.toBeInstanceOf(ConflictError);
    await db().retrospectiveAction.update({ where: { id: action.id }, data: { status: "DONE" } });
    const closed = await closeRetrospective(p, retro.id);
    expect(closed.status).toBe("CLOSED");
  });

  it("captureMetricSnapshot produces a non-empty snapshot", async () => {
    const club = await bootstrapAPClub("RT-2");
    const p = await adminPrincipal(club.id);
    const snap = await captureMetricSnapshot(p, { clubId: club.id, label: "Day 1" });
    expect(snap.label).toBe("Day 1");
    expect(typeof snap.openTickets).toBe("number");
    expect(typeof snap.inviteActivationRate).toBe("number");
  });
});

// ===========================================================================
// 14G — Mobile CI workflows exist
// ===========================================================================
describe("Phase 14G — Mobile CI workflows", () => {
  it("workflow files exist on disk", async () => {
    const fs = await import("fs");
    expect(fs.existsSync(".github/workflows/mobile-ios.yml")).toBe(true);
    expect(fs.existsSync(".github/workflows/mobile-android.yml")).toBe(true);
    expect(fs.existsSync("mobile/BUILD.md")).toBe(true);
  });
});

// ===========================================================================
// 14H — Implementation playbook
// ===========================================================================
describe("Phase 14H — Implementation playbook", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("playbook has ordered entries spanning every wizard step", () => {
    const pb = getPlaybook();
    expect(pb.length).toBeGreaterThanOrEqual(15);
    const stepKeys = new Set(pb.map((e) => e.stepKey));
    expect(stepKeys.has("opening_balances")).toBe(true);
    expect(stepKeys.has("members_import")).toBe(true);
    expect(stepKeys.has("readiness")).toBe(true);
  });

  it("cloneIntoProject seeds tasks (idempotent)", async () => {
    const club = await bootstrapAPClub("PB-1");
    const p = await adminPrincipal(club.id);
    const project = await createProject(p, { clubId: club.id, name: "Pilot" });
    const r1 = await cloneIntoProject(p, project.id);
    expect(r1.created).toBeGreaterThan(0);
    const r2 = await cloneIntoProject(p, project.id);
    expect(r2.created).toBe(0); // idempotent
  });

  it("exportMarkdown is non-empty and includes every entry's title", () => {
    const md = exportMarkdown();
    for (const e of getPlaybook()) {
      expect(md).toContain(e.title);
    }
  });
});

// ===========================================================================
// 14I — Go-live checklist refinement
// ===========================================================================
describe("Phase 14I — Refined go-live checks", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("missing email provider becomes a hard block", async () => {
    const club = await bootstrapAPClub("GL-14");
    const p = await adminPrincipal(club.id);
    const project = await createProject(p, { clubId: club.id, name: "GL14" });
    for (const s of ONBOARDING_STEPS) {
      if (s.required) await saveStep(p, { projectId: project.id, stepKey: s.key, status: "COMPLETED" });
    }
    for (const cat of ["FINANCE", "OPS", "MEMBERSHIP", "SECURITY", "EXECUTIVE"]) {
      await recordSignoff(p, { projectId: project.id, category: cat, status: "SIGNED" });
    }
    const snap = await buildSnapshot(p, project.id);
    expect(snap.hardBlocks.some((h) => h.includes("Email provider"))).toBe(true);
    expect(snap.recommendation).toBe("NO_GO");
  });
});
