// Step 34 — spacing rules at the publish boundary.
//
// Pins the contract that:
//   - Save Draft is ALWAYS allowed (addDraftTable / updateDraftTable
//     do not run spacing checks; only canvas-bounds + capacity).
//   - validateDraftForPublish flags overlap + too-close as issues.
//   - publishDraft throws when those issues exist (server-side
//     re-validates; client-side panel is convenience only).
//   - Once spacing is fixed, publish succeeds.
//   - Existing draft/live isolation and archive-blocker tests still
//     pass alongside the new spacing rule.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  db, makeUser, principalFor, resetDb, seedRbac,
} from "./util/db";
import { bootstrapAPClub } from "./util/ap";
import {
  getOrCreateDraftForArea,
  addDraftTable,
  updateDraftTable,
  validateDraftForPublish,
  publishDraft,
} from "@/lib/hospitality/floor-plan";

async function bootstrap(name: string) {
  const club = await bootstrapAPClub(name);
  const lounge = await db().diningArea.create({
    data: { clubId: club.id, name: "Lounge", sortOrder: 0 },
  });
  // Seed live tables that are widely spaced so the seeded draft is
  // valid out of the box.
  await db().diningTable.create({
    data: {
      clubId: club.id, diningAreaId: lounge.id, tableNumber: "L1", capacity: 4,
      shape: "SQUARE", xPos: 100, yPos: 100, width: 80, height: 80,
    },
  });
  const adminEmail = `spacing-${club.id}@example.com`;
  await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
  const admin = await principalFor(adminEmail);
  return { club, lounge, admin };
}

beforeAll(async () => { await resetDb(); await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// =============================================================================
// Save Draft is ALWAYS allowed (no spacing block at add/update time).
// =============================================================================
describe("Save Draft is allowed even with overlap or too-close tables", () => {
  it("addDraftTable accepts a placement that overlaps another row", async () => {
    const ctx = await bootstrap("save-overlap-allowed");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    // L1 already at (100, 100) 80×80. Add L99 directly on top.
    const row = await addDraftTable(ctx.admin, plan.id, {
      tableNumber: "L99", shape: "SQUARE", capacity: 4,
      xPos: 100, yPos: 100, width: 80, height: 80,
    });
    expect(row.id).toBeTruthy();
  });

  it("updateDraftTable accepts a drag that moves a table onto another", async () => {
    const ctx = await bootstrap("save-overlap-move");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await addDraftTable(ctx.admin, plan.id, {
      tableNumber: "L99", shape: "SQUARE", capacity: 4,
      xPos: 400, yPos: 400, width: 80, height: 80,
    });
    const reloaded = await db().diningFloorPlanTable.findFirst({
      where: { floorPlanId: plan.id, tableNumber: "L99" },
    });
    // Drag L99 onto L1 (which sits at 100,100).
    const moved = await updateDraftTable(ctx.admin, reloaded!.id, { xPos: 100, yPos: 100 });
    expect(moved.xPos).toBe(100);
    expect(moved.yPos).toBe(100);
  });
});

// =============================================================================
// validateDraftForPublish surfaces spacing issues.
// =============================================================================
describe("validateDraftForPublish detects overlap + too-close issues", () => {
  it("overlap surfaces as an issue", async () => {
    const ctx = await bootstrap("validate-overlap");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await addDraftTable(ctx.admin, plan.id, {
      tableNumber: "L99", shape: "SQUARE", capacity: 4,
      xPos: 110, yPos: 110, width: 80, height: 80,
    });
    const issues = await validateDraftForPublish(ctx.admin, plan.id);
    expect(issues.some((i) => /overlaps/i.test(i.message))).toBe(true);
  });

  it("too-close surfaces as an issue with the live gap reported", async () => {
    const ctx = await bootstrap("validate-tooclose");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    // L1 spans 60..140 horizontally. Place L99 at x=148 (spans 108..188).
    // Wait — L99 80-wide centered at 148 spans 108..188. L1 right edge=140.
    // Gap is 108 - 140 = -32 — that overlaps. Push L99 right.
    // L99 at x=180 (spans 140..220): touches L1 → gap 0 → TOO_CLOSE.
    // Need to land in the 1..15 gap range: L99 at x=188 → spans 148..228 → gap=148-140=8.
    await addDraftTable(ctx.admin, plan.id, {
      tableNumber: "L99", shape: "SQUARE", capacity: 4,
      xPos: 188, yPos: 100, width: 80, height: 80,
    });
    const issues = await validateDraftForPublish(ctx.admin, plan.id);
    expect(issues.some((i) => /too close/i.test(i.message))).toBe(true);
  });
});

// =============================================================================
// publishDraft is blocked by spacing issues.
// =============================================================================
describe("publishDraft blocks on overlap / too-close", () => {
  it("rejects publish when an overlap exists", async () => {
    const ctx = await bootstrap("publish-overlap");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await addDraftTable(ctx.admin, plan.id, {
      tableNumber: "L99", shape: "SQUARE", capacity: 4,
      xPos: 110, yPos: 110, width: 80, height: 80,
    });
    await expect(publishDraft(ctx.admin, plan.id)).rejects.toThrow();
  });

  it("rejects publish when tables are too close", async () => {
    const ctx = await bootstrap("publish-tooclose");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    await addDraftTable(ctx.admin, plan.id, {
      tableNumber: "L99", shape: "SQUARE", capacity: 4,
      xPos: 188, yPos: 100, width: 80, height: 80,
    });
    await expect(publishDraft(ctx.admin, plan.id)).rejects.toThrow();
  });
});

// =============================================================================
// Publish succeeds once spacing is fixed.
// =============================================================================
describe("Publish succeeds once spacing is repaired", () => {
  it("drag the offending table away with ≥ MIN_CLEARANCE_PX, then publish", async () => {
    const ctx = await bootstrap("repair");
    const plan = await getOrCreateDraftForArea(ctx.admin, ctx.club.id, ctx.lounge.id);
    // Bad placement first.
    const newRow = await addDraftTable(ctx.admin, plan.id, {
      tableNumber: "L99", shape: "SQUARE", capacity: 4,
      xPos: 110, yPos: 110, width: 80, height: 80,
    });
    // Repair: drag to a clearly-separated location.
    await updateDraftTable(ctx.admin, newRow.id, { xPos: 400, yPos: 400 });

    // Validator now empty.
    const issues = await validateDraftForPublish(ctx.admin, plan.id);
    expect(issues.length).toBe(0);

    // Publish succeeds + the new table is live.
    await publishDraft(ctx.admin, plan.id);
    const live = await db().diningTable.findFirst({
      where: { clubId: ctx.club.id, tableNumber: "L99", active: true },
    });
    expect(live).not.toBeNull();
  });
});
