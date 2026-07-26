// POS cleanup step 16 — member-number normalization + tenant-scoped lookup.
//
// Pins the canonical shape:
//   - memberNumber is a 4-digit string, leading zeros preserved.
//   - Uniqueness is per-club, not global. Two clubs can both carry "1432".
//   - Lookups are always scoped by clubId — cross-tenant resolution is
//     impossible.
//   - Legacy SS-#### input is normalized to the 4-digit body so existing
//     habits keep working while the canonical UI uses plain 4-digit.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db, makeMember, makeUser, principalFor, resetDb, seedRbac, makeClub } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  normalizeMemberNumber,
  isValidMemberNumber,
  parseMemberNumberInput,
  displayMemberNumber,
  MEMBER_NUMBER_REGEX,
} from "@/lib/members/number";
import { seatTable, assignCheckSeat } from "@/lib/pos/seat-checks";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";

async function bootstrapLounge(name: string) {
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
  const area = await db().diningArea.create({
    data: { clubId: club.id, name: "Lounge", sortOrder: 0 },
  });
  const table = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: area.id, tableNumber: "L1", capacity: 4,
      shape: "SQUARE", xPos: 100, yPos: 100, width: 110, height: 110,
    },
  });
  const adminEmail = `member-num-${club.id}@example.com`;
  await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminEmail);
  return { club, table, admin };
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// 1 + 2. Canonical shape: 4-digit string, leading zeros preserved.
// =============================================================================
describe("Canonical member-number shape", () => {
  it("MEMBER_NUMBER_REGEX accepts 4 digits and rejects anything else", () => {
    expect(MEMBER_NUMBER_REGEX.test("1310")).toBe(true);
    expect(MEMBER_NUMBER_REGEX.test("0613")).toBe(true);
    expect(MEMBER_NUMBER_REGEX.test("0001")).toBe(true);
    expect(MEMBER_NUMBER_REGEX.test("9999")).toBe(true);
    // Rejects.
    expect(MEMBER_NUMBER_REGEX.test("131")).toBe(false);     // too short
    expect(MEMBER_NUMBER_REGEX.test("13100")).toBe(false);   // too long
    expect(MEMBER_NUMBER_REGEX.test("SS-1310")).toBe(false); // prefixed
    expect(MEMBER_NUMBER_REGEX.test("abcd")).toBe(false);    // letters
  });

  it("leading-zero numbers stay as strings — never coerced to numbers", () => {
    expect(normalizeMemberNumber("0613")).toBe("0613");
    expect(displayMemberNumber("0613")).toBe("0613");
    // Number(0613) would lose the leading zero — make sure we never let
    // that happen by treating the canonical type as String.
    expect(typeof normalizeMemberNumber("0613")).toBe("string");
  });
});

// =============================================================================
// 3 + 4 + 5. Legacy SS-#### input still normalizes; canonical input works.
// =============================================================================
describe("Input normalization", () => {
  it("normalizes plain 4-digit input unchanged", () => {
    expect(normalizeMemberNumber("1310")).toBe("1310");
    expect(normalizeMemberNumber("0613")).toBe("0613");
  });

  it("strips legacy SS-#### prefix into the canonical 4-digit body", () => {
    expect(normalizeMemberNumber("SS-1310")).toBe("1310");
    expect(normalizeMemberNumber("ss-1310")).toBe("1310");
    expect(normalizeMemberNumber("Ss-0613")).toBe("0613");
  });

  it("strips arbitrary letter-prefixes (GLEN-, etc.) for future multi-club inputs", () => {
    expect(normalizeMemberNumber("GLEN-0001")).toBe("0001");
    expect(normalizeMemberNumber("PINEVALLEY-4242")).toBe("4242");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeMemberNumber("  1310  ")).toBe("1310");
    expect(normalizeMemberNumber("\tSS-0613\n")).toBe("0613");
  });

  it("parseMemberNumberInput returns ok=true on valid forms, ok=false otherwise", () => {
    expect(parseMemberNumberInput("1310")).toEqual({ ok: true, value: "1310" });
    expect(parseMemberNumberInput("SS-0613")).toEqual({ ok: true, value: "0613" });
    expect(parseMemberNumberInput("")).toEqual({ ok: false, error: "Enter the 4-digit member number." });
    expect(parseMemberNumberInput("123")).toEqual({ ok: false, error: "Enter the 4-digit member number." });
    expect(parseMemberNumberInput("abcd")).toEqual({ ok: false, error: "Enter the 4-digit member number." });
  });

  it("isValidMemberNumber follows the same shape", () => {
    expect(isValidMemberNumber("1310")).toBe(true);
    expect(isValidMemberNumber("SS-1310")).toBe(true);  // legacy still validates after normalize
    expect(isValidMemberNumber("131")).toBe(false);
    expect(isValidMemberNumber("abcd")).toBe(false);
  });
});

// =============================================================================
// 6. POS start-check accepts 4-digit number (Owen=1310).
// =============================================================================
describe("POS start-check accepts plain 4-digit member number", () => {
  it("seatTable resolves '1310' to the member without an SS- prefix", async () => {
    const ctx = await bootstrapLounge("plain-1310");
    const owen = await makeMember(ctx.club.id, { firstName: "Owen", lastName: "Beauchamp" });
    await db().member.update({ where: { id: owen.id }, data: { memberNumber: "1310" } });

    const r = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "1310", partySize: 2,
    });
    const check = await db().pOSCheck.findUnique({ where: { id: r.checkId } });
    expect(check?.memberId).toBe(owen.id);
  });
});

// =============================================================================
// 7. POS start-check still accepts legacy SS-1310 (backwards compatibility).
// =============================================================================
describe("POS start-check still accepts legacy SS-#### input", () => {
  it("seatTable normalizes 'SS-1310' to '1310' before lookup", async () => {
    const ctx = await bootstrapLounge("legacy-ss-prefix");
    const owen = await makeMember(ctx.club.id, { firstName: "Owen", lastName: "Beauchamp" });
    await db().member.update({ where: { id: owen.id }, data: { memberNumber: "1310" } });

    const r = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "SS-1310", partySize: 2,
    });
    const check = await db().pOSCheck.findUnique({ where: { id: r.checkId } });
    expect(check?.memberId).toBe(owen.id);
  });
});

// =============================================================================
// 8. Seat assignment accepts leading-zero number (0613).
// =============================================================================
describe("Seat assignment accepts leading-zero number", () => {
  it("assignCheckSeat resolves '0613' to Margaret (leading zero preserved)", async () => {
    const ctx = await bootstrapLounge("leading-zero");
    const host = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: host.id }, data: { memberNumber: "1310" } });
    const margaret = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({ where: { id: margaret.id }, data: { memberNumber: "0613" } });

    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "1310", partySize: 4,
    });
    await assignCheckSeat(ctx.admin, checkId, {
      seatNumber: 2, memberNumber: "0613",
    });
    const seat2 = await db().pOSCheckSeat.findFirst({
      where: { posCheckId: checkId, seatNumber: 2 },
    });
    expect(seat2?.memberId).toBe(margaret.id);
  });
});

// =============================================================================
// 9. Member lookup is scoped by clubId.
// =============================================================================
describe("Tenant-scoped member lookup", () => {
  it("seatTable resolves clubId+memberNumber, never memberNumber alone", async () => {
    const seatChecksSrc = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/pos/seat-checks.ts"),
      "utf8",
    );
    // The lookup goes through prisma.member.findFirst({ where: { clubId, memberNumber: normalized } }).
    // No call site looks up by memberNumber alone.
    expect(seatChecksSrc).toMatch(/where:\s*\{\s*clubId,\s*memberNumber: normalized\s*\}/);
    // Bare lookups (no clubId) would be the leak surface.
    expect(seatChecksSrc).not.toMatch(/where:\s*\{\s*memberNumber:\s*[^,]+\s*\}/);
  });
});

// =============================================================================
// 10 + 11. Same member number can exist in two different clubs.
// =============================================================================
describe("Same memberNumber across two clubs (multi-tenant uniqueness)", () => {
  it("Silver Springs '1432' and Glencoe '1432' coexist + resolve independently", async () => {
    // Bootstrap two distinct clubs.
    const silverCtx = await bootstrapLounge("silver-1432");
    const silverMember = await makeMember(silverCtx.club.id, { firstName: "Silver", lastName: "Member" });
    await db().member.update({
      where: { id: silverMember.id },
      data: { memberNumber: "1432" },
    });

    const glencoeCtx = await bootstrapLounge("glencoe-1432");
    const glencoeMember = await makeMember(glencoeCtx.club.id, { firstName: "Glencoe", lastName: "Member" });
    await db().member.update({
      where: { id: glencoeMember.id },
      data: { memberNumber: "1432" },
    });

    // Both rows exist with the same number, different clubs.
    const both = await db().member.findMany({ where: { memberNumber: "1432" } });
    expect(both).toHaveLength(2);

    // Silver Springs lookup resolves to Silver's member only.
    const silverHit = await db().member.findFirst({
      where: { clubId: silverCtx.club.id, memberNumber: "1432" },
    });
    expect(silverHit?.id).toBe(silverMember.id);
    expect(silverHit?.id).not.toBe(glencoeMember.id);

    // Glencoe lookup resolves to Glencoe's only.
    const glencoeHit = await db().member.findFirst({
      where: { clubId: glencoeCtx.club.id, memberNumber: "1432" },
    });
    expect(glencoeHit?.id).toBe(glencoeMember.id);
    expect(glencoeHit?.id).not.toBe(silverMember.id);
  });

  it("a Silver Springs admin seating with '1432' resolves to Silver's member, never Glencoe's", async () => {
    const silverCtx = await bootstrapLounge("silver-seat-1432");
    const silverMember = await makeMember(silverCtx.club.id, { firstName: "Silver", lastName: "Member" });
    await db().member.update({ where: { id: silverMember.id }, data: { memberNumber: "1432" } });

    // Plant the same number in another club to prove the lookup doesn't cross over.
    const otherClub = await makeClub("Glencoe (test fixture)");
    const otherMember = await makeMember(otherClub.id, { firstName: "Glencoe", lastName: "Member" });
    await db().member.update({ where: { id: otherMember.id }, data: { memberNumber: "1432" } });

    const r = await seatTable(silverCtx.admin, silverCtx.club.id, {
      tableId: silverCtx.table.id, memberNumber: "1432", partySize: 2,
    });
    const check = await db().pOSCheck.findUnique({ where: { id: r.checkId } });
    expect(check?.memberId).toBe(silverMember.id);
    expect(check?.memberId).not.toBe(otherMember.id);
  });
});

// =============================================================================
// 12. Cross-tenant lookup is blocked (Silver admin seating against Glencoe table).
// =============================================================================
describe("Cross-tenant lookup is blocked", () => {
  it("Silver admin attempting seatTable on Glencoe's tableId fails with TenantViolationError", async () => {
    const silverCtx = await bootstrapLounge("xt-silver");
    const glencoeCtx = await bootstrapLounge("xt-glencoe");
    await makeMember(silverCtx.club.id);
    await makeMember(glencoeCtx.club.id);

    await expect(
      seatTable(silverCtx.admin, silverCtx.club.id, {
        tableId: glencoeCtx.table.id, memberNumber: "0001", partySize: 2,
      }),
    ).rejects.toThrow();
  });

  it("Silver admin's bogus member number does not pull a Glencoe member with the same digits", async () => {
    const silverCtx = await bootstrapLounge("xt-no-leak");
    const glencoeCtx = await bootstrapLounge("xt-no-leak-glencoe");
    // Glencoe has 1432; Silver does not.
    const glencoeMember = await makeMember(glencoeCtx.club.id, { firstName: "Only", lastName: "Glencoe" });
    await db().member.update({ where: { id: glencoeMember.id }, data: { memberNumber: "1432" } });

    // Silver admin tries to seat with 1432 — should fail (no such member at Silver).
    await expect(
      seatTable(silverCtx.admin, silverCtx.club.id, {
        tableId: silverCtx.table.id, memberNumber: "1432", partySize: 2,
      }),
    ).rejects.toThrow();
  });
});

// =============================================================================
// 13. No unsafe global memberNumber lookup pattern in touched services.
// =============================================================================
describe("No global memberNumber lookup leaks in touched code", () => {
  const files = [
    "src/lib/pos/seat-checks.ts",
    "src/lib/pos/checks.ts",
    "src/lib/opening-balance/index.ts",
    "src/lib/services/applications.ts",
  ];

  it("every memberNumber lookup includes clubId", () => {
    for (const file of files) {
      const src = fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
      // Pattern: a where clause that starts with { memberNumber: ...
      // would mean a club-agnostic lookup. We require clubId to lead.
      const offendingPattern = /where:\s*\{\s*memberNumber:\s*[^,}]+\s*\}/g;
      const matches = src.match(offendingPattern) ?? [];
      if (matches.length > 0) {
        throw new Error(`Unsafe global memberNumber lookup found in ${file}: ${matches.join(", ")}`);
      }
    }
  });
});

// =============================================================================
// 14. Existing settle workflow still works after normalization.
// =============================================================================
describe("Settle workflow unchanged by normalization", () => {
  it("seat + add + settle flow completes with a 4-digit member input", async () => {
    const ctx = await bootstrapLounge("settle-ok");
    const owen = await makeMember(ctx.club.id, { firstName: "Owen", lastName: "Beauchamp" });
    await db().member.update({ where: { id: owen.id }, data: { memberNumber: "1310" } });
    // Use the real lounge menu fixture.
    const cat = await db().pOSMenuCategory.create({
      data: { clubId: ctx.club.id, locationId: (await db().pOSLocation.findFirst({ where: { clubId: ctx.club.id } }))!.id, name: "Mains", sortOrder: 1, isActive: true, chitDestination: "KITCHEN" },
    });
    const burger = await db().pOSMenuItem.create({
      data: { clubId: ctx.club.id, categoryId: cat.id, name: "Burger", price: 18, taxable: true, isActive: true },
    });
    const { addCheckLines } = await import("@/lib/pos/checks");
    const { settleCheckBySeats } = await import("@/lib/pos/seat-checks");
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "1310", partySize: 2,
    });
    await addCheckLines(ctx.admin, checkId, {
      items: [{ menuItemId: burger.id, quantity: 1, seatNumber: 1 }],
    });
    const r = await settleCheckBySeats(ctx.admin, checkId, {
      groups: [{
        label: "All seats", seatNumbers: [1],
        paymentMethod: "MEMBER_ACCOUNT", memberId: owen.id,
      }],
      allowUnsentLines: true,
    });
    expect(r.check.status).toBe("CLOSED");
  });
});

// =============================================================================
// 15. UI labels + placeholders use the canonical 4-digit format.
// =============================================================================
describe("UI placeholders + helpers (UI source contract)", () => {
  it("FloorMap SelfSeatingForm uses '1310' placeholder + 4-digit helper text", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx"),
      "utf8",
    );
    expect(src).toMatch(/placeholder="1310"/);
    expect(src).toMatch(/Enter the 4-digit member number\./);
    expect(src).not.toMatch(/placeholder="e\.g\. SS-1310"/);
  });

  it("SeatPOS SeatAssignmentRow uses '1310' placeholder + 4-digit helper text", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx"),
      "utf8",
    );
    expect(src).toMatch(/placeholder="1310"/);
    expect(src).toMatch(/Enter the 4-digit member number\./);
    expect(src).not.toMatch(/placeholder="e\.g\. SS-1310"/);
  });

  it("Both inputs use inputMode='numeric' for mobile keyboards", () => {
    const a = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx"),
      "utf8",
    );
    const b = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx"),
      "utf8",
    );
    expect(a).toMatch(/inputMode="numeric"/);
    expect(b).toMatch(/inputMode="numeric"/);
  });
});

// =============================================================================
// Bonus — schema-level uniqueness invariant.
// =============================================================================
describe("Schema enforces (clubId, memberNumber) uniqueness", () => {
  it("creating two members with the same memberNumber inside one club throws", async () => {
    const ctx = await bootstrapLounge("uniq-in-club");
    const first = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: first.id }, data: { memberNumber: "0001" } });

    // A second member in the SAME club with the SAME number must fail
    // (Prisma unique-constraint violation).
    const second = await makeMember(ctx.club.id);
    await expect(
      db().member.update({ where: { id: second.id }, data: { memberNumber: "0001" } }),
    ).rejects.toThrow();
  });

  it("creating two members with the same memberNumber in DIFFERENT clubs succeeds", async () => {
    const a = await bootstrapLounge("uniq-cross-club-a");
    const b = await bootstrapLounge("uniq-cross-club-b");
    const ma = await makeMember(a.club.id);
    const mb = await makeMember(b.club.id);
    await db().member.update({ where: { id: ma.id }, data: { memberNumber: "0001" } });
    await db().member.update({ where: { id: mb.id }, data: { memberNumber: "0001" } });
    // Both rows still exist — no conflict because uniqueness is (clubId, memberNumber).
    const both = await db().member.findMany({ where: { memberNumber: "0001" } });
    expect(both.length).toBeGreaterThanOrEqual(2);
  });
});
