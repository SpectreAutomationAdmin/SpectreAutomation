// Lounge POS workflow — end-to-end coverage.
//
// Verifies the full flow that runs when a server rings up a sale in the
// Clubhouse Lounge POS:
//   menu read -> member lookup -> cart pricing -> sale creation +
//   completion -> AR Charge -> member balance -> GL JE -> dining widget
//   surfaces it -> receipt detail itemises it.
//
// Hostile paths:
//   - empty cart  -> rejected
//   - cross-tenant memberId -> rejected
//   - training mode active -> blocked
//   - support read-only session -> blocked

import { describe, it, expect, beforeEach } from "vitest";
import { db, makeUser, makeMember, resetDb, principalFor } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  listLoungeMenu,
  searchMembersForPos,
  priceLoungeCart,
  ringUpLoungeSale,
  listLoungeSales,
  listDiningForMember,
  getDiningReceipt,
  LOUNGE_LOCATION_CODE,
  LOUNGE_TERMINAL_CODE,
  GST_RATE,
} from "@/lib/pos/lounge";
import { ConflictError, ValidationError, ForbiddenError } from "@/lib/errors";
import { TrainingModeBlockedError } from "@/lib/training";
import { SupportReadOnlyError } from "@/lib/support-access";

// ---------------------------------------------------------------------------
// Fixture: a club with the lounge fully provisioned (location, terminal,
// menu) plus an admin principal authorised to ring up sales.
// ---------------------------------------------------------------------------
async function bootstrapLounge(name = "Lounge Test Club") {
  const club = await bootstrapAPClub(name);
  const fbDept = await db().department.findFirst({ where: { clubId: club.id, code: "FB" } });
  const location = await db().pOSLocation.create({
    data: { clubId: club.id, code: LOUNGE_LOCATION_CODE, name: "Clubhouse Lounge", departmentId: fbDept?.id ?? null },
  });
  const terminal = await db().pOSTerminal.create({
    data: { clubId: club.id, code: LOUNGE_TERMINAL_CODE, name: "Lounge Terminal 1", locationId: location.id },
  });
  await db().pOSSession.create({
    data: { clubId: club.id, locationId: location.id, terminalId: terminal.id, status: "OPEN", openingFloat: 0 },
  });
  // Mains
  const mains = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: location.id, name: "Mains", sortOrder: 1, isActive: true },
  });
  const cod = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: mains.id, name: "Miso & Sake Marinated Cod", price: 30, taxable: true, sortOrder: 0, isActive: true },
  });
  const desserts = await db().pOSMenuCategory.create({
    data: { clubId: club.id, locationId: location.id, name: "Desserts", sortOrder: 2, isActive: true },
  });
  const brulee = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: desserts.id, name: "Chocolate Crème Brûlée", price: 12, taxable: true, sortOrder: 0, isActive: true },
  });
  const tea = await db().pOSMenuItem.create({
    data: { clubId: club.id, categoryId: desserts.id, name: "Blueberry Tea", price: 7, taxable: true, sortOrder: 1, isActive: true },
  });
  return { club, location, terminal, items: { cod, brulee, tea } };
}

async function clubAdmin(clubId: string, suffix = "") {
  const email = `lng-admin${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

// ---------------------------------------------------------------------------
beforeEach(async () => { await resetDb(); });

describe("Lounge POS — menu + member read", () => {
  it("1. Menu items are seeded and readable through the service", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const menu = await listLoungeMenu(p, club.id);
    const allItems = menu.flatMap((c) => c.items);
    expect(allItems.find((i) => i.id === items.cod.id)?.price).toBe(30);
    expect(allItems.find((i) => i.id === items.brulee.id)?.price).toBe(12);
    // Categories are sorted by sortOrder.
    expect(menu.map((c) => c.name)).toEqual(["Mains", "Desserts"]);
  });

  it("2. Member lookup is tenant-scoped — a club admin can't see another club's members", async () => {
    const { club: clubA } = await bootstrapLounge("Club A");
    const { club: clubB } = await bootstrapLounge("Club B");
    const aliceA = await makeMember(clubA.id, { firstName: "Alice", lastName: "Anderson" });
    await makeMember(clubB.id, { firstName: "Alice", lastName: "Bramley" });
    const padmin = await clubAdmin(clubA.id, "a");
    const rows = await searchMembersForPos(padmin, clubA.id, "Alice");
    expect(rows.map((r) => r.id)).toEqual([aliceA.id]);
  });
});

describe("Lounge POS — cart math", () => {
  it("3. Cart subtotal sums quantity × unit price across lines", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const priced = await priceLoungeCart(p, club.id, {
      memberId: "ignored",
      items: [
        { menuItemId: items.cod.id, quantity: 2, note: null },     // 2 × 30 = 60
        { menuItemId: items.brulee.id, quantity: 1, note: null },  // 1 × 12 = 12
      ],
    });
    expect(priced.subtotal).toBe(72);
  });

  it("4. GST is exactly 5% of the taxable line subtotals", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const priced = await priceLoungeCart(p, club.id, {
      memberId: "ignored",
      items: [{ menuItemId: items.tea.id, quantity: 2, note: null }], // 2 × 7 = 14
    });
    expect(priced.subtotal).toBe(14);
    expect(priced.taxTotal).toBeCloseTo(14 * GST_RATE, 6);
    expect(priced.grandTotal).toBeCloseTo(14 + 14 * GST_RATE, 6);
  });
});

describe("Lounge POS — sale completion", () => {
  it("5–8. Charging the cart creates POSSale + lines + AR Charge and recomputes the member balance", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id, { firstName: "James", lastName: "Whitfield" });
    const before = await db().memberAccount.findUnique({ where: { memberId: member.id } });
    expect(before?.currentBalance ?? 0).toBe(0);

    const { sale } = await ringUpLoungeSale(p, club.id, {
      memberId: member.id,
      items: [
        { menuItemId: items.cod.id, quantity: 1, note: null },
        { menuItemId: items.brulee.id, quantity: 1, note: null },
      ],
    });

    // 5. POSSale exists and is COMPLETED.
    expect(sale.status).toBe("COMPLETED");
    expect(sale.memberId).toBe(member.id);
    // Subtotal 42, GST 5% = 2.10, grand total = 44.10.
    expect(Number(sale.grandTotal.toString())).toBeCloseTo(44.10, 2);

    // 6. Two POSSaleLine rows.
    const lines = await db().pOSSaleLine.findMany({ where: { saleId: sale.id } });
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.description).sort()).toEqual([
      "Chocolate Crème Brûlée", "Miso & Sake Marinated Cod",
    ]);

    // 7. AR Charge linked + categorised as F&B.
    expect(sale.arChargeId).toBeTruthy();
    const charge = await db().charge.findUnique({ where: { id: sale.arChargeId! } });
    expect(charge?.category).toBe("FOOD_BEVERAGE");
    expect(charge?.memberId).toBe(member.id);
    expect(charge?.amount).toBeCloseTo(44.10, 2);

    // 8. Member account current balance reflects the new charge.
    const after = await db().memberAccount.findUnique({ where: { memberId: member.id } });
    expect(after?.currentBalance ?? 0).toBeCloseTo(44.10, 2);
  });

  it("9. The posted GL journal entry balances (debits === credits)", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const { sale } = await ringUpLoungeSale(p, club.id, {
      memberId: member.id,
      items: [{ menuItemId: items.cod.id, quantity: 1, note: null }],
    });
    expect(sale.postedJournalEntryId).toBeTruthy();
    const je = await db().journalEntry.findUnique({
      where: { id: sale.postedJournalEntryId! },
      include: { lines: true },
    });
    expect(je?.status).toBe("POSTED");
    const dr = (je?.lines ?? []).reduce((s, l) => s + Number((l.debit ?? 0).toString()), 0);
    const cr = (je?.lines ?? []).reduce((s, l) => s + Number((l.credit ?? 0).toString()), 0);
    expect(dr).toBeCloseTo(cr, 6);
    expect(dr).toBeGreaterThan(0);
  });
});

describe("Lounge POS — posting-guard gates", () => {
  it("10. Training mode blocks sale completion", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    // Enable training mode for this club. `ClubTrainingMode.notes` is
    // the schema field for the reason text — there's no `reason` column.
    await db().clubTrainingMode.create({
      data: { clubId: club.id, enabled: true, enabledByUserId: p.id, notes: "test", enabledAt: new Date() },
    });
    await expect(
      ringUpLoungeSale(p, club.id, {
        memberId: member.id,
        items: [{ menuItemId: items.cod.id, quantity: 1, note: null }],
      })
    ).rejects.toBeInstanceOf(TrainingModeBlockedError);
  });

  it("11. Support read-only session blocks sale completion", async () => {
    const { club, items } = await bootstrapLounge();
    // A SUPER_ADMIN is the principal carrying out the action (matches
    // how real support staff approach a tenant). The posting-guard
    // hooks the support-session check off of (supportUserId, clubId),
    // not the principal's role — so any authenticated user with a live
    // READ_ONLY session is blocked.
    const supportEmail = `support-${club.id}@example.com`;
    await makeUser({ email: supportEmail, role: "SUPER_ADMIN", clubId: null });
    const p = await principalFor(supportEmail);
    // Bind the principal to the target club so they reach the posting
    // path; the support gate fires before the AR write.
    p.activeClubId = club.id;
    p.memberships = [{ clubId: club.id, roleKey: "SUPER_ADMIN" }];
    const member = await makeMember(club.id);
    const grant = await db().supportAccessGrant.create({
      data: {
        clubId: club.id, supportUserId: p.id,
        mode: "READ_ONLY", reason: "test",
        requestedByUserId: p.id,
        approvedAt: new Date(), approvedByUserId: p.id,
        expiresAt: new Date(Date.now() + 3600_000),
        status: "APPROVED",
      },
    });
    await db().supportSession.create({
      data: {
        clubId: club.id, supportUserId: p.id, grantId: grant.id,
        mode: "READ_ONLY",
        startedAt: new Date(),
      },
    });
    await expect(
      ringUpLoungeSale(p, club.id, {
        memberId: member.id,
        items: [{ menuItemId: items.cod.id, quantity: 1, note: null }],
      })
    ).rejects.toBeInstanceOf(SupportReadOnlyError);
  });
});

describe("Lounge POS — hostile inputs", () => {
  it("14. Charging another club's member is rejected (tenant boundary)", async () => {
    const { club: clubA, items: itemsA } = await bootstrapLounge("Club A");
    const { club: clubB } = await bootstrapLounge("Club B");
    // Admin of A. Member belongs to B.
    const adminA = await clubAdmin(clubA.id, "a");
    const memberB = await makeMember(clubB.id);
    await expect(
      ringUpLoungeSale(adminA, clubA.id, {
        memberId: memberB.id,
        items: [{ menuItemId: itemsA.cod.id, quantity: 1, note: null }],
      })
    ).rejects.toThrow(); // ForbiddenError (tenant) or ConflictError (cross-club)
  });

  it("15. Empty cart is rejected by the schema validator", async () => {
    const { club } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    await expect(
      ringUpLoungeSale(p, club.id, { memberId: member.id, items: [] })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("Lounge POS — member-side reads", () => {
  it("12. The dining widget read returns completed lounge sales for the member", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    const { sale } = await ringUpLoungeSale(p, club.id, {
      memberId: member.id,
      items: [{ menuItemId: items.cod.id, quantity: 1, note: null }],
    });
    const dining = await listDiningForMember(member.id);
    expect(dining.map((s) => s.id)).toContain(sale.id);
    expect(dining[0].location.name).toMatch(/lounge/i);
  });

  it("13. The receipt detail page returns the itemised sale only for the owning member", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const owner = await makeMember(club.id);
    const stranger = await makeMember(club.id);
    const { sale } = await ringUpLoungeSale(p, club.id, {
      memberId: owner.id,
      items: [
        { menuItemId: items.cod.id, quantity: 1, note: null },
        { menuItemId: items.brulee.id, quantity: 1, note: null },
      ],
    });

    // Owner sees the receipt with all lines.
    const ownReceipt = await getDiningReceipt(sale.id, owner.id);
    expect(ownReceipt?.lines).toHaveLength(2);
    expect(ownReceipt?.taxLines.length).toBeGreaterThan(0);
    expect(ownReceipt?.payments.length).toBeGreaterThan(0);

    // Another member at the same club cannot pull the receipt.
    const stale = await getDiningReceipt(sale.id, stranger.id);
    expect(stale).toBeNull();
  });

  it("Lounge history surfaces completed sales", async () => {
    const { club, items } = await bootstrapLounge();
    const p = await clubAdmin(club.id);
    const member = await makeMember(club.id);
    await ringUpLoungeSale(p, club.id, {
      memberId: member.id,
      items: [{ menuItemId: items.cod.id, quantity: 1, note: null }],
    });
    const sales = await listLoungeSales(p, club.id);
    expect(sales.length).toBeGreaterThan(0);
    expect(sales[0].location.code).toBe(LOUNGE_LOCATION_CODE);
  });
});
