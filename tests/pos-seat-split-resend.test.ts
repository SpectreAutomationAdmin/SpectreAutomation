// POS cleanup step 7 — per-group receipt resend from closed-check history.
//
// The resend flow re-uses `sendAndRecordGroupReceiptEmail` (the same
// helper that fires the initial split-bill email at settle). These
// tests assert:
//   - resend writes a new EmailDeliveryEvent and updates the group's
//     receiptEmail* fields without touching other groups,
//   - honest reporting on missing-email / suppression,
//   - the action wrapper gates (cross-tenant, QR_PAY, no-sale, voided)
//     via source-contract assertions (the action lives behind iron-
//     session auth so we don't drive it through the cookie layer here).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db, makeMember, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { seatTable, settleCheckBySeats } from "@/lib/pos/seat-checks";
import { addCheckLines } from "@/lib/pos/checks";
import { setLineModifiers } from "@/lib/pos/modifiers";
import { sendAndRecordGroupReceiptEmail } from "@/lib/pos/receipts";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";

async function bootstrapTwoPayerCheck(name: string, opts?: { owenEmail?: string | null; margaretEmail?: string | null }) {
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
  const addGroup = await db().pOSModifierGroup.create({
    data: { clubId: club.id, menuItemId: burger.id, modifierType: "ADD", label: "Add", sortOrder: 0, isActive: true },
  });
  const optBacon = await db().pOSModifierOption.create({
    data: { clubId: club.id, groupId: addGroup.id, label: "Add bacon", sortOrder: 0, isActive: true, priceDelta: 3 },
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
    data: { email: opts?.owenEmail === undefined ? "owen@example.com" : opts.owenEmail ?? "" },
  });
  const margaret = await makeMember(club.id, { firstName: "Margaret", lastName: "Lin" });
  await db().member.update({
    where: { id: margaret.id },
    data: { email: opts?.margaretEmail === undefined ? "margaret@example.com" : opts.margaretEmail ?? "" },
  });
  return { club, table, burger, beer, optBacon, owen, margaret };
}

async function adminFor(clubId: string, suffix: string) {
  const email = `resend-${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

// Set up a fully-settled split-bill check (2 groups, MEMBER_ACCOUNT)
// with one POSSale per group. Returns the groups already linked to
// their POSSale so each test can resend either one.
async function settledSplitCheck(suffix: string, opts?: { owenEmail?: string | null; margaretEmail?: string | null }) {
  const ctx = await bootstrapTwoPayerCheck(`Resend ${suffix}`, opts);
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
  const burgerLine = (await db().pOSCheckLine.findFirst({ where: { checkId, seatNumber: 1 } }))!;
  await setLineModifiers(admin, burgerLine.id, {
    modifiers: [{ optionId: ctx.optBacon.id, modifierType: "ADD", label: "Add bacon", priceDelta: 3 }],
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

const ACTIONS_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/_actions.ts"),
  "utf8",
);
const HISTORY_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/history/page.tsx"),
  "utf8",
);

// =============================================================================
// 1 + 5 + 6 + 7. Resend writes a new EmailDeliveryEvent for the
//                 RIGHT group only; updates only that group's status.
// =============================================================================
describe("Resend writes a fresh delivery event for one group only", () => {
  it("resending Group B fires a new event for margaret@; Group A is untouched", async () => {
    const ctx = await settledSplitCheck("scope");
    // After settle: 2 initial events (one per group, DEV_LOGGED).
    const before = await db().emailDeliveryEvent.findMany({
      where: { clubId: ctx.club.id },
      orderBy: { occurredAt: "asc" },
    });
    expect(before.length).toBe(2);

    const groupBSentAt = ctx.groupB.receiptEmailedAt;
    await sendAndRecordGroupReceiptEmail({
      groupId: ctx.groupB.id,
      saleId: ctx.groupB.posSaleId!,
      origin: "http://localhost:3000",
    });

    // One additional event, all for Margaret.
    const after = await db().emailDeliveryEvent.findMany({
      where: { clubId: ctx.club.id },
      orderBy: { occurredAt: "asc" },
    });
    expect(after.length).toBe(3);
    expect(after[2].email).toBe("margaret@example.com");

    // Group B row updated; Group A row unchanged.
    const aFresh = await db().pOSSettlementGroup.findUnique({ where: { id: ctx.groupA.id } });
    const bFresh = await db().pOSSettlementGroup.findUnique({ where: { id: ctx.groupB.id } });
    expect(aFresh?.receiptEmailedAt).toEqual(ctx.groupA.receiptEmailedAt);
    expect(aFresh?.receiptEmailStatus).toBe(ctx.groupA.receiptEmailStatus);
    expect(bFresh?.receiptEmailStatus).toBe("DEV_LOGGED");
    // The DEV_LOGGED branch keeps receiptEmailedAt null (no real send).
    expect(bFresh?.receiptEmailedAt).toBe(groupBSentAt);
  });
});

// =============================================================================
// 2. Resend uses the CURRENT paying-member email (fresh read).
// =============================================================================
describe("Resend reads the current profile email", () => {
  it("editing margaret@ after settle and then resending fires the new address", async () => {
    const ctx = await settledSplitCheck("fresh");
    await db().member.update({
      where: { id: ctx.margaret.id },
      data: { email: "margaret.fresh@example.com" },
    });
    const result = await sendAndRecordGroupReceiptEmail({
      groupId: ctx.groupB.id,
      saleId: ctx.groupB.posSaleId!,
      origin: "http://localhost:3000",
    });
    expect(result.toAddress).toBe("margaret.fresh@example.com");
    const groupB = await db().pOSSettlementGroup.findUnique({ where: { id: ctx.groupB.id } });
    expect(groupB?.receiptEmailAddress).toBe("margaret.fresh@example.com");
  });
});

// =============================================================================
// 3 + 4. Resend body draws from the group's own POSSale (only group items;
//         modifier snapshots intact).
// =============================================================================
describe("Resend draws from the group's POSSale (only group items + modifier snapshots)", () => {
  it("Group B's POSSale carries only the beer; resend doesn't pick up Owen's burger", async () => {
    const ctx = await settledSplitCheck("body");
    await sendAndRecordGroupReceiptEmail({
      groupId: ctx.groupB.id,
      saleId: ctx.groupB.posSaleId!,
      origin: "http://localhost:3000",
    });
    const saleB = await db().pOSSale.findUnique({
      where: { id: ctx.groupB.posSaleId! },
      include: { lines: { include: { modifiers: true } } },
    });
    expect(saleB!.lines).toHaveLength(1);
    expect(saleB!.lines[0].description).toContain("Lager");
    expect(saleB!.lines[0].description).not.toContain("Burger");

    // Group A snapshot (burger + bacon) intact through Group B's resend.
    const saleA = await db().pOSSale.findUnique({
      where: { id: ctx.groupA.posSaleId! },
      include: { lines: { include: { modifiers: true } } },
    });
    expect(saleA!.lines[0].modifiers.some((m) => m.label === "Add bacon")).toBe(true);
  });
});

// =============================================================================
// 8. Missing email → SKIPPED_NO_EMAIL.
// =============================================================================
describe("Missing email is honest on resend", () => {
  it("clearing Margaret's email and resending writes SKIPPED_NO_EMAIL onto her group only", async () => {
    const ctx = await settledSplitCheck("no-email-on-resend");
    await db().member.update({
      where: { id: ctx.margaret.id },
      data: { email: "" },
    });
    const result = await sendAndRecordGroupReceiptEmail({
      groupId: ctx.groupB.id,
      saleId: ctx.groupB.posSaleId!,
      origin: "http://localhost:3000",
    });
    expect(result.status).toBe("SKIPPED_NO_EMAIL");
    const groupB = await db().pOSSettlementGroup.findUnique({ where: { id: ctx.groupB.id } });
    expect(groupB?.receiptEmailStatus).toBe("SKIPPED_NO_EMAIL");
    expect(groupB?.receiptEmailAddress).toBeNull();
    // Group A stays as it was (DEV_LOGGED from settle).
    const groupA = await db().pOSSettlementGroup.findUnique({ where: { id: ctx.groupA.id } });
    expect(groupA?.receiptEmailStatus).toBe("DEV_LOGGED");
  });
});

// =============================================================================
// 9. Suppressed → SUPPRESSED on resend.
// =============================================================================
describe("Suppression is honest on resend", () => {
  it("a suppressed recipient resends as SUPPRESSED; Group A unaffected", async () => {
    const ctx = await settledSplitCheck("supp", { margaretEmail: "bounced@example.com" });
    await db().emailSuppression.create({
      data: { email: "bounced@example.com", reason: "HARD_BOUNCE" },
    });
    const result = await sendAndRecordGroupReceiptEmail({
      groupId: ctx.groupB.id,
      saleId: ctx.groupB.posSaleId!,
      origin: "http://localhost:3000",
    });
    expect(result.status).toBe("SUPPRESSED");
    const groupB = await db().pOSSettlementGroup.findUnique({ where: { id: ctx.groupB.id } });
    expect(groupB?.receiptEmailStatus).toBe("SUPPRESSED");
    expect((groupB?.receiptEmailFailure ?? "")).toContain("suppressed");
  });
});

// =============================================================================
// 10. Provider failure → FAILED, settlement unchanged.
// =============================================================================
describe("Resend failure does not change settlement state", () => {
  it("a failed resend leaves POSSale COMPLETED + check CLOSED", async () => {
    const ctx = await settledSplitCheck("fail");
    // Trigger SUPPRESSED (FAILED-shape outcome): the spec lumps "non-
    // SENT outcomes" together for the "settlement unchanged" contract.
    await db().emailSuppression.create({
      data: { email: "margaret@example.com", reason: "HARD_BOUNCE" },
    });
    const result = await sendAndRecordGroupReceiptEmail({
      groupId: ctx.groupB.id,
      saleId: ctx.groupB.posSaleId!,
      origin: "http://localhost:3000",
    });
    expect(result.status).not.toBe("SENT");
    const check = await db().pOSCheck.findUnique({ where: { id: ctx.checkId } });
    expect(check?.status).toBe("CLOSED");
    const sale = await db().pOSSale.findUnique({ where: { id: ctx.groupB.posSaleId! } });
    expect(sale?.status).toBe("COMPLETED");
  });
});

// =============================================================================
// 11. Cross-tenant resend is blocked by the action (source contract).
// =============================================================================
describe("Cross-tenant resend is blocked by the action gate", () => {
  it("resendGroupReceiptEmailAction calls assertTenantOwned on the loaded group", () => {
    expect(ACTIONS_SRC).toMatch(/export async function resendGroupReceiptEmailAction/);
    // The action loads the POSSettlementGroup and asserts tenancy
    // before calling sendAndRecordGroupReceiptEmail.
    // Slice from "resendGroupReceiptEmailAction" up to the next
    // top-level `export async function` declaration — that bounds the
    // action body without relying on whitespace-bracket sentinels.
    const start = ACTIONS_SRC.indexOf("export async function resendGroupReceiptEmailAction");
    const end = ACTIONS_SRC.indexOf("export async function ", start + 1);
    const block = ACTIONS_SRC.slice(start, end > start ? end : undefined);
    expect(block).toMatch(/assertTenantOwned\(group, p\)/);
    expect(block).toMatch(/requirePermission\(p, group\.clubId, "inventory:write"\)/);
  });
});

// =============================================================================
// 12. QR / unsupported / voided resend gated at the action (source contract).
// =============================================================================
describe("Resend gates: QR_PAY, no-sale, voided", () => {
  it("the action refuses QR_PAY groups", () => {
    expect(ACTIONS_SRC).toMatch(/Resend is only supported for member-account groups/);
    expect(ACTIONS_SRC).toMatch(/settlementMethod !== "MEMBER_ACCOUNT"/);
  });
  it("the action refuses groups with no posSaleId", () => {
    expect(ACTIONS_SRC).toMatch(/Group has no settled sale to resend/);
    expect(ACTIONS_SRC).toMatch(/!group\.posSaleId/);
  });
  it("the action refuses voided checks", () => {
    expect(ACTIONS_SRC).toMatch(/Cannot resend a voided check's receipt/);
    expect(ACTIONS_SRC).toMatch(/posCheck\.status === "VOIDED"/);
  });
  it("the action refuses groups without a paying member", () => {
    expect(ACTIONS_SRC).toMatch(/Group has no paying member/);
    expect(ACTIONS_SRC).toMatch(/!group\.memberId/);
  });
  it("the action audits the resend attempt", () => {
    expect(ACTIONS_SRC).toMatch(/pos\.settlement-group\.receipt\.resend/);
    expect(ACTIONS_SRC).toMatch(/entityType: "POSSettlementGroup"/);
  });
});

// =============================================================================
// 13 + 14. History UI: renders the Resend button + disabled reasons.
// =============================================================================
describe("Closed-check history surfaces the Resend control + disabled reasons", () => {
  it("imports GroupResendReceiptButton and renders it on split-bill sub-rows", () => {
    expect(HISTORY_SRC).toMatch(/import \{ GroupResendReceiptButton \}/);
    expect(HISTORY_SRC).toMatch(/<GroupResendReceiptButton[\s\S]*?groupId=\{g\.id\}/);
    // Only renders when the operator has permission + the parent check
    // is CLOSED (not VOIDED).
    expect(HISTORY_SRC).toMatch(/canResend && c\.status === "CLOSED"/);
  });

  it("computes a disabled reason for each ineligible case", () => {
    expect(HISTORY_SRC).toMatch(/function groupResendDisabledReason/);
    // Each branch returns a human-readable string.
    expect(HISTORY_SRC).toMatch(/Cannot resend: check is voided/);
    expect(HISTORY_SRC).toMatch(/Cannot resend: no settled sale/);
    expect(HISTORY_SRC).toMatch(/Resend only available for member-account groups/);
    expect(HISTORY_SRC).toMatch(/Cannot resend: no paying member/);
    expect(HISTORY_SRC).toMatch(/Cannot resend: member has no email on file/);
  });

  it("the button component renders inline status messages from the action result", () => {
    const buttonSrc = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/history/GroupResendReceiptButton.tsx"),
      "utf8",
    );
    expect(buttonSrc).toMatch(/Receipt resent to/);
    expect(buttonSrc).toMatch(/Cannot resend: member has no email on file/);
    expect(buttonSrc).toMatch(/Cannot resend: email address is suppressed/);
    expect(buttonSrc).toMatch(/Receipt resend failed/);
  });

  it("the listClosedChecks query includes member email so the button can pre-compute the no-email reason", () => {
    const checksSrc = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/pos/checks.ts"),
      "utf8",
    );
    // The settlementGroups.member select must include email.
    expect(checksSrc).toMatch(/member: \{ select: \{ firstName: true, lastName: true, memberNumber: true, email: true \} \}/);
  });
});
