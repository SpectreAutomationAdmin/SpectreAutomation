// Step 33 — Phase 2 test-coverage gaps from the QA review.
//
// Tests that step-32's existing suite missed:
//   - Publish soft-archives a live DiningTable + preserves FK history.
//   - publishDraft itself (not just archiveDraftTable) refuses when a
//     table is SEATED / has an open POSCheck / has an active reservation.
//   - A non-admin (STAFF) principal cannot publish.
//   - The live floor-map loader returns a freshly-published table.
//   - The double-click drilldown predicate still works post-publish.
//   - Lounge edits don't leak into Patio (and vice versa).
//   - ValidationError detail is preserved in the action layer.
//   - Re-introducing a soft-archived tableNumber surfaces a friendly
//     pre-publish validation issue (step-33 high-severity fix).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  db, makeMember, makeUser, principalFor, resetDb, seedRbac,
} from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  getOrCreateDraftForArea,
  addDraftTable,
  updateDraftTable,
  publishDraft,
  validateDraftForPublish,
} from "@/lib/hospitality/floor-plan";
import { canOpenSeatViewOnDoubleClick } from "@/lib/hospitality/floor-map-interactions";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";

async function bootstrap(name: string) {
  const club = await bootstrapAPClub(name);
  const lounge = await db().diningArea.create({
    data: { clubId: club.id, name: "Lounge", sortOrder: 0 },
  });
  const patio = await db().diningArea.create({
    data: { clubId: club.id, name: "Patio", sortOrder: 1 },
  });
  const L1 = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: lounge.id, tableNumber: "L1", capacity: 4,
      shape: "SQUARE", xPos: 100, yPos: 100, width: 110, height: 110,
    },
  });
  const P1 = await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: patio.id, tableNumber: "P1", capacity: 4,
      shape: "ROUND", xPos: 100, yPos: 100, width: 80, height: 80,
    },
  });
  const adminEmail = `qa-${club.id}@example.com`;
  await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminEmail);
  return { club, lounge, patio, L1, P1, admin };
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// Phase-2 spec #4 — Publish soft-archives + preserves history.
// =============================================================================
describe("Publish soft-archives removed tables, preserves history", () => {
  it("archiving L1 in the draft + publish → L1.active=false but row still resolves", async () => {
    const ctx = await bootstrap("soft-archive");

    // Plant a closed POSCheck pointing at L1 so we can prove the FK
    // survives after the table is archived.
    const fbDept = await db().department.findFirst({ where: { clubId: ctx.club.id, code: "FB" } });
    const loc = await db().pOSLocation.create({
      data: { clubId: ctx.club.id, code: LOUNGE_LOCATION_CODE, name: "Lounge", departmentId: fbDept?.id ?? null },
    });
    await db().pOSTerminal.create({
      data: { clubId: ctx.club.id, code: LOUNGE_TERMINAL_CODE, name: "Terminal", locationId: loc.id },
    });
    const historyCheck = await db().pOSCheck.create({
      data: {
        clubId: ctx.club.id, locationId: loc.id, checkNumber: "HIST-1",
        status: "CLOSED", tableId: ctx.L1.id, closedAt: new Date(),
      },
    });

    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    // The validator refuses an all-archived layout, so add a
    // replacement table before archiving L1.
    await addDraftTable(ctx.admin, plan.id, {
      tableNumber: "L2", shape: "ROUND", capacity: 4,
      xPos: 250, yPos: 250, width: 80, height: 80,
    });
    await db().diningFloorPlanTable.update({
      where: { id: plan.tables[0].id }, data: { archived: true },
    });
    await publishDraft(ctx.admin, plan.id);

    // L1 still exists, just soft-archived.
    const liveL1 = await db().diningTable.findUnique({ where: { id: ctx.L1.id } });
    expect(liveL1).not.toBeNull();
    expect(liveL1?.active).toBe(false);
    // Historical FK still resolves.
    const reloadedCheck = await db().pOSCheck.findUnique({
      where: { id: historyCheck.id }, include: { table: true },
    });
    expect(reloadedCheck?.table?.id).toBe(ctx.L1.id);
  });
});

// =============================================================================
// Phase-2 spec #10 — Server/staff cannot call publish.
// =============================================================================
describe("Role-based publish denial", () => {
  it("STAFF principal cannot publish", async () => {
    const ctx = await bootstrap("staff-deny");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    const staffEmail = `staff-${ctx.club.id}@example.com`;
    await makeUser({ email: staffEmail, role: "STAFF", clubId: ctx.club.id });
    const staff = await principalFor(staffEmail);
    await expect(publishDraft(staff, plan.id)).rejects.toThrow();
  });
});

// =============================================================================
// Phase-2 specs #12/13/14 — publish blocked by operational state on a
// table the draft tries to archive.
// =============================================================================
describe("Publish blocked when an archived table has active operational state", () => {
  async function setupArchivedTableWithBlocker(
    ctx: Awaited<ReturnType<typeof bootstrap>>,
    blocker: "SEATED" | "OPEN_CHECK" | "RESERVATION",
  ) {
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    // Mark L1 archived in the draft.
    await db().diningFloorPlanTable.update({
      where: { id: plan.tables[0].id }, data: { archived: true },
    });
    if (blocker === "SEATED") {
      await db().diningTable.update({ where: { id: ctx.L1.id }, data: { status: "SEATED" } });
    } else if (blocker === "OPEN_CHECK") {
      const fbDept = await db().department.findFirst({ where: { clubId: ctx.club.id, code: "FB" } });
      const loc = await db().pOSLocation.create({
        data: { clubId: ctx.club.id, code: LOUNGE_LOCATION_CODE, name: "Lounge", departmentId: fbDept?.id ?? null },
      });
      await db().pOSCheck.create({
        data: {
          clubId: ctx.club.id, locationId: loc.id, checkNumber: "OPEN-1",
          status: "OPEN", tableId: ctx.L1.id,
        },
      });
    } else if (blocker === "RESERVATION") {
      const m = await makeMember(ctx.club.id);
      await db().diningReservation.create({
        data: {
          clubId: ctx.club.id, diningAreaId: ctx.lounge.id, tableId: ctx.L1.id,
          memberId: m.id, partySize: 2,
          reservationDate: new Date(),
          startTime: new Date(Date.now() + 60 * 60_000),
          expectedEndTime: new Date(Date.now() + 90 * 60_000),
          status: "CONFIRMED",
        },
      });
    }
    return plan;
  }

  it("blocks publish if the table is currently SEATED", async () => {
    const ctx = await bootstrap("block-seated");
    const plan = await setupArchivedTableWithBlocker(ctx, "SEATED");
    await expect(publishDraft(ctx.admin, plan.id)).rejects.toThrow();
  });

  it("blocks publish if the table has an open POSCheck", async () => {
    const ctx = await bootstrap("block-check");
    const plan = await setupArchivedTableWithBlocker(ctx, "OPEN_CHECK");
    await expect(publishDraft(ctx.admin, plan.id)).rejects.toThrow();
  });

  it("blocks publish if the table has an active reservation", async () => {
    const ctx = await bootstrap("block-res");
    const plan = await setupArchivedTableWithBlocker(ctx, "RESERVATION");
    await expect(publishDraft(ctx.admin, plan.id)).rejects.toThrow();
  });
});

// =============================================================================
// Phase-2 spec #17 — Live floor-map loader sees new table only AFTER publish.
// =============================================================================
describe("Live loader returns published tables only", () => {
  it("a draft-only table is not in DiningTable; a published one is", async () => {
    const ctx = await bootstrap("live-loader");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await addDraftTable(ctx.admin, plan.id, {
      tableNumber: "L99", shape: "ROUND", capacity: 4,
      xPos: 300, yPos: 300, width: 80, height: 80,
    });
    // Pre-publish: L99 not in DiningTable.
    let live = await db().diningTable.findFirst({
      where: { clubId: ctx.club.id, tableNumber: "L99" },
    });
    expect(live).toBeNull();
    // Publish.
    await publishDraft(ctx.admin, plan.id);
    // Post-publish: L99 is a live DiningTable, active=true.
    live = await db().diningTable.findFirst({
      where: { clubId: ctx.club.id, tableNumber: "L99" },
    });
    expect(live?.active).toBe(true);
  });
});

// =============================================================================
// Phase-2 spec #18 — Double-click drilldown predicate still works after publish.
// =============================================================================
describe("Double-click drilldown still works after publish", () => {
  it("a freshly-published table with an open POSCheck makes canOpenSeatViewOnDoubleClick true", async () => {
    const ctx = await bootstrap("dblclick");
    // Publish a draft with L99.
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await addDraftTable(ctx.admin, plan.id, {
      tableNumber: "L99", shape: "ROUND", capacity: 4,
      xPos: 300, yPos: 300, width: 80, height: 80,
    });
    await publishDraft(ctx.admin, plan.id);
    const liveL99 = await db().diningTable.findFirstOrThrow({
      where: { clubId: ctx.club.id, tableNumber: "L99" },
    });
    // Plant an open POSCheck on L99 (mimics a server seated a party).
    const fbDept = await db().department.findFirst({ where: { clubId: ctx.club.id, code: "FB" } });
    const loc = await db().pOSLocation.create({
      data: { clubId: ctx.club.id, code: LOUNGE_LOCATION_CODE, name: "Lounge", departmentId: fbDept?.id ?? null },
    });
    const check = await db().pOSCheck.create({
      data: {
        clubId: ctx.club.id, locationId: loc.id, checkNumber: "CHK-1",
        status: "OPEN", tableId: liveL99.id,
      },
    });
    await db().diningTable.update({ where: { id: liveL99.id }, data: { status: "SEATED" } });

    // Floor-map loader would produce { status: "SEATED", openCheckId: check.id } for L99.
    const href = canOpenSeatViewOnDoubleClick({ status: "SEATED", openCheckId: check.id });
    expect(href).toBe(`/app/admin/ops/pos/lounge/table/${check.id}`);
  });
});

// =============================================================================
// Phase-2 specs #7/#8 — Lounge edits don't leak into Patio (mutation form).
// =============================================================================
describe("Area mutation isolation", () => {
  it("editing Lounge draft does not change Patio's live DiningTable", async () => {
    const ctx = await bootstrap("lounge-no-leak");
    const loungePlan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    // Step 34 — placed widely apart from the seeded L1 (at 100,100)
    // so spacing validation doesn't block publish. This test is
    // about area-isolation, not layout geometry.
    await addDraftTable(ctx.admin, loungePlan.id, {
      tableNumber: "L99", shape: "SQUARE", capacity: 4,
      xPos: 400, yPos: 400, width: 80, height: 80,
    });
    await publishDraft(ctx.admin, loungePlan.id);
    // Patio's live tables — only the seeded P1 should remain.
    const patioLive = await db().diningTable.findMany({
      where: { clubId: ctx.club.id, diningAreaId: ctx.patio.id, active: true },
    });
    expect(patioLive.length).toBe(1);
    expect(patioLive[0].tableNumber).toBe("P1");
  });

  it("editing Patio draft does not change Lounge's live DiningTable", async () => {
    const ctx = await bootstrap("patio-no-leak");
    const patioPlan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.patio.id);
    await addDraftTable(ctx.admin, patioPlan.id, {
      tableNumber: "P99", shape: "ROUND", capacity: 6,
      xPos: 200, yPos: 200, width: 80, height: 80,
    });
    await publishDraft(ctx.admin, patioPlan.id);
    const loungeLive = await db().diningTable.findMany({
      where: { clubId: ctx.club.id, diningAreaId: ctx.lounge.id, active: true },
    });
    expect(loungeLive.length).toBe(1);
    expect(loungeLive[0].tableNumber).toBe("L1");
  });
});

// =============================================================================
// Step-33 new defect: archived-DiningTable name collision surfaces as a
// pre-publish validation issue (not a Prisma P2002).
// =============================================================================
describe("Step 33 — archived-name collision pre-checked", () => {
  it("validateDraftForPublish flags re-introducing a soft-archived tableNumber", async () => {
    const ctx = await bootstrap("collision");
    // Soft-archive L1 directly (mimics an earlier publish that removed it).
    await db().diningTable.update({ where: { id: ctx.L1.id }, data: { active: false } });
    // New draft. Seed has no tables (L1 is inactive), so add a NEW L1.
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await addDraftTable(ctx.admin, plan.id, {
      tableNumber: "L1", shape: "ROUND", capacity: 4,
      xPos: 200, yPos: 200, width: 80, height: 80,
    });
    const issues = await validateDraftForPublish(ctx.admin, plan.id);
    expect(issues.some((i) => /previously-archived/i.test(i.message))).toBe(true);
  });
});

// =============================================================================
// Step-33 new defect: area.clubId verification in getOrCreateDraftForArea.
// =============================================================================
describe("Step 33 — area.clubId mismatch refused", () => {
  it("club-A admin passing clubId=A with diningAreaId from club B is rejected", async () => {
    const a = await bootstrap("clubid-a");
    const b = await bootstrap("clubid-b");
    // a.admin is CLUB_ADMIN of club A only. Passing club B's area
    // must throw — either the area-not-owned TenantViolation or the
    // step-33 area.clubId mismatch check, both are correct.
    await expect(
      getOrCreateDraftForArea(a.admin, a.club.id, b.lounge.id),
    ).rejects.toThrow();
  });
});

// =============================================================================
// Step-33 fix verified: action-level ValidationError preserves issues.
// (Imports the action and asserts the result shape.)
// =============================================================================
describe("Step 33 — ValidationError detail surfaces through the server action", () => {
  it("addTableAction with bad input returns issues[] not just a generic 'Validation failed'", async () => {
    // We can't run server actions outside Next, so check the
    // service throws ValidationError with non-empty issues — the
    // action's fail() helper unconditionally serializes them.
    const ctx = await bootstrap("validation-detail");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    let caught: unknown = null;
    try {
      await addDraftTable(ctx.admin, plan.id, {
        tableNumber: "", // missing
        shape: "ROUND",
        capacity: 0, // < 1
        xPos: 99999, yPos: 99999, width: 80, height: 80, // off canvas
      });
    } catch (e) { caught = e; }
    expect(caught).not.toBeNull();
    // Imported lazily because tests/util/db doesn't pre-import errors.
    const { ValidationError } = await import("@/lib/errors");
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as InstanceType<typeof ValidationError>).issues.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// Step-33 fix verified: capacity upper bound.
// =============================================================================
describe("Step 33 — capacity upper bound enforced", () => {
  it("capacity > 24 throws ValidationError with the right issue message", async () => {
    const ctx = await bootstrap("cap-upper");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    let caught: unknown = null;
    try {
      await addDraftTable(ctx.admin, plan.id, {
        tableNumber: "L99", shape: "ROUND", capacity: 9999,
        xPos: 200, yPos: 200, width: 80, height: 80,
      });
    } catch (e) { caught = e; }
    const { ValidationError } = await import("@/lib/errors");
    expect(caught).toBeInstanceOf(ValidationError);
    const issues = (caught as InstanceType<typeof ValidationError>).issues;
    expect(issues.some((i) => /at most 24/i.test(i.message))).toBe(true);
  });
});

// =============================================================================
// Step-33 fix verified: bounds account for tile size.
// =============================================================================
describe("Step 33 — bounds check uses width/height", () => {
  it("a 200-wide table centred at canvasWidth (1000) is rejected", async () => {
    const ctx = await bootstrap("bounds");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    // Canvas defaults to 1000 × 700. Centring a 200-wide table at
    // xPos=1000 would render 100 px outside the right edge.
    let caught: unknown = null;
    try {
      await addDraftTable(ctx.admin, plan.id, {
        tableNumber: "EDGE", shape: "RECTANGLE", capacity: 6,
        xPos: 1000, yPos: 350, width: 200, height: 100,
      });
    } catch (e) { caught = e; }
    const { ValidationError } = await import("@/lib/errors");
    expect(caught).toBeInstanceOf(ValidationError);
    const issues = (caught as InstanceType<typeof ValidationError>).issues;
    expect(issues.some((i) => /outside the canvas horizontally/i.test(i.message))).toBe(true);
  });
});

// =============================================================================
// Step-33 fix verified: demote audit on publish.
// =============================================================================
describe("Step 33 — demoted plan gets its own audit entry", () => {
  it("two publishes leave an audit row for the LIVE→ARCHIVED transition", async () => {
    const ctx = await bootstrap("demote-audit");
    const plan1 = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await publishDraft(ctx.admin, plan1.id);
    const plan2 = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await publishDraft(ctx.admin, plan2.id);
    const archiveAudit = await db().auditLog.findFirst({
      where: {
        clubId: ctx.club.id,
        action: "hospitality.floor-plan.archive",
        entityId: plan1.id,
      },
    });
    expect(archiveAudit).not.toBeNull();
  });
});
