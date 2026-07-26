// POS cleanup step 32 — floor-plan editor draft + publish workflow.
//
// Architecture being pinned:
//   - DiningTable rows remain the live source of truth read by the
//     POS / floor map.
//   - DiningFloorPlan (DRAFT/LIVE/ARCHIVED) + DiningFloorPlanTable
//     hold editor data. Drafts are isolated from live.
//   - publishDraft atomically reconciles draft → DiningTable rows
//     (update / create / soft-archive).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  db, makeMember, makeUser, principalFor, resetDb, seedRbac,
} from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  getOrCreateDraftForArea,
  addDraftTable,
  updateDraftTable,
  archiveDraftTable,
  discardDraft,
  publishDraft,
  validateDraftForPublish,
  getLivePlanForArea,
  getDraftForArea,
} from "@/lib/hospitality/floor-plan";
import { LOUNGE_LOCATION_CODE, LOUNGE_TERMINAL_CODE } from "@/lib/pos/lounge";

async function bootstrap(name: string) {
  const club = await bootstrapAPClub(name);
  // Two dining areas — Lounge and Patio — so we can prove independence.
  const lounge = await db().diningArea.create({
    data: { clubId: club.id, name: "Lounge", sortOrder: 0 },
  });
  const patio = await db().diningArea.create({
    data: { clubId: club.id, name: "Patio", sortOrder: 1 },
  });
  // Seed one live table per area so getOrCreateDraft has something to clone.
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
  // Admin principal (CLUB_ADMIN has the floor:edit + floor:publish grants).
  const adminEmail = `floor-plan-${club.id}@example.com`;
  await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminEmail);
  return { club, lounge, patio, L1, P1, admin };
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// Spec 1 — Club Admin can access the editor.
// Spec 2 — Server cannot. (Source contract on the page guard.)
// =============================================================================
describe("Specs 1/2 — access control", () => {
  it("CLUB_ADMIN can open a draft (permission grant in source)", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/permissions.ts"), "utf8",
    );
    expect(src).toMatch(/"hospitality:floor:view"/);
    expect(src).toMatch(/"hospitality:floor:edit"/);
    expect(src).toMatch(/"hospitality:floor:publish"/);
  });

  it("Server roles do not get the new permission keys", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/permissions.ts"), "utf8",
    );
    // STAFF / MEMBER blocks must not include hospitality:floor:*.
    const staffMatch = src.match(/STAFF:\s*\[[\s\S]*?\]/);
    expect(staffMatch?.[0]).not.toMatch(/hospitality:floor/);
    const memberMatch = src.match(/MEMBER:\s*\[[\s\S]*?\]/);
    expect(memberMatch?.[0]).not.toMatch(/hospitality:floor/);
  });

  it("Floor Plans page guards entry on hospitality:floor:view", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/ops/floor-plans/page.tsx"), "utf8",
    );
    expect(src).toMatch(/hasPermission\(principal, clubId, "hospitality:floor:view"\)/);
  });
});

// =============================================================================
// Spec 3 — Admin can create Lounge draft.
// Spec 4 — Admin can create Patio draft.
// Spec 19 — Lounge and Patio drafts are independent.
// =============================================================================
describe("Specs 3/4/19 — independent draft per area", () => {
  it("creates a DRAFT seeded from live tables for Lounge", async () => {
    const ctx = await bootstrap("lounge-draft");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    expect(plan.status).toBe("DRAFT");
    expect(plan.diningAreaId).toBe(ctx.lounge.id);
    expect(plan.tables.length).toBe(1);
    expect(plan.tables[0].tableNumber).toBe("L1");
    expect(plan.tables[0].sourceDiningTableId).toBe(ctx.L1.id);
  });

  it("creates an independent DRAFT for Patio", async () => {
    const ctx = await bootstrap("patio-draft");
    const loungePlan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    const patioPlan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.patio.id);
    expect(patioPlan.id).not.toBe(loungePlan.id);
    expect(patioPlan.diningAreaId).toBe(ctx.patio.id);
    expect(patioPlan.tables[0].tableNumber).toBe("P1");
  });

  it("getOrCreateDraft is idempotent — second call returns same draft", async () => {
    const ctx = await bootstrap("idempotent");
    const a = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    const b = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    expect(b.id).toBe(a.id);
  });
});

// =============================================================================
// Spec 5/6/7 — Admin can add round, square, rectangular tables.
// =============================================================================
describe("Specs 5/6/7 — add tables of each shape", () => {
  for (const shape of ["ROUND", "SQUARE", "RECTANGLE"] as const) {
    it(`adds a ${shape} table to the draft`, async () => {
      const ctx = await bootstrap(`add-${shape.toLowerCase()}`);
      const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
      const row = await addDraftTable(ctx.admin, plan.id, {
        tableNumber: "L99",
        shape, capacity: 4,
        xPos: 200, yPos: 200, width: 80, height: 80,
      });
      expect(row.tableNumber).toBe("L99");
      expect(row.shape).toBe(shape);
      expect(row.archived).toBe(false);
      // Source FK is null — this is a NEW row, not editing an existing live one.
      expect(row.sourceDiningTableId).toBeNull();
    });
  }
});

// =============================================================================
// Spec 8 — Admin can move a table in the draft.
// Spec 9 — Admin can resize a table in the draft.
// =============================================================================
describe("Specs 8/9 — move + resize", () => {
  it("updateDraftTable moves xPos / yPos", async () => {
    const ctx = await bootstrap("move");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    const original = plan.tables[0];
    const updated = await updateDraftTable(ctx.admin, original.id, { xPos: 400, yPos: 300 });
    expect(updated.xPos).toBe(400);
    expect(updated.yPos).toBe(300);
    // Live table is UNCHANGED.
    const live = await db().diningTable.findUnique({ where: { id: ctx.L1.id } });
    expect(live?.xPos).toBe(100);
    expect(live?.yPos).toBe(100);
  });

  it("updateDraftTable resizes width / height", async () => {
    const ctx = await bootstrap("resize");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    const updated = await updateDraftTable(ctx.admin, plan.tables[0].id, { width: 150, height: 100 });
    expect(updated.width).toBe(150);
    expect(updated.height).toBe(100);
  });
});

// =============================================================================
// Spec 10 — Save Draft does not change the live POS map.
// Spec 18 — Draft changes hidden from servers.
// =============================================================================
describe("Specs 10/18 — drafts don't touch the live DiningTable", () => {
  it("adding + moving in a draft leaves DiningTable rows untouched", async () => {
    const ctx = await bootstrap("isolated");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await addDraftTable(ctx.admin, plan.id, {
      tableNumber: "L99", shape: "SQUARE", capacity: 4,
      xPos: 300, yPos: 300, width: 80, height: 80,
    });
    await updateDraftTable(ctx.admin, plan.tables[0].id, { xPos: 500, yPos: 400, width: 200 });

    // Live DiningTable rows: only L1 still, unchanged.
    const liveTables = await db().diningTable.findMany({
      where: { clubId: ctx.club.id, diningAreaId: ctx.lounge.id, active: true },
    });
    expect(liveTables.length).toBe(1);
    expect(liveTables[0].id).toBe(ctx.L1.id);
    expect(liveTables[0].xPos).toBe(100);
    expect(liveTables[0].width).toBe(110);
  });
});

// =============================================================================
// Spec 11 — Publish changes the live POS map.
// Spec 16 — Publishing writes audit log.
// Spec 17 — Live POS map reads published layout only.
// =============================================================================
describe("Specs 11/16/17 — publish reconciles into DiningTable + audits", () => {
  it("publish updates existing DiningTable + creates new + flips status to LIVE", async () => {
    const ctx = await bootstrap("publish");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);

    // Edit the existing L1: move + resize. Add a brand-new L99.
    await updateDraftTable(ctx.admin, plan.tables[0].id, { xPos: 250, width: 130 });
    await addDraftTable(ctx.admin, plan.id, {
      tableNumber: "L99", shape: "ROUND", capacity: 6,
      xPos: 400, yPos: 200, width: 90, height: 90,
    });

    await publishDraft(ctx.admin, plan.id);

    // Live DiningTable should reflect: L1 moved + L99 created.
    const live = await db().diningTable.findMany({
      where: { clubId: ctx.club.id, diningAreaId: ctx.lounge.id, active: true },
      orderBy: { tableNumber: "asc" },
    });
    expect(live.length).toBe(2);
    const liveL1 = live.find((t) => t.tableNumber === "L1");
    expect(liveL1?.xPos).toBe(250);
    expect(liveL1?.width).toBe(130);
    const liveL99 = live.find((t) => t.tableNumber === "L99");
    expect(liveL99).toBeDefined();
    expect(liveL99?.capacity).toBe(6);

    // Plan flipped to LIVE.
    const reloaded = await db().diningFloorPlan.findUnique({ where: { id: plan.id } });
    expect(reloaded?.status).toBe("LIVE");
    expect(reloaded?.publishedAt).not.toBeNull();

    // Audit log entry exists.
    const auditRow = await db().auditLog.findFirst({
      where: { clubId: ctx.club.id, action: "hospitality.floor-plan.publish", entityId: plan.id },
    });
    expect(auditRow).not.toBeNull();
  });
});

// =============================================================================
// Spec 12 — Duplicate table numbers blocked.
// =============================================================================
describe("Spec 12 — duplicate table number blocked", () => {
  it("addDraftTable refuses to add a table number that already exists in the layout", async () => {
    const ctx = await bootstrap("dup");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    // L1 already in the seeded draft. Try to add another L1.
    await expect(
      addDraftTable(ctx.admin, plan.id, {
        tableNumber: "L1", shape: "ROUND", capacity: 4,
        xPos: 200, yPos: 200, width: 80, height: 80,
      }),
    ).rejects.toThrow(/already in this layout/i);
  });

  it("validateDraftForPublish flags duplicates", async () => {
    const ctx = await bootstrap("dup-validate");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    // Force a duplicate via direct DB write (bypass the addDraftTable guard).
    await db().diningFloorPlanTable.create({
      data: {
        clubId: ctx.club.id, floorPlanId: plan.id,
        tableNumber: "L1", shape: "ROUND", capacity: 4,
        xPos: 200, yPos: 200, width: 80, height: 80,
      },
    });
    const issues = await validateDraftForPublish(ctx.admin, plan.id);
    expect(issues.some((i) => /duplicate/i.test(i.message))).toBe(true);
  });
});

// =============================================================================
// Spec 13 — Cannot remove table with active SEATED party.
// Spec 14 — Cannot remove table with open POS check.
// Spec 15 — Cannot remove table with active reservation.
// =============================================================================
describe("Specs 13/14/15 — archive blockers", () => {
  it("blocks archive when table.status === 'SEATED'", async () => {
    const ctx = await bootstrap("archive-seated");
    await db().diningTable.update({ where: { id: ctx.L1.id }, data: { status: "SEATED" } });
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await expect(
      archiveDraftTable(ctx.admin, plan.tables[0].id),
    ).rejects.toThrow(/currently SEATED/i);
  });

  it("blocks archive when an open POS check sits on the table", async () => {
    const ctx = await bootstrap("archive-open-check");
    // Need a location for the check.
    const fbDept = await db().department.findFirst({ where: { clubId: ctx.club.id, code: "FB" } });
    const loc = await db().pOSLocation.create({
      data: { clubId: ctx.club.id, code: LOUNGE_LOCATION_CODE, name: "Lounge", departmentId: fbDept?.id ?? null },
    });
    await db().pOSTerminal.create({
      data: { clubId: ctx.club.id, code: LOUNGE_TERMINAL_CODE, name: "Terminal", locationId: loc.id },
    });
    await db().pOSCheck.create({
      data: {
        clubId: ctx.club.id, locationId: loc.id, checkNumber: "C1",
        status: "OPEN", tableId: ctx.L1.id,
      },
    });
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await expect(
      archiveDraftTable(ctx.admin, plan.tables[0].id),
    ).rejects.toThrow(/open POS check/i);
  });

  it("blocks archive when an active reservation references the table", async () => {
    const ctx = await bootstrap("archive-active-res");
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
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await expect(
      archiveDraftTable(ctx.admin, plan.tables[0].id),
    ).rejects.toThrow(/active reservation/i);
  });
});

// =============================================================================
// Spec 17 — Live POS map reads published layout only.
// =============================================================================
describe("Spec 17 — live floor-map loader reads DiningTable directly (unchanged)", () => {
  it("DiningTable is the source the live loader reads (source contract)", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/page.tsx"),
      "utf8",
    );
    // The loader still queries DiningArea→DiningTable, not DiningFloorPlan.
    expect(src).toMatch(/prisma\.diningArea\.findMany/);
    expect(src).toMatch(/tables:\s*\{/);
    // It does NOT load DiningFloorPlan — the editor is admin-only.
    expect(src).not.toMatch(/prisma\.diningFloorPlan\./);
  });
});

// =============================================================================
// Spec 20 — Cross-tenant edits blocked.
// =============================================================================
describe("Spec 20 — cross-tenant safety", () => {
  it("admin of club A cannot open a draft for club B's area", async () => {
    const a = await bootstrap("ct-a");
    const b = await bootstrap("ct-b");
    await expect(
      getOrCreateDraftForArea(a.admin, b.club.id, b.lounge.id),
    ).rejects.toThrow();
  });

  it("admin of club A cannot publish club B's draft", async () => {
    const a = await bootstrap("ct-publish-a");
    const b = await bootstrap("ct-publish-b");
    const bPlan = await getOrCreateDraftForArea(b.admin, b.club.id, b.lounge.id);
    await expect(
      publishDraft(a.admin, bPlan.id),
    ).rejects.toThrow();
  });
});

// =============================================================================
// Bonus — discard removes the draft.
// =============================================================================
describe("Bonus — discard draft", () => {
  it("discardDraft deletes the plan and its tables", async () => {
    const ctx = await bootstrap("discard");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await discardDraft(ctx.admin, plan.id);
    const reloaded = await db().diningFloorPlan.findUnique({ where: { id: plan.id } });
    expect(reloaded).toBeNull();
    const orphans = await db().diningFloorPlanTable.findMany({ where: { floorPlanId: plan.id } });
    expect(orphans.length).toBe(0);
  });
});

// =============================================================================
// Bonus — publish demotes previous LIVE plan to ARCHIVED (version history).
// =============================================================================
describe("Bonus — previous LIVE plan demoted to ARCHIVED on next publish", () => {
  it("two consecutive publishes leave only one LIVE plan, the rest ARCHIVED", async () => {
    const ctx = await bootstrap("history");
    const plan1 = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await publishDraft(ctx.admin, plan1.id);
    expect((await getLivePlanForArea(ctx.admin, ctx.club.id, ctx.lounge.id))?.id).toBe(plan1.id);

    const plan2 = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await publishDraft(ctx.admin, plan2.id);
    expect((await getLivePlanForArea(ctx.admin, ctx.club.id, ctx.lounge.id))?.id).toBe(plan2.id);

    const archived = await db().diningFloorPlan.findFirst({
      where: { id: plan1.id }, select: { status: true },
    });
    expect(archived?.status).toBe("ARCHIVED");
  });
});

// =============================================================================
// Source contracts — navigation discoverability.
// =============================================================================
describe("Navigation discoverability", () => {
  it("Sidebar registers the editor link with hospitality:floor:view perm", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/components/Sidebar.tsx"), "utf8",
    );
    expect(src).toMatch(/href:\s*"\/app\/admin\/ops\/floor-plans"[\s\S]*?perm:\s*"hospitality:floor:view"/);
  });

  it("Ops hub renders a Floor Plans Card", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/ops/page.tsx"), "utf8",
    );
    expect(src).toMatch(/href="\/app\/admin\/ops\/floor-plans"/);
  });

  it("Live floor map shows Edit Layout link for hospitality:floor:edit principals", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/hospitality/reservations/floor/page.tsx"), "utf8",
    );
    expect(src).toMatch(/hospitality:floor:edit/);
    expect(src).toMatch(/\/app\/admin\/ops\/floor-plans/);
  });

  it("getDraftForArea and getLivePlanForArea exports exist", () => {
    expect(typeof getDraftForArea).toBe("function");
    expect(typeof getLivePlanForArea).toBe("function");
  });
});
