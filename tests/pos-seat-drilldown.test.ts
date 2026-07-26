// Targeted regression: clicking a SEATED table on the Lounge floor map
// must drill into the seat-level view without typing a route.
//
// The drilldown is a Next <Link> to /app/admin/ops/pos/lounge/table/<id>
// that uses POSCheck.tableId to find the open check linked to the table.
// We cover the data wiring + the UI source contract; both have to hold
// for the click to work end-to-end.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db, makeClub, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import { seatTable, seatSummary } from "@/lib/pos/seat-checks";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";

async function bootstrapLounge(name: string) {
  const club = await bootstrapAPClub(name);
  const fbDept = await db().department.findFirst({ where: { clubId: club.id, code: "FB" } });
  const loc = await db().pOSLocation.create({
    data: { clubId: club.id, code: LOUNGE_LOCATION_CODE, name: "Clubhouse Lounge", departmentId: fbDept?.id ?? null },
  });
  await db().pOSTerminal.create({
    data: { clubId: club.id, code: LOUNGE_TERMINAL_CODE, name: "Lounge Terminal", locationId: loc.id },
  });
  await db().pOSSession.create({
    data: { clubId: club.id, locationId: loc.id, status: "OPEN", openingFloat: 0 },
  });
  const area = await db().diningArea.create({
    data: { clubId: club.id, name: "Lounge", sortOrder: 0 },
  });
  const fourTop = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: area.id, tableNumber: "L4", capacity: 4,
      shape: "SQUARE", xPos: 460, yPos: 250, width: 110, height: 110,
    },
  });
  const dirty = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: area.id, tableNumber: "L3", capacity: 4,
      shape: "SQUARE", xPos: 300, yPos: 250, width: 110, height: 110, status: "DIRTY",
    },
  });
  const oos = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: area.id, tableNumber: "L5", capacity: 4,
      shape: "SQUARE", xPos: 620, yPos: 250, width: 110, height: 110, status: "OUT_OF_SERVICE",
    },
  });
  return { club, fourTop, dirty, oos };
}

async function clubAdminFor(clubId: string, suffix = "") {
  const email = `seat-drill-${suffix}-${clubId}@example.com`;
  await makeUser({ email, role: "CLUB_ADMIN", clubId });
  return principalFor(email);
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// ===========================================================================
// Data wiring
// ===========================================================================
describe("Seat-level drilldown — data layer", () => {
  it("seatTable stamps POSCheck.tableId so the floor query can find the open check", async () => {
    const { club, fourTop } = await bootstrapLounge("Drill OK Club");
    const admin = await clubAdminFor(club.id, "ok");
    const { makeMember } = await import("./util/db");
    const host = await makeMember(club.id);
    const { checkId } = await seatTable(admin, club.id, { tableId: fourTop.id, memberId: host.id, partySize: 4 });

    // The shape the floor page resolves: most recent non-closed check
    // for this table, surfaced as `openCheckId`.
    const table = await db().diningTable.findUnique({
      where: { id: fourTop.id },
      include: {
        posChecks: {
          where: { status: { notIn: ["CLOSED", "VOIDED"] } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, checkNumber: true, status: true },
        },
      },
    });
    expect(table?.posChecks).toHaveLength(1);
    expect(table?.posChecks[0].id).toBe(checkId);
    expect(table?.posChecks[0].status).toBe("OPEN");
  });

  it("DIRTY and OUT_OF_SERVICE tables don't carry an open check (no drilldown CTA)", async () => {
    const { fourTop, dirty, oos } = await bootstrapLounge("Drill Dirty Club");

    for (const t of [dirty, oos, fourTop]) {
      const row = await db().diningTable.findUnique({
        where: { id: t.id },
        include: {
          posChecks: {
            where: { status: { notIn: ["CLOSED", "VOIDED"] } },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true },
          },
        },
      });
      expect(row?.posChecks).toHaveLength(0);
    }
  });

  it("seatSummary reports four seats for a 4-top, none of them selected by default", async () => {
    const { club, fourTop } = await bootstrapLounge("Drill 4-top Club");
    const admin = await clubAdminFor(club.id, "fourtop");
    const { makeMember } = await import("./util/db");
    const host = await makeMember(club.id);
    const { checkId } = await seatTable(admin, club.id, { tableId: fourTop.id, memberId: host.id, partySize: 4 });
    const s = await seatSummary(admin, checkId);
    expect(s.seats).toHaveLength(4);
    expect(s.seats.map((x) => x.seatNumber)).toEqual([1, 2, 3, 4]);
    expect(s.seats.every((x) => x.items.length === 0)).toBe(true);
    expect(s.check.table?.id).toBe(fourTop.id);
    expect(s.check.table?.shape).toBe("SQUARE");
  });

  it("reservation-seated table without a check yet: ensureCheckForReservation creates a POSCheck stamped with tableId so the floor query then surfaces openCheckId", async () => {
    const { club, fourTop } = await bootstrapLounge("Drill Reservation Club");
    const admin = await clubAdminFor(club.id, "resv");
    const member = await db().member.create({
      data: {
        clubId: club.id,
        memberNumber: "RSV-1",
        firstName: "Rex",
        lastName: "Vation",
        email: `rex-${Date.now()}@example.com`,
      },
    });
    const area = await db().diningArea.findFirst({ where: { clubId: club.id } });
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const reservation = await db().diningReservation.create({
      data: {
        clubId: club.id, memberId: member.id, diningAreaId: area!.id, tableId: fourTop.id,
        reservationType: "MEMBER", status: "SEATED",
        reservationDate: tomorrow, startTime: tomorrow,
        expectedEndTime: new Date(tomorrow.getTime() + 90 * 60_000),
        actualSeatedAt: new Date(), partySize: 2,
        dressCodeAcknowledged: true, noShowFeeAcknowledged: true,
      },
    });
    // Before opening: floor query returns no open check for this table.
    let row = await db().diningTable.findUnique({
      where: { id: fourTop.id },
      include: {
        posChecks: { where: { status: { notIn: ["CLOSED", "VOIDED"] } }, take: 1 },
      },
    });
    expect(row?.posChecks).toHaveLength(0);

    // ensureCheckForReservation runs the SeatViewCTA's fallback path.
    const { ensureCheckForReservation } = await import("@/lib/hospitality/reservations");
    const { checkId } = await ensureCheckForReservation(admin, reservation.id);

    row = await db().diningTable.findUnique({
      where: { id: fourTop.id },
      include: {
        posChecks: { where: { status: { notIn: ["CLOSED", "VOIDED"] } }, take: 1 },
      },
    });
    expect(row?.posChecks).toHaveLength(1);
    expect(row?.posChecks[0].id).toBe(checkId);
  });

  it("an admin from another club cannot read the seat summary (tenant isolation)", async () => {
    const a = await bootstrapLounge("Drill Iso A");
    const b = await makeClub("Drill Iso B");
    const adminA = await clubAdminFor(a.club.id, "iso-a");
    const adminB = await clubAdminFor(b.id, "iso-b");
    const { makeMember } = await import("./util/db");
    const hostA = await makeMember(a.club.id);
    const { checkId } = await seatTable(adminA, a.club.id, { tableId: a.fourTop.id, memberId: hostA.id, partySize: 2 });
    await expect(seatSummary(adminB, checkId)).rejects.toBeTruthy();
  });
});

// ===========================================================================
// UI source contract
// ===========================================================================
describe("Seat-level drilldown — UI source contract", () => {
  const FLOOR_MAP = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/FloorMap.tsx"),
    "utf8",
  );
  const FLOOR_PAGE = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/page.tsx"),
    "utf8",
  );
  const SEAT_POS = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/ops/pos/lounge/table/[checkId]/SeatPOS.tsx"),
    "utf8",
  );

  it("FloorMap renders an Open-seat-view link to /lounge/table/[id] when openCheckId is set", () => {
    expect(FLOOR_MAP).toMatch(/openCheckId/);
    expect(FLOOR_MAP).toMatch(/Open seat view/);
    expect(FLOOR_MAP).toMatch(/href=\{`\/app\/admin\/ops\/pos\/lounge\/table\/\$\{openCheckId\}`\}/);
  });

  it("SeatViewCTA falls back to a button-driven open-on-demand path when the table is reservation-seated but has no check yet", () => {
    expect(FLOOR_MAP).toMatch(/function SeatViewCTA/);
    // Either path lands on the seat-level URL — the button case after a
    // successful openCheckAction, the link case immediately.
    expect(FLOOR_MAP).toMatch(/router\.push\(`\/app\/admin\/ops\/pos\/lounge\/table\/\$\{r\.data\.checkId\}`\)/);
    // CTA renders for every SEATED table, regardless of whether the
    // check existed at render time.
    expect(FLOOR_MAP).toMatch(/table\.status === "SEATED" && \(\s*<SeatViewCTA/);
  });

  it("Floor page surfaces posChecks → openCheckId in its payload", () => {
    expect(FLOOR_PAGE).toMatch(/posChecks/);
    expect(FLOOR_PAGE).toMatch(/openCheckId/);
  });

  it("AVAILABLE tables still get the Mark seated form (Self-seating CTA preserved)", () => {
    expect(FLOOR_MAP).toMatch(/SelfSeatingForm/);
    expect(FLOOR_MAP).toMatch(/Mark seated \+ start check/);
  });

  it("Self-seating is a two-step flow: idle → prompt, member input only after the button is clicked", () => {
    // State machine + the gate. The member-number <input> + <datalist>
    // only render after the step transitions to "prompt", so an
    // AVAILABLE table click shows just the button first.
    expect(FLOOR_MAP).toMatch(/useState<"idle" \| "prompt">/);
    // First-step render path returns the button before any text input.
    expect(FLOOR_MAP).toMatch(/step === "idle"[\s\S]+?setStep\("prompt"\)[\s\S]+?Mark seated \+ start check/);
    // Member input is inside the step==="prompt" branch with autoFocus +
    // form onSubmit so Enter submits.
    expect(FLOOR_MAP).toMatch(/autoFocus/);
    expect(FLOOR_MAP).toMatch(/onSubmit=\{\(e\) => \{ e\.preventDefault\(\); submit\(\); \}\}/);
  });

  it("Cancel returns to idle without seating the table", () => {
    expect(FLOOR_MAP).toMatch(/function reset\(\) \{\s*setStep\("idle"\)/);
    expect(FLOOR_MAP).toMatch(/onClick=\{reset\}/);
  });

  it("SeatPOS starts with no seat selected and shows the empty-state copy", () => {
    expect(SEAT_POS).toMatch(/number \| "TABLE" \| null/);
    // POS cleanup step 2 — the empty-state copy is now "Select a seat
    // to begin ordering." (matches the server-spec wording).
    expect(SEAT_POS).toMatch(/Select a seat to begin ordering\./);
  });

  it("SeatPOS exposes a Back-to-floor-map link", () => {
    expect(SEAT_POS).toMatch(/href="\/app\/admin\/hospitality\/reservations\/floor"/);
    expect(SEAT_POS).toMatch(/Back to floor map/);
  });

  it("Per-seat assignment popup wraps inputs in <form onSubmit> so Enter submits", () => {
    // Both the Member and Guest tabs must wrap their input in a form.
    const memberForm = /onSubmit=\{\(e\) => \{ e\.preventDefault\(\); runMember\(\); \}\}/;
    const guestForm  = /onSubmit=\{\(e\) => \{ e\.preventDefault\(\); runGuest\(\); \}\}/;
    expect(SEAT_POS).toMatch(memberForm);
    expect(SEAT_POS).toMatch(guestForm);
  });

  it("Per-seat assignment popup autofocuses the input when opened", () => {
    // Step 16 — placeholder is now the canonical 4-digit form, not the
    // legacy SS-#### prefix.
    expect(SEAT_POS).toMatch(/autoFocus[\s\S]+?placeholder="1310"/);
    expect(SEAT_POS).toMatch(/autoFocus[\s\S]+?placeholder="Smith party/);
  });

  it("Per-seat assignment popup resets state when the active seat changes", () => {
    // useEffect keyed on seat?.seatNumber wipes open / memberNumber /
    // guestName so a stale "open" from the previous seat doesn't carry over.
    expect(SEAT_POS).toMatch(/lastSeatRef/);
    expect(SEAT_POS).toMatch(/setMemberNumber\(""\);\s*setGuestName\(""\);/);
  });

  it("Per-seat assignment auto-opens for unassigned non-primary seats", () => {
    // The reset effect computes unassigned + canAssign and toggles the
    // popup open without a second click.
    expect(SEAT_POS).toMatch(/const unassigned = !seat\.assignment\.memberId && !seat\.assignment\.guestName/);
    expect(SEAT_POS).toMatch(/const canAssign = !seat\.assignment\.isPrimary/);
    expect(SEAT_POS).toMatch(/setOpen\(unassigned && canAssign\)/);
  });

  it("Active-seat card scrolls into view when a seat is selected", () => {
    expect(SEAT_POS).toMatch(/activeCardRef/);
    expect(SEAT_POS).toMatch(/scrollIntoView\(\{ behavior: "smooth", block: "nearest" \}\)/);
  });

  it("Seat-strip SVG is width-capped so it doesn't push the assign panel below the fold", () => {
    expect(SEAT_POS).toMatch(/maxWidth: 520/);
    expect(SEAT_POS).toMatch(/maxHeight: 280/);
  });

  it("Selected-seat highlight: the seat circle fill flips to a dark style when active", () => {
    // The seat strip flips fill from #fff (idle) to #111 (active) when
    // activeSeat === seat. We assert the structural condition in source.
    expect(SEAT_POS).toMatch(/isActive \? "#111" : "#fff"/);
  });
});
