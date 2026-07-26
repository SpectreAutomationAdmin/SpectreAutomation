// POS cleanup step 8 — split-bill hospitality survey invitations.
//
// Verifies that every paying member who receives a Lounge POS receipt
// gets their own survey link — including the per-group split-bill case
// that step 6 deliberately deferred. The single-check / merge-all path
// MUST still produce exactly one invitation; per-group resends must
// reuse the existing per-group invitation; ratings < threshold still
// notify the F&B department head.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { seatTable, settleCheckBySeats } from "@/lib/pos/seat-checks";
import { addCheckLines } from "@/lib/pos/checks";
import { sendAndRecordGroupReceiptEmail } from "@/lib/pos/receipts";
import {
  hashToken,
  resolveSurveyInvitation,
  submitSurveyResponse,
  upsertDepartmentNotificationRule,
  FOOD_BEVERAGE_DEPT_KEY,
  FOOD_BEVERAGE_DEPT_NAME,
  ensureSurveyInvitationForCheck,
} from "@/lib/hospitality/surveys";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";
import { ConflictError, NotFoundError } from "@/lib/errors";

async function bootstrapTwoPayerCheck(name: string, opts?: { owenEmail?: string; margaretEmail?: string }) {
  const club = await bootstrapAPClub(name);
  const fbDept = await db().department.findFirst({ where: { clubId: club.id, code: "FB" } });
  const loc = await db().pOSLocation.create({
    data: { clubId: club.id, code: LOUNGE_LOCATION_CODE, name: "Clubhouse Lounge", departmentId: fbDept?.id ?? null },
  });
  const terminal = await db().pOSTerminal.create({
    data: { clubId: club.id, code: LOUNGE_TERMINAL_CODE, name: "Lounge Terminal", locationId: loc.id },
  });
  await db().pOSSession.create({
    data: { clubId: club.id, locationId: loc.id, terminalId: terminal.id, status: "OPEN", openingFloat: 0 },
  });
  const foodCat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: loc.id, name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
  });
  const drinkCat = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: loc.id, name: "Drinks", sortOrder: 2, isActive: true, chitDestination: "BAR" },
  });
  const burger = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: foodCat.id, name: "The Silver Burger", price: 18, taxable: true, isActive: true },
  });
  const beer = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: drinkCat.id, name: "House Lager", price: 8, taxable: true, isActive: true },
  });
  const area = await db().diningArea.create({
    data: { clubId: club.id, name: "Lounge", sortOrder: 0 },
  });
  const table = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: area.id, tableNumber: "L4", capacity: 4,
      shape: "SQUARE", xPos: 460, yPos: 250, width: 110, height: 110,
    },
  });
  const owen = await makeMember(club.id, { firstName: "Owen", lastName: "Beauchamp" });
  await db().member.update({
    where: { id: owen.id },
    data: { email: opts?.owenEmail ?? "owen@example.com" },
  });
  const margaret = await makeMember(club.id, { firstName: "Margaret", lastName: "Lin" });
  await db().member.update({
    where: { id: margaret.id },
    data: { email: opts?.margaretEmail ?? "margaret@example.com" },
  });
  return { club, table, burger, beer, owen, margaret };
}

async function adminFor(clubId: string, suffix: string) {
  const email = `split-survey-${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

// Mint a fresh invitation for a settlement group + member that the
// settle path has already created an invitation for. The auto-created
// invitation only persisted the hash; tests that need to drive the
// /survey/[token] flow end-to-end need the RAW token, so we wipe the
// existing invitation and re-mint via ensureSurveyInvitationForCheck.
async function mintFreshInvitation(opts: {
  clubId: string;
  posCheckId: string;
  posSettlementGroupId: string;
  posSaleId: string | null;
  memberId: string;
}) {
  await db().hospitalitySurveyInvitation.deleteMany({
    where: { clubId: opts.clubId, posSettlementGroupId: opts.posSettlementGroupId },
  });
  return ensureSurveyInvitationForCheck({
    clubId: opts.clubId,
    posCheckId: opts.posCheckId,
    posSettlementGroupId: opts.posSettlementGroupId,
    posSaleId: opts.posSaleId,
    memberId: opts.memberId,
    origin: "http://localhost:3000",
  });
}

async function settledSplitCheck(suffix: string, opts?: { owenEmail?: string; margaretEmail?: string }) {
  const ctx = await bootstrapTwoPayerCheck(`Split Survey ${suffix}`, opts);
  const admin = await adminFor(ctx.club.id, suffix);
  const { checkId } = await seatTable(admin, ctx.club.id, {
    tableId: ctx.table.id, memberId: ctx.owen.id, partySize: 4,
  });
  await addCheckLines(admin, checkId, {
    items: [{ menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 }],
  });
  await addCheckLines(admin, checkId, {
    items: [{ menuItemId: ctx.beer.id, quantity: 1, seatNumber: 2 }],
  });
  await settleCheckBySeats(admin, checkId, {
    groups: [
      { label: "Group A — Seat 1", seatNumbers: [1], paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.owen.id },
      { label: "Group B — Seat 2", seatNumbers: [2], paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.margaret.id },
    ],
    allowUnsentLines: true,
  });
  const groups = await db().pOSSettlementGroup.findMany({
    where: { posCheckId: checkId },
    orderBy: { createdAt: "asc" },
  });
  const groupA = groups.find((g) => g.memberId === ctx.owen.id)!;
  const groupB = groups.find((g) => g.memberId === ctx.margaret.id)!;
  return { ...ctx, admin, checkId, groupA, groupB };
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// 1. Whole-check (merge-all) settle still creates exactly one invitation.
// =============================================================================
describe("Whole-check / merge-all still produces exactly one invitation", () => {
  it("a single-group settle yields one HospitalitySurveyInvitation with posSettlementGroupId=null", async () => {
    const ctx = await bootstrapTwoPayerCheck("merge");
    const admin = await adminFor(ctx.club.id, "merge");
    const { checkId } = await seatTable(admin, ctx.club.id, {
      tableId: ctx.table.id, memberId: ctx.owen.id, partySize: 4,
    });
    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 }],
    });
    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: ctx.beer.id, quantity: 1, seatNumber: 2 }],
    });
    await settleCheckBySeats(admin, checkId, {
      groups: [{
        label: "All seats", seatNumbers: [1, 2],
        paymentMethod: "MEMBER_ACCOUNT", memberId: ctx.owen.id,
      }],
      allowUnsentLines: true,
    });
    const invitations = await db().hospitalitySurveyInvitation.findMany({
      where: { clubId: ctx.club.id, posCheckId: checkId },
    });
    expect(invitations).toHaveLength(1);
    // Whole-check path: settlement-group anchor is null. The legacy
    // resend-and-reuse contract on POSCheck still holds.
    expect(invitations[0].posSettlementGroupId).toBeNull();
    expect(invitations[0].memberId).toBe(ctx.owen.id);
  });
});

// =============================================================================
// 2 + 3 + 4. Split-bill settle creates one invitation per MEMBER_ACCOUNT group,
//              each anchored to the right paying member.
// =============================================================================
describe("Split-bill settle — one survey invitation per MEMBER_ACCOUNT group", () => {
  it("two MEMBER_ACCOUNT groups → exactly two invitations, each scoped to its group + payer", async () => {
    const ctx = await settledSplitCheck("split");
    const invitations = await db().hospitalitySurveyInvitation.findMany({
      where: { clubId: ctx.club.id },
      orderBy: { createdAt: "asc" },
    });
    expect(invitations).toHaveLength(2);

    const owenInv = invitations.find((i) => i.memberId === ctx.owen.id)!;
    const margaretInv = invitations.find((i) => i.memberId === ctx.margaret.id)!;
    // Group anchor on each invitation matches the right settlement group.
    expect(owenInv.posSettlementGroupId).toBe(ctx.groupA.id);
    expect(margaretInv.posSettlementGroupId).toBe(ctx.groupB.id);
    // Sale anchor points at THAT group's POSSale, not the sibling's.
    expect(owenInv.posSaleId).toBe(ctx.groupA.posSaleId);
    expect(margaretInv.posSaleId).toBe(ctx.groupB.posSaleId);
    // Both anchored to the same POSCheck — the parent.
    expect(owenInv.posCheckId).toBe(ctx.checkId);
    expect(margaretInv.posCheckId).toBe(ctx.checkId);
    // F&B department key on both.
    expect(owenInv.departmentKey).toBe(FOOD_BEVERAGE_DEPT_KEY);
    expect(margaretInv.departmentKey).toBe(FOOD_BEVERAGE_DEPT_KEY);
    // Distinct token hashes.
    expect(owenInv.tokenHash).not.toBe(margaretInv.tokenHash);
    expect(owenInv.tokenHash.length).toBe(64);
    expect(margaretInv.tokenHash.length).toBe(64);
  });
});

// =============================================================================
// 5 + 6. Per-group resend reuses the existing per-group invitation.
// =============================================================================
describe("Per-group resend reuses the existing group invitation", () => {
  it("calling sendAndRecordGroupReceiptEmail twice for Group B → still exactly one invitation for Margaret", async () => {
    const ctx = await settledSplitCheck("reuse");
    // After the initial settle, we already have 2 invitations.
    const before = await db().hospitalitySurveyInvitation.findMany({
      where: { clubId: ctx.club.id, posSettlementGroupId: ctx.groupB.id },
    });
    expect(before).toHaveLength(1);
    const originalId = before[0].id;
    const originalHash = before[0].tokenHash;

    // Simulate a resend from the history page.
    await sendAndRecordGroupReceiptEmail({
      groupId: ctx.groupB.id,
      saleId: ctx.groupB.posSaleId!,
      origin: "http://localhost:3000",
    });
    const after = await db().hospitalitySurveyInvitation.findMany({
      where: { clubId: ctx.club.id, posSettlementGroupId: ctx.groupB.id },
    });
    expect(after).toHaveLength(1);
    // Same row, same token hash — token hygiene is preserved.
    expect(after[0].id).toBe(originalId);
    expect(after[0].tokenHash).toBe(originalHash);

    // And Group A is untouched.
    const groupAInvitations = await db().hospitalitySurveyInvitation.findMany({
      where: { clubId: ctx.club.id, posSettlementGroupId: ctx.groupA.id },
    });
    expect(groupAInvitations).toHaveLength(1);
  });

  it("ensureSurveyInvitationForCheck called with the same posSettlementGroupId returns the same invitation row", async () => {
    const ctx = await settledSplitCheck("ensure-idem");
    const first = await ensureSurveyInvitationForCheck({
      clubId: ctx.club.id,
      posCheckId: ctx.checkId,
      posSaleId: ctx.groupB.posSaleId,
      posSettlementGroupId: ctx.groupB.id,
      memberId: ctx.margaret.id,
      origin: "http://localhost:3000",
    });
    const second = await ensureSurveyInvitationForCheck({
      clubId: ctx.club.id,
      posCheckId: ctx.checkId,
      posSaleId: ctx.groupB.posSaleId,
      posSettlementGroupId: ctx.groupB.id,
      memberId: ctx.margaret.id,
      origin: "http://localhost:3000",
    });
    expect(first.invitationId).toBe(second.invitationId);
    // Reused invitations do NOT emit a fresh token (the hash-only
    // store can't reconstruct the original raw token).
    expect(second.token).toBeNull();
  });
});

// =============================================================================
// 7 + 8. Survey response from each group links to that group + payer + sale.
// =============================================================================
describe("Survey response links to the right group / payer / sale", () => {
  it("Owen submits 5/5 for Group A → response carries posSettlementGroupId of Group A", async () => {
    const ctx = await settledSplitCheck("response-A");
    const inv = await db().hospitalitySurveyInvitation.findFirst({
      where: { clubId: ctx.club.id, posSettlementGroupId: ctx.groupA.id },
    });
    expect(inv).toBeTruthy();
    // The settle path already created an invitation for this group;
    // we need the raw token to drive end-to-end. mintFresh wipes that
    // invitation and re-mints one we can fully control.
    const fresh = await mintFreshInvitation({
      clubId: ctx.club.id,
      posCheckId: ctx.checkId,
      posSettlementGroupId: ctx.groupA.id,
      posSaleId: ctx.groupA.posSaleId,
      memberId: ctx.owen.id,
    });
    expect(fresh.token).toBeTruthy();

    const r = await submitSurveyResponse({
      token: fresh.token!,
      rating: 5,
      comment: "Wonderful service",
    });
    const response = await db().hospitalitySurveyResponse.findUnique({
      where: { id: r.responseId },
    });
    expect(response).toBeTruthy();
    expect(response!.memberId).toBe(ctx.owen.id);
    expect(response!.posCheckId).toBe(ctx.checkId);
    expect(response!.posSaleId).toBe(ctx.groupA.posSaleId);
    expect(response!.posSettlementGroupId).toBe(ctx.groupA.id);
    expect(response!.departmentKey).toBe(FOOD_BEVERAGE_DEPT_KEY);
    expect(response!.rating).toBe(5);
    // 5/5 — no escalation, no urgency.
    expect(response!.serviceRecoveryStatus).toBe("NONE");
    expect(response!.urgent).toBe(false);
  });

  it("Margaret submits 4/5 for Group B → response carries posSettlementGroupId of Group B", async () => {
    const ctx = await settledSplitCheck("response-B");
    const fresh = await mintFreshInvitation({
      clubId: ctx.club.id,
      posCheckId: ctx.checkId,
      posSettlementGroupId: ctx.groupB.id,
      posSaleId: ctx.groupB.posSaleId,
      memberId: ctx.margaret.id,
    });
    const r = await submitSurveyResponse({
      token: fresh.token!,
      rating: 4,
      comment: "Service was slow",
    });
    const response = await db().hospitalitySurveyResponse.findUnique({
      where: { id: r.responseId },
    });
    expect(response!.memberId).toBe(ctx.margaret.id);
    expect(response!.posSettlementGroupId).toBe(ctx.groupB.id);
    expect(response!.rating).toBe(4);
  });
});

// =============================================================================
// 9. 4/5 from a split group notifies the F&B department head.
// =============================================================================
describe("4/5 split-group response routes the F&B notification", () => {
  it("with an F&B rule configured, a 4/5 submission marks notificationRouted=true + NEEDS_REVIEW", async () => {
    const ctx = await settledSplitCheck("escalate");
    // Configure the F&B department-head rule (notifies a user, threshold 5).
    const fbHead = await makeUser({
      email: `fb-head-${ctx.club.id}@example.com`,
      role: "CLUB_ADMIN", clubId: ctx.club.id,
    });
    await upsertDepartmentNotificationRule(ctx.admin, ctx.club.id, {
      departmentKey: FOOD_BEVERAGE_DEPT_KEY,
      departmentName: FOOD_BEVERAGE_DEPT_NAME,
      notifyUserId: fbHead.id,
      thresholdRating: 5,
    });

    const fresh = await mintFreshInvitation({
      clubId: ctx.club.id,
      posCheckId: ctx.checkId,
      posSettlementGroupId: ctx.groupB.id,
      posSaleId: ctx.groupB.posSaleId,
      memberId: ctx.margaret.id,
    });
    const r = await submitSurveyResponse({
      token: fresh.token!,
      rating: 4,
      comment: "Drink came out warm",
    });
    expect(r.escalated).toBe(true);
    expect(r.notificationRouted).toBe(true);
    const response = await db().hospitalitySurveyResponse.findUnique({
      where: { id: r.responseId },
    });
    expect(response!.serviceRecoveryStatus).toBe("NEEDS_REVIEW");
    expect(response!.notificationRouted).toBe(true);
    expect(response!.urgent).toBe(false);
  });
});

// =============================================================================
// 10. 5/5 response stores without escalation.
// =============================================================================
describe("5/5 split-group response stores without escalation", () => {
  it("no notification when rating equals threshold (5)", async () => {
    const ctx = await settledSplitCheck("no-escalate");
    await upsertDepartmentNotificationRule(ctx.admin, ctx.club.id, {
      departmentKey: FOOD_BEVERAGE_DEPT_KEY,
      departmentName: FOOD_BEVERAGE_DEPT_NAME,
      notifyEmail: `fb-${ctx.club.id}@example.com`,
      thresholdRating: 5,
    });
    const fresh = await mintFreshInvitation({
      clubId: ctx.club.id,
      posCheckId: ctx.checkId,
      posSettlementGroupId: ctx.groupA.id,
      posSaleId: ctx.groupA.posSaleId,
      memberId: ctx.owen.id,
    });
    const r = await submitSurveyResponse({
      token: fresh.token!,
      rating: 5,
    });
    expect(r.escalated).toBe(false);
    expect(r.notificationRouted).toBe(false);
    const response = await db().hospitalitySurveyResponse.findUnique({
      where: { id: r.responseId },
    });
    expect(response!.serviceRecoveryStatus).toBe("NONE");
    expect(response!.urgent).toBe(false);
  });
});

// =============================================================================
// 11. Invalid / expired tokens are rejected safely.
// =============================================================================
describe("Invalid + expired tokens are rejected with safe errors", () => {
  it("a random short token yields NotFoundError (no leak of which check)", async () => {
    await expect(resolveSurveyInvitation("bogus")).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveSurveyInvitation("not-a-real-token-string-aaaa")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an expired invitation is rejected with ConflictError and lazily flipped to EXPIRED", async () => {
    const ctx = await settledSplitCheck("expired");
    const fresh = await mintFreshInvitation({
      clubId: ctx.club.id,
      posCheckId: ctx.checkId,
      posSettlementGroupId: ctx.groupB.id,
      posSaleId: ctx.groupB.posSaleId,
      memberId: ctx.margaret.id,
    });
    // Force the invitation to be expired.
    await db().hospitalitySurveyInvitation.update({
      where: { id: fresh.invitationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(resolveSurveyInvitation(fresh.token!)).rejects.toBeInstanceOf(ConflictError);
    const after = await db().hospitalitySurveyInvitation.findUnique({
      where: { id: fresh.invitationId },
    });
    expect(after!.status).toBe("EXPIRED");
  });
});

// =============================================================================
// 12. Cross-tenant token access: a token issued in club A doesn't resolve
//     to club B's check via a bare token (token itself is club-agnostic at
//     this layer, but the resolved invitation must carry the correct club).
// =============================================================================
describe("Cross-tenant safety on the token", () => {
  it("resolveSurveyInvitation returns the issuing club's id (responses are scoped per club)", async () => {
    const a = await settledSplitCheck("xt-a");
    const b = await settledSplitCheck("xt-b");
    const aInv = await mintFreshInvitation({
      clubId: a.club.id,
      posCheckId: a.checkId,
      posSettlementGroupId: a.groupA.id,
      posSaleId: a.groupA.posSaleId,
      memberId: a.owen.id,
    });
    const resolved = await resolveSurveyInvitation(aInv.token!);
    expect(resolved.clubId).toBe(a.club.id);
    expect(resolved.clubId).not.toBe(b.club.id);
    // Submitting the response writes only to club A's tables — the
    // helper reads clubId from the invitation row.
    const r = await submitSurveyResponse({ token: aInv.token!, rating: 5 });
    const response = await db().hospitalitySurveyResponse.findUnique({
      where: { id: r.responseId },
    });
    expect(response!.clubId).toBe(a.club.id);
  });
});

// =============================================================================
// 13. Existing whole-check survey tests still pass (this file +
//     tests/hospitality-survey.test.ts both run in the regression sweep —
//     re-pin the most load-bearing invariants here so a regression here
//     can't slip past file-level isolation).
// =============================================================================
describe("Whole-check survey contract holds", () => {
  it("ensureSurveyInvitationForCheck with NO posSettlementGroupId is idempotent on (clubId, posCheckId)", async () => {
    const ctx = await bootstrapTwoPayerCheck("wc-idem");
    const admin = await adminFor(ctx.club.id, "wc-idem");
    const { checkId } = await seatTable(admin, ctx.club.id, {
      tableId: ctx.table.id, memberId: ctx.owen.id, partySize: 4,
    });
    await addCheckLines(admin, checkId, {
      items: [{ menuItemId: ctx.burger.id, quantity: 1, seatNumber: 1 }],
    });
    const first = await ensureSurveyInvitationForCheck({
      clubId: ctx.club.id,
      posCheckId: checkId,
      posSaleId: null,
      memberId: ctx.owen.id,
      origin: "http://localhost:3000",
    });
    const second = await ensureSurveyInvitationForCheck({
      clubId: ctx.club.id,
      posCheckId: checkId,
      posSaleId: null,
      memberId: ctx.owen.id,
      origin: "http://localhost:3000",
    });
    expect(first.invitationId).toBe(second.invitationId);
    expect(second.token).toBeNull();
    const allInvitations = await db().hospitalitySurveyInvitation.findMany({
      where: { clubId: ctx.club.id, posCheckId: checkId },
    });
    expect(allInvitations).toHaveLength(1);
    expect(allInvitations[0].posSettlementGroupId).toBeNull();
  });

  it("token hash hygiene: hashToken yields 64-char hex; raw tokens never appear in the DB", async () => {
    const ctx = await settledSplitCheck("hash");
    const invitations = await db().hospitalitySurveyInvitation.findMany({
      where: { clubId: ctx.club.id },
    });
    for (const inv of invitations) {
      expect(inv.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      // The hash should NOT contain the obvious raw artefacts.
      expect(inv.tokenHash).not.toContain("=");
      expect(inv.tokenHash).not.toContain("-");
      expect(inv.tokenHash).not.toContain("_");
    }
    // Sanity: hashToken("abc") is deterministic.
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });
});
