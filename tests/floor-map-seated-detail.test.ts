// POS cleanup step 18 — floor-map seated-table detail consistency.
//
// L1 (reservation-seated) showed a rich card; L2/L3/L4 (POS-seated)
// showed nothing. Root cause: the loader exposed POSCheck only as
// { id, checkNumber, status }, so the tile + side panel had no host /
// party-size / seated-since to render. The fix introduces a unified
// `seatedParty` projection that prefers reservation context but falls
// back to POSCheck context when no reservation backs the seating.
//
// These tests pin:
//   - the deriveSeatedParty contract for both paths and the fallback
//   - the releaseTable service + departReservation open-check guard
//   - the FloorMap UI source-contract: tile + panel read `seatedParty`,
//     panel offers the right action mix per source

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  db,
  makeMember,
  makeUser,
  principalFor,
  resetDb,
  seedRbac,
} from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  deriveSeatedParty,
  type SeatedParty,
} from "@/lib/hospitality/seated-party";
import { seatTable } from "@/lib/pos/seat-checks";
import {
  releaseTable,
  departReservation,
} from "@/lib/hospitality/reservations";
import {
  LOUNGE_LOCATION_CODE,
  LOUNGE_TERMINAL_CODE,
} from "@/lib/pos/lounge";

async function bootstrapLounge(name: string, opts?: { capacity?: number; tableNumber?: string }) {
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
      clubId: club.id, diningAreaId: area.id, tableNumber: opts?.tableNumber ?? "L3", capacity: opts?.capacity ?? 4,
      shape: "SQUARE", xPos: 100, yPos: 100, width: 110, height: 110,
    },
  });
  const adminEmail = `step18-${club.id}@example.com`;
  await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminEmail);
  return { club, area, table, admin };
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// 1. Reservation-seated table shows host + elapsed (deriveSeatedParty).
// =============================================================================
describe("Spec 1 — reservation-seated table derives host + seated-since", () => {
  it("returns RESERVATION source with member name + actualSeatedAt", () => {
    const seatedAt = new Date("2026-05-31T12:00:00Z");
    const seated = deriveSeatedParty({
      reservation: {
        id: "res-1",
        status: "SEATED",
        partySize: 2,
        startTime: new Date("2026-05-31T11:55:00Z"),
        actualSeatedAt: seatedAt,
        guestName: null,
        member: { firstName: "Margaret", lastName: "Holloway" },
      },
      openCheck: null,
      tableStatus: "SEATED",
    });
    expect(seated).not.toBeNull();
    expect(seated!.source).toBe("RESERVATION");
    expect(seated!.hostName).toBe("Margaret Holloway");
    expect(seated!.partySize).toBe(2);
    expect(seated!.seatedSinceIso).toBe(seatedAt.toISOString());
    expect(seated!.reservationId).toBe("res-1");
  });
});

// =============================================================================
// 2. POS / self-seated table shows host + elapsed (deriveSeatedParty).
// =============================================================================
describe("Spec 2 — POS-seated table derives host from primary seat + createdAt", () => {
  it("returns POS_CHECK source with primary seat name + check.createdAt", () => {
    const createdAt = new Date("2026-05-31T13:00:00Z");
    const seated = deriveSeatedParty({
      reservation: null,
      openCheck: {
        id: "chk-1",
        status: "OPEN",
        createdAt,
        partySize: 3,
        guestName: null,
        member: null,
        seats: [
          { guestName: null, member: { firstName: "Owen", lastName: "Beauchamp" } },
        ],
        _count: { seats: 3 },
      },
      tableStatus: "SEATED",
    });
    expect(seated).not.toBeNull();
    expect(seated!.source).toBe("POS_CHECK");
    expect(seated!.hostName).toBe("Owen Beauchamp");
    expect(seated!.partySize).toBe(3);
    expect(seated!.seatedSinceIso).toBe(createdAt.toISOString());
    expect(seated!.checkId).toBe("chk-1");
    expect(seated!.checkIsActive).toBe(true);
  });
});

// =============================================================================
// 3. POS / self-seated table side panel shows Open seat view link.
// =============================================================================
describe("Spec 3 — FloorMap panel offers Open seat view when checkId present (UI source contract)", () => {
  it("FloorMap.tsx still renders SeatViewCTA for any SEATED table with openCheckId", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx"),
      "utf8",
    );
    expect(src).toMatch(/table\.status === "SEATED" &&[\s\S]*?SeatViewCTA/);
    expect(src).toMatch(/openCheckId=\{table\.openCheckId\}/);
  });
});

// =============================================================================
// 4. POS / self-seated table does not require a reservation to show details.
// =============================================================================
describe("Spec 4 — seatedParty resolves with no reservation row", () => {
  it("reservation null + openCheck present + tableStatus SEATED → seatedParty non-null", () => {
    const seated = deriveSeatedParty({
      reservation: null,
      openCheck: {
        id: "chk-2",
        status: "OPEN",
        createdAt: new Date(),
        partySize: 2,
        guestName: null,
        member: { firstName: "Henry", lastName: "Wexford" },
        seats: [],
        _count: { seats: 1 },
      },
      tableStatus: "SEATED",
    });
    expect(seated).not.toBeNull();
    expect(seated!.source).toBe("POS_CHECK");
    expect(seated!.hostName).toBe("Henry Wexford");
    // partySize taken from explicit field, not seat count, because
    // partySize was provided.
    expect(seated!.partySize).toBe(2);
  });

  it("falls back to _count.seats when POSCheck.partySize is null", () => {
    const seated = deriveSeatedParty({
      reservation: null,
      openCheck: {
        id: "chk-3",
        status: "OPEN",
        createdAt: new Date(),
        partySize: null,
        guestName: null,
        member: { firstName: "Henry", lastName: "Wexford" },
        seats: [],
        _count: { seats: 4 },
      },
      tableStatus: "SEATED",
    });
    expect(seated!.partySize).toBe(4);
  });
});

// =============================================================================
// 5. Reservation-seated table shows Open reservation in the panel.
// =============================================================================
describe("Spec 5 — Open reservation link rendered only when reservationId present", () => {
  it("FloorMap.tsx wraps Open reservation in a seated.reservationId guard", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx"),
      "utf8",
    );
    expect(src).toMatch(/seated\.reservationId && \([\s\S]*?Open reservation[\s\S]*?\)/);
  });
});

// =============================================================================
// 6. Table with both reservation + POSCheck shows both contexts.
// =============================================================================
describe("Spec 6 — reservation + open check together exposes both actions", () => {
  it("reservation context wins for hostName but check stays addressable", () => {
    const seated = deriveSeatedParty({
      reservation: {
        id: "res-2",
        status: "SEATED",
        partySize: 2,
        startTime: new Date(),
        actualSeatedAt: new Date(),
        guestName: null,
        member: { firstName: "Margaret", lastName: "Holloway" },
      },
      openCheck: {
        id: "chk-4",
        status: "OPEN",
        createdAt: new Date(),
        partySize: 2,
        guestName: null,
        member: null,
        seats: [],
        _count: { seats: 2 },
      },
      tableStatus: "SEATED",
    });
    expect(seated!.source).toBe("RESERVATION");
    expect(seated!.reservationId).toBe("res-2");
    expect(seated!.checkId).toBe("chk-4");
    // Open check present → unsafe to depart yet.
    expect(seated!.checkIsActive).toBe(true);
  });
});

// =============================================================================
// 7. Seated table with open check does not allow unsafe Mark departed.
// =============================================================================
describe("Spec 7 — Mark departed is blocked while an open check sits on the table", () => {
  it("releaseTable refuses on a POS-seated table whose check is still open", async () => {
    const ctx = await bootstrapLounge("releaseTable-open");
    const margaret = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({ where: { id: margaret.id }, data: { memberNumber: "0613" } });

    await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });

    await expect(
      releaseTable(ctx.admin, ctx.table.id),
    ).rejects.toThrow(/settle the open check/i);

    // Table is still SEATED.
    const after = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(after?.status).toBe("SEATED");
  });

  it("departReservation refuses if a check on the same table is still open", async () => {
    const ctx = await bootstrapLounge("departReservation-open");
    const margaret = await makeMember(ctx.club.id, { firstName: "Margaret", lastName: "Holloway" });
    await db().member.update({ where: { id: margaret.id }, data: { memberNumber: "0613" } });

    // Build a reservation that's already SEATED on the table.
    const reservation = await db().diningReservation.create({
      data: {
        clubId: ctx.club.id,
        diningAreaId: ctx.area.id,
        tableId: ctx.table.id,
        memberId: margaret.id,
        partySize: 2,
        reservationDate: new Date(),
        startTime: new Date(Date.now() - 60_000),
        expectedEndTime: new Date(Date.now() + 60 * 60_000),
        status: "SEATED",
        actualSeatedAt: new Date(),
        guestName: "Margaret Holloway",
      },
    });
    // Open a check on the same table.
    await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });

    await expect(
      departReservation(ctx.admin, reservation.id),
    ).rejects.toThrow(/settle the open check/i);
  });
});

// =============================================================================
// 8. Seated table with closed check can be marked departed → DIRTY.
// =============================================================================
describe("Spec 8 — releaseTable flips status to DIRTY once all checks are closed", () => {
  it("with no open check, releaseTable on a SEATED table moves it to DIRTY", async () => {
    const ctx = await bootstrapLounge("releaseTable-closed");
    // No POSCheck created — flip table to SEATED manually to mimic a
    // bare "seated" state with no in-progress check.
    await db().diningTable.update({
      where: { id: ctx.table.id }, data: { status: "SEATED" },
    });

    await releaseTable(ctx.admin, ctx.table.id);

    const after = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(after?.status).toBe("DIRTY");
  });

  it("treats CLOSED checks as not-active (does not block release)", async () => {
    const ctx = await bootstrapLounge("releaseTable-closed-check");
    const margaret = await makeMember(ctx.club.id);
    await db().member.update({ where: { id: margaret.id }, data: { memberNumber: "0613" } });
    const { checkId } = await seatTable(ctx.admin, ctx.club.id, {
      tableId: ctx.table.id, memberNumber: "0613", partySize: 2,
    });
    // Force-close the check directly (bypasses settlement just for the
    // guard test — the guard only cares about status).
    await db().pOSCheck.update({
      where: { id: checkId }, data: { status: "CLOSED" },
    });

    await releaseTable(ctx.admin, ctx.table.id);
    const after = await db().diningTable.findUnique({ where: { id: ctx.table.id } });
    expect(after?.status).toBe("DIRTY");
  });

  it("writes an audit entry for the release", async () => {
    const ctx = await bootstrapLounge("releaseTable-audit");
    await db().diningTable.update({
      where: { id: ctx.table.id }, data: { status: "SEATED" },
    });
    await releaseTable(ctx.admin, ctx.table.id);

    const entry = await db().auditLog.findFirst({
      where: { clubId: ctx.club.id, action: "table.release", entityId: ctx.table.id },
    });
    expect(entry).not.toBeNull();
  });
});

// =============================================================================
// 9. Tile shows "Guest party" if no host can be resolved.
// =============================================================================
describe("Spec 9 — fallback host label is 'Guest party'", () => {
  it("deriveSeatedParty returns hostName=null when no member + no guestName", () => {
    const seated = deriveSeatedParty({
      reservation: null,
      openCheck: {
        id: "chk-5",
        status: "OPEN",
        createdAt: new Date(),
        partySize: 2,
        guestName: null,
        member: null,
        seats: [{ guestName: null, member: null }],
        _count: { seats: 2 },
      },
      tableStatus: "SEATED",
    });
    expect(seated!.hostName).toBeNull();
  });

  it("FloorMap.tsx renders 'Guest party' when seated.hostName is null (UI source contract)", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx"),
      "utf8",
    );
    expect(src).toMatch(/seated\.hostName \?\? "Guest party"/);
  });
});

// =============================================================================
// 10. L2/L3/L4 (self-seated) render the same detail contract as L1.
// =============================================================================
describe("Spec 10 — POS-seated tables produce the same seatedParty shape as reservation-seated", () => {
  it("RESERVATION-source + POS_CHECK-source both expose host/partySize/elapsed/checkIsActive", () => {
    const resSeated = deriveSeatedParty({
      reservation: {
        id: "res-l1",
        status: "SEATED",
        partySize: 2,
        startTime: new Date(),
        actualSeatedAt: new Date(),
        guestName: null,
        member: { firstName: "L1", lastName: "Host" },
      },
      openCheck: null,
      tableStatus: "SEATED",
    });
    const posSeated = deriveSeatedParty({
      reservation: null,
      openCheck: {
        id: "chk-l3",
        status: "OPEN",
        createdAt: new Date(),
        partySize: 2,
        guestName: null,
        member: null,
        seats: [
          { guestName: null, member: { firstName: "L3", lastName: "Host" } },
        ],
        _count: { seats: 2 },
      },
      tableStatus: "SEATED",
    });
    // Same fields exposed.
    const fields: Array<keyof SeatedParty> = ["source", "hostName", "partySize", "seatedSinceIso", "checkIsActive"];
    for (const f of fields) {
      expect(resSeated).toHaveProperty(f);
      expect(posSeated).toHaveProperty(f);
    }
    // Both expose a non-null hostName.
    expect(resSeated!.hostName).toBe("L1 Host");
    expect(posSeated!.hostName).toBe("L3 Host");
  });

  it("FloorMap.tsx tile + panel read from seated, not live, so POS-seated tables render too", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx"),
      "utf8",
    );
    // Tile gates host + party + elapsed on `seated`, not `live`.
    expect(src).toMatch(/\{seated && \([\s\S]*?hostLabel[\s\S]*?seated\.partySize/);
    // Panel renders the rich card from `seated`, not `live`.
    expect(src).toMatch(/\{seated && \(/);
  });
});

// =============================================================================
// 11. Cross-tenant seated-table context blocked.
// =============================================================================
describe("Spec 11 — releaseTable rejects cross-tenant table ids", () => {
  it("admin of club A cannot release a table owned by club B", async () => {
    const a = await bootstrapLounge("ct-a");
    const b = await bootstrapLounge("ct-b");
    // Mark B's table seated.
    await db().diningTable.update({
      where: { id: b.table.id }, data: { status: "SEATED" },
    });

    await expect(
      releaseTable(a.admin, b.table.id),
    ).rejects.toThrow();
    const stillSeated = await db().diningTable.findUnique({ where: { id: b.table.id } });
    expect(stillSeated?.status).toBe("SEATED");
  });
});

// =============================================================================
// Bonus — releaseTable refuses if the table is not SEATED.
// =============================================================================
describe("Bonus — releaseTable only operates on SEATED tables", () => {
  it("AVAILABLE → throws", async () => {
    const ctx = await bootstrapLounge("not-seated");
    await expect(
      releaseTable(ctx.admin, ctx.table.id),
    ).rejects.toThrow(/only a seated table/i);
  });

  it("DIRTY → throws (already released)", async () => {
    const ctx = await bootstrapLounge("dirty");
    await db().diningTable.update({
      where: { id: ctx.table.id }, data: { status: "DIRTY" },
    });
    await expect(
      releaseTable(ctx.admin, ctx.table.id),
    ).rejects.toThrow(/only a seated table/i);
  });
});

// =============================================================================
// Bonus — the loader pulls the new POSCheck fields.
// Source-contract check: a regression in the prisma select would
// silently strip host / party / seated-since again.
// =============================================================================
describe("Bonus — floor page loader selects the seated-context fields on POSCheck", () => {
  const src = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/page.tsx"),
    "utf8",
  );
  it("loader selects partySize, createdAt, member name, primary seat, seats _count", () => {
    expect(src).toMatch(/partySize: true/);
    expect(src).toMatch(/createdAt: true/);
    expect(src).toMatch(/member: \{ select: \{ firstName: true, lastName: true \} \}/);
    expect(src).toMatch(/seats: \{[\s\S]*?where: \{ isPrimary: true \}/);
    expect(src).toMatch(/_count: \{ select: \{ seats: true \} \}/);
  });
  it("loader passes the row to deriveSeatedParty", () => {
    expect(src).toMatch(/deriveSeatedParty\(\{[\s\S]*?reservation: live,[\s\S]*?openCheck,[\s\S]*?tableStatus: t\.status/);
  });
});
