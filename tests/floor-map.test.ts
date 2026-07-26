// Floor-map data layer tests.
//
// The visual SVG is a thin renderer over these shapes/positions/statuses.
// We cover the data the renderer depends on + the hostess actions: schema
// fields persist, manual table-status transitions work, seat/depart
// transitions flip table status correctly, and cross-tenant guards bite.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  db, makeClub, makeMember, makeUser, principalFor, resetDb, seedRbac,
} from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  setTableStatus,
  seatReservation,
  departReservation,
  createWalkIn,
  createMemberReservation,
} from "@/lib/hospitality/reservations";
import { ConflictError, TenantViolationError, ValidationError } from "@/lib/errors";

async function bootstrapDiningClub(name: string) {
  const club = await bootstrapAPClub(name);
  const lounge = await db().diningArea.create({
    data: {
      clubId: club.id, name: "Clubhouse Lounge", sortOrder: 0,
      canvasWidth: 1000, canvasHeight: 620,
      floorElementsJson: JSON.stringify([{ kind: "BAR", x: 500, y: 70, width: 760, height: 70, label: "BAR" }]),
    },
  });
  const tableRound = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: lounge.id, tableNumber: "L1", capacity: 2,
      shape: "ROUND", xPos: 170, yPos: 220, width: 80, height: 80,
    },
  });
  const tableSquare = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: lounge.id, tableNumber: "L3", capacity: 4,
      shape: "SQUARE", xPos: 460, yPos: 250, width: 110, height: 110,
    },
  });
  const tableRect = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: lounge.id, tableNumber: "L6", capacity: 6,
      shape: "RECTANGLE", xPos: 260, yPos: 440, width: 280, height: 90,
    },
  });
  return { club, lounge, tableRound, tableSquare, tableRect };
}

async function clubAdminFor(clubId: string, suffix = "") {
  const email = `floor-admin-${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

async function memberPrincipalFor(clubId: string, memberId: string, suffix = "") {
  const email = `floor-member-${suffix}-${memberId}@example.com`;
  await makeUser({ email, role: "MEMBER", clubId, memberId });
  return principalFor(email);
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

describe("Floor map — schema shape/position fields persist", () => {
  it("ROUND/SQUARE/RECTANGLE shapes + positions round-trip", async () => {
    const { tableRound, tableSquare, tableRect } = await bootstrapDiningClub("FM Shapes Club");
    const r = await db().diningTable.findUnique({ where: { id: tableRound.id } });
    const s = await db().diningTable.findUnique({ where: { id: tableSquare.id } });
    const x = await db().diningTable.findUnique({ where: { id: tableRect.id } });
    expect(r?.shape).toBe("ROUND");
    expect(r?.xPos).toBe(170); expect(r?.yPos).toBe(220); expect(r?.width).toBe(80);
    expect(s?.shape).toBe("SQUARE");
    expect(s?.width).toBe(110); expect(s?.height).toBe(110);
    expect(x?.shape).toBe("RECTANGLE");
    expect(x?.width).toBe(280); expect(x?.height).toBe(90);
  });

  it("DiningArea.floorElementsJson holds the bar definition and parses to one element", async () => {
    const { lounge } = await bootstrapDiningClub("FM Bar Club");
    const fresh = await db().diningArea.findUnique({ where: { id: lounge.id } });
    const parsed = JSON.parse(fresh!.floorElementsJson!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].kind).toBe("BAR");
    expect(parsed[0].label).toBe("BAR");
  });
});

describe("Floor map — hostess table-status workflow", () => {
  it("seat → depart flips table AVAILABLE → SEATED → DIRTY", async () => {
    const { club, lounge, tableRound } = await bootstrapDiningClub("FM Seat-Depart Club");
    const admin = await clubAdminFor(club.id, "sd");
    const member = await makeMember(club.id);
    const memberP = await memberPrincipalFor(club.id, member.id, "sd");
    const r = await createMemberReservation(memberP, club.id, {
      memberId: member.id, reservationType: "MEMBER",
      startTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      partySize: 2, diningAreaId: lounge.id,
      dressCodeAcknowledged: true, noShowFeeAcknowledged: true,
    });
    await seatReservation(admin, r!.id, tableRound.id);
    let t = await db().diningTable.findUnique({ where: { id: tableRound.id } });
    expect(t?.status).toBe("SEATED");
    // Backdate seated-at so the audit-time elapsed isn't relevant here.
    await db().diningReservation.update({
      where: { id: r!.id },
      data: { actualSeatedAt: new Date(Date.now() - 60 * 60_000) },
    });
    await departReservation(admin, r!.id);
    t = await db().diningTable.findUnique({ where: { id: tableRound.id } });
    expect(t?.status).toBe("DIRTY");
  });

  it("setTableStatus DIRTY → AVAILABLE works and is audited", async () => {
    const { club, tableSquare } = await bootstrapDiningClub("FM Reset Club");
    const admin = await clubAdminFor(club.id, "reset");
    await db().diningTable.update({ where: { id: tableSquare.id }, data: { status: "DIRTY" } });
    await setTableStatus(admin, tableSquare.id, "AVAILABLE");
    const t = await db().diningTable.findUnique({ where: { id: tableSquare.id } });
    expect(t?.status).toBe("AVAILABLE");
    const aud = await db().auditLog.findMany({
      where: { entityType: "DiningTable", entityId: tableSquare.id, action: "reservation.table.status.available" },
    });
    expect(aud.length).toBe(1);
  });

  it("setTableStatus can mark a table OUT_OF_SERVICE and bring it back", async () => {
    const { club, tableRect } = await bootstrapDiningClub("FM OOS Club");
    const admin = await clubAdminFor(club.id, "oos");
    await setTableStatus(admin, tableRect.id, "OUT_OF_SERVICE");
    expect((await db().diningTable.findUnique({ where: { id: tableRect.id } }))?.status).toBe("OUT_OF_SERVICE");
    await setTableStatus(admin, tableRect.id, "AVAILABLE");
    expect((await db().diningTable.findUnique({ where: { id: tableRect.id } }))?.status).toBe("AVAILABLE");
  });

  it("setTableStatus refuses to reset a currently SEATED table", async () => {
    const { club, lounge, tableRound } = await bootstrapDiningClub("FM Refuse Reset Club");
    const admin = await clubAdminFor(club.id, "refuse");
    const member = await makeMember(club.id);
    const memberP = await memberPrincipalFor(club.id, member.id, "refuse");
    const r = await createMemberReservation(memberP, club.id, {
      memberId: member.id, reservationType: "MEMBER",
      startTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      partySize: 2, diningAreaId: lounge.id,
      dressCodeAcknowledged: true, noShowFeeAcknowledged: true,
    });
    await seatReservation(admin, r!.id, tableRound.id);
    await expect(setTableStatus(admin, tableRound.id, "AVAILABLE")).rejects.toBeInstanceOf(ConflictError);
    // OUT_OF_SERVICE is permitted (manager taking the table down mid-service).
    await setTableStatus(admin, tableRound.id, "OUT_OF_SERVICE");
    expect((await db().diningTable.findUnique({ where: { id: tableRound.id } }))?.status).toBe("OUT_OF_SERVICE");
  });

  it("setTableStatus rejects an unknown status with a ValidationError", async () => {
    const { club, tableSquare } = await bootstrapDiningClub("FM Validate Club");
    const admin = await clubAdminFor(club.id, "val");
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setTableStatus(admin, tableSquare.id, "GARBAGE" as any),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("Floor map — walk-in path on the map", () => {
  it("creating a walk-in with a table assignment flips that table to SEATED", async () => {
    const { club, lounge, tableRect } = await bootstrapDiningClub("FM Walkin Club");
    const admin = await clubAdminFor(club.id, "walkin");
    await createWalkIn(admin, club.id, {
      reservationType: "WALK_IN",
      startTime: new Date().toISOString(),
      partySize: 4,
      diningAreaId: lounge.id,
      tableId: tableRect.id,
      guestName: "Walk-in party",
    });
    const t = await db().diningTable.findUnique({ where: { id: tableRect.id } });
    expect(t?.status).toBe("SEATED");
  });
});

describe("Floor map — cross-tenant safety", () => {
  it("admin of club B cannot reset club A's table", async () => {
    const a = await bootstrapDiningClub("FM Iso A");
    const b = await makeClub("FM Iso B");
    const adminB = await clubAdminFor(b.id, "iso-b");
    await db().diningTable.update({ where: { id: a.tableSquare.id }, data: { status: "DIRTY" } });
    await expect(setTableStatus(adminB, a.tableSquare.id, "AVAILABLE")).rejects.toBeInstanceOf(TenantViolationError);
  });
});

// Source-level assertions on the floor-map client component: the
// Excel-style tab strip + viewport-fit container are structural
// guarantees, not data-layer behaviour, so we check the source rather
// than spin up a DOM. Cheap and catches regressions if someone tears
// the layout out.
describe("Floor map — tabbed layout source contract", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const SRC = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx"),
    "utf8",
  );

  it("renders an Excel-style tab list with role=tablist", () => {
    expect(SRC).toMatch(/role="tablist"/);
  });

  it("bounds its height to the viewport so the page does not scroll", () => {
    expect(SRC).toMatch(/calc\(100vh\s*-\s*220px\)/);
    expect(SRC).toMatch(/minHeight:\s*520/);
  });

  it("uses preserveAspectRatio so the SVG scales to fit its container", () => {
    expect(SRC).toMatch(/preserveAspectRatio="xMidYMid meet"/);
    expect(SRC).toMatch(/absolute inset-0 w-full h-full/);
  });

  it("includes the seated/total count in each tab label", () => {
    expect(SRC).toMatch(/seated · .* tables/);
  });

  it("persists the active tab via a ?area= query param", () => {
    expect(SRC).toMatch(/searchParams\.get\("area"\)/);
    expect(SRC).toMatch(/next\.set\("area"/);
    expect(SRC).toMatch(/areaSlug/);
  });
});
