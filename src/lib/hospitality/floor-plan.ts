// Step 32 — Floor-plan editor service.
//
// Architecture:
//   - DiningTable is the LIVE source of truth. The POS / floor map
//     reads it; POSCheck.tableId + DiningReservation.tableId FK to it.
//   - DiningFloorPlan (DRAFT/LIVE/ARCHIVED) + DiningFloorPlanTable
//     are EDITOR data. Drafts are freely editable without touching the
//     live POS map.
//   - Publishing reconciles a DRAFT plan into DiningTable rows in a
//     single transaction: existing rows updated, new rows created,
//     removed rows soft-archived (active=false so historical
//     POSCheck/DiningReservation FK rows stay queryable).
//
// Tenant safety: every read/write checks principal + clubId via
// requirePermission + assertTenantOwned. The reconciler / floor-map
// loader continue to read DiningTable through their existing tenant
// guards — no change needed there.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned, tenantWhere } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import {
  computeSpacingIssues,
  nextSequentialDisplayName,
  nextTableNumberForArea,
  PALETTE_DEFAULTS,
  type PaletteKind,
} from "./floor-plan-geometry";

export type FloorPlanStatus = "DRAFT" | "LIVE" | "ARCHIVED";

const SHAPE_VALUES = ["ROUND", "SQUARE", "RECTANGLE"] as const;
type Shape = (typeof SHAPE_VALUES)[number];

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export async function listFloorPlansForArea(
  principal: Principal,
  clubId: string,
  diningAreaId: string,
) {
  requirePermission(principal, clubId, "hospitality:floor:view");
  return prisma.diningFloorPlan.findMany({
    where: { ...tenantWhere(principal, clubId), diningAreaId },
    orderBy: [{ status: "asc" }, { versionNumber: "desc" }],
    include: { tables: { orderBy: { sortOrder: "asc" } } },
  });
}

export async function getDraftForArea(
  principal: Principal,
  clubId: string,
  diningAreaId: string,
) {
  requirePermission(principal, clubId, "hospitality:floor:view");
  return prisma.diningFloorPlan.findFirst({
    where: { ...tenantWhere(principal, clubId), diningAreaId, status: "DRAFT" },
    include: { tables: { orderBy: { sortOrder: "asc" } } },
  });
}

export async function getLivePlanForArea(
  principal: Principal,
  clubId: string,
  diningAreaId: string,
) {
  requirePermission(principal, clubId, "hospitality:floor:view");
  return prisma.diningFloorPlan.findFirst({
    where: { ...tenantWhere(principal, clubId), diningAreaId, status: "LIVE" },
    include: { tables: { orderBy: { sortOrder: "asc" } } },
  });
}

// ---------------------------------------------------------------------------
// Draft lifecycle
// ---------------------------------------------------------------------------

// Creates a draft seeded from the current live DiningTable rows for the
// area, OR returns the existing draft. Editors call this on entry.
export async function getOrCreateDraftForArea(
  principal: Principal,
  clubId: string,
  diningAreaId: string,
) {
  requirePermission(principal, clubId, "hospitality:floor:edit");
  const existing = await getDraftForArea(principal, clubId, diningAreaId);
  if (existing) return existing;

  const area = await prisma.diningArea.findUnique({ where: { id: diningAreaId } });
  if (!area) throw new NotFoundError("DiningArea", diningAreaId);
  assertTenantOwned(area, principal);
  // Step 33 — defend against an admin with memberships in two clubs
  // passing clubId=A but a diningAreaId that belongs to club B. The
  // assertTenantOwned above proves they own area.clubId; this checks
  // it matches the explicit clubId argument.
  if (area.clubId !== clubId) {
    throw new ConflictError("Dining area belongs to a different club.");
  }

  // Seed the draft from the current live tables so the editor starts
  // with the layout the server is using today.
  const liveTables = await prisma.diningTable.findMany({
    where: { clubId, diningAreaId, active: true },
    orderBy: { tableNumber: "asc" },
  });

  const lastVersion = await prisma.diningFloorPlan.findFirst({
    where: { clubId, diningAreaId },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });
  const nextVersion = (lastVersion?.versionNumber ?? 0) + 1;

  const plan = await prisma.diningFloorPlan.create({
    data: {
      clubId, diningAreaId,
      name: `${area.name} — Draft v${nextVersion}`,
      status: "DRAFT",
      versionNumber: nextVersion,
      savedById: principal.id,
      tables: {
        create: liveTables.map((t, idx) => ({
          clubId,
          sourceDiningTableId: t.id,
          tableNumber: t.tableNumber,
          displayName: t.displayName,
          shape: SHAPE_VALUES.includes(t.shape as Shape) ? t.shape : "ROUND",
          capacity: t.capacity,
          xPos: t.xPos ?? 100,
          yPos: t.yPos ?? 100,
          width: t.width,
          height: t.height,
          rotation: t.rotation,
          archived: false,
          sortOrder: idx,
        })),
      },
    },
    include: { tables: { orderBy: { sortOrder: "asc" } } },
  });

  await audit(principal, {
    action: "hospitality.floor-plan.draft.create",
    entityType: "DiningFloorPlan",
    entityId: plan.id,
    clubId,
    after: { diningAreaId, versionNumber: nextVersion, seededTableCount: liveTables.length },
  });
  return plan;
}

// ---------------------------------------------------------------------------
// Draft mutations
// ---------------------------------------------------------------------------

type TableInput = {
  tableNumber: string;
  displayName?: string | null;
  shape: Shape;
  capacity: number;
  xPos: number;
  yPos: number;
  width: number;
  height: number;
  rotation?: number;
};

function validateTableInput(input: TableInput, canvasWidth: number, canvasHeight: number) {
  const issues: Array<{ path: string; message: string }> = [];
  if (!input.tableNumber || !input.tableNumber.trim()) {
    issues.push({ path: "tableNumber", message: "Table number is required." });
  }
  if (!SHAPE_VALUES.includes(input.shape)) {
    issues.push({ path: "shape", message: `Shape must be one of ${SHAPE_VALUES.join("/")}.` });
  }
  if (input.capacity < 1) issues.push({ path: "capacity", message: "Capacity must be at least 1." });
  if (input.capacity > 24) issues.push({ path: "capacity", message: "Capacity must be at most 24." });
  if (input.width < 30) issues.push({ path: "width", message: "Width must be at least 30 px." });
  if (input.height < 30) issues.push({ path: "height", message: "Height must be at least 30 px." });
  // Step 33 — bounds check must account for table size since xPos/yPos
  // are the centre. A 200-wide table centred at canvas-edge would
  // render half off-canvas under the previous check.
  if (input.xPos - input.width / 2 < 0 || input.xPos + input.width / 2 > canvasWidth) {
    issues.push({ path: "xPos", message: `Table extends outside the canvas horizontally (canvas width ${canvasWidth}).` });
  }
  if (input.yPos - input.height / 2 < 0 || input.yPos + input.height / 2 > canvasHeight) {
    issues.push({ path: "yPos", message: `Table extends outside the canvas vertically (canvas height ${canvasHeight}).` });
  }
  if (issues.length > 0) throw new ValidationError(issues);
}

async function loadPlanForEdit(principal: Principal, planId: string) {
  const plan = await prisma.diningFloorPlan.findUnique({
    where: { id: planId },
    include: { diningArea: true, tables: true },
  });
  if (!plan) throw new NotFoundError("DiningFloorPlan", planId);
  assertTenantOwned(plan, principal);
  requirePermission(principal, plan.clubId, "hospitality:floor:edit");
  if (plan.status !== "DRAFT") {
    throw new ConflictError("Only DRAFT plans can be edited.");
  }
  return plan;
}

export async function addDraftTable(
  principal: Principal,
  planId: string,
  input: TableInput,
) {
  const plan = await loadPlanForEdit(principal, planId);
  validateTableInput(input, plan.diningArea.canvasWidth, plan.diningArea.canvasHeight);

  // Duplicate guard — no two non-archived plan rows can share the same
  // tableNumber within the same plan.
  const dup = plan.tables.find(
    (t) => !t.archived && t.tableNumber.trim().toLowerCase() === input.tableNumber.trim().toLowerCase(),
  );
  if (dup) {
    throw new ConflictError(`Table number "${input.tableNumber}" is already in this layout.`);
  }

  const row = await prisma.diningFloorPlanTable.create({
    data: {
      clubId: plan.clubId,
      floorPlanId: plan.id,
      sourceDiningTableId: null,
      tableNumber: input.tableNumber.trim(),
      displayName: input.displayName ?? null,
      shape: input.shape,
      capacity: input.capacity,
      xPos: input.xPos,
      yPos: input.yPos,
      width: input.width,
      height: input.height,
      rotation: input.rotation ?? 0,
      sortOrder: plan.tables.length,
    },
  });
  await prisma.diningFloorPlan.update({
    where: { id: plan.id }, data: { savedAt: new Date(), savedById: principal.id },
  });
  await audit(principal, {
    action: "hospitality.floor-plan.table.add",
    entityType: "DiningFloorPlanTable",
    entityId: row.id,
    clubId: plan.clubId,
    after: { tableNumber: row.tableNumber, shape: row.shape, capacity: row.capacity },
  });
  return row;
}

// ---------------------------------------------------------------------------
// Step 35 — drop a shape from the palette onto the canvas.
//
// Computes a sequential displayName ("Round 3"), a unique operational
// tableNumber ("L7" / "P3"), and sensible default size+capacity from
// the shape, then delegates to addDraftTable. Position is clamped
// into the canvas + snapped to a 10 px grid by the caller.
// ---------------------------------------------------------------------------
export async function addDraftTableFromPalette(
  principal: Principal,
  planId: string,
  // Step 36 — `kind` is the editor's palette vocabulary
  // (Round/Square/Rectangle/Bar Stool). The service maps to the
  // persisted shape via PALETTE_DEFAULTS.
  input: { kind: PaletteKind; xPos: number; yPos: number },
) {
  const plan = await loadPlanForEdit(principal, planId);

  const defaults = PALETTE_DEFAULTS[input.kind];
  if (!defaults) {
    throw new ValidationError([{ path: "kind", message: `Unknown palette kind "${input.kind}".` }]);
  }

  // Sequential display name uses the PALETTE KIND ("Bar Stool 1" /
  // "Round 1" / "Square 1" / "Rectangle 1"), not the persisted shape.
  // The helper's SHAPE_TO_TITLE map handles all four cases.
  const displayName = nextSequentialDisplayName(input.kind, plan.tables);

  // Operational tableNumber — derive area prefix from the area name's
  // first letter and scan BOTH the draft AND the live DiningTable
  // rows so the new number can't collide with either.
  const areaPrefix = plan.diningArea.name.trim().slice(0, 1).toUpperCase() || "T";
  const liveTables = await prisma.diningTable.findMany({
    where: { clubId: plan.clubId, diningAreaId: plan.diningAreaId },
    select: { tableNumber: true },
  });
  const allNumbers = [
    ...plan.tables.filter((t) => !t.archived).map((t) => t.tableNumber),
    ...liveTables.map((t) => t.tableNumber),
  ];
  const tableNumber = nextTableNumberForArea(areaPrefix, allNumbers);

  return addDraftTable(principal, planId, {
    tableNumber,
    displayName,
    shape: defaults.shape,
    capacity: defaults.capacity,
    xPos: input.xPos,
    yPos: input.yPos,
    width: defaults.width,
    height: defaults.height,
    rotation: 0,
  });
}

export async function updateDraftTable(
  principal: Principal,
  planTableId: string,
  patch: Partial<TableInput>,
) {
  const row = await prisma.diningFloorPlanTable.findUnique({
    where: { id: planTableId },
    include: { floorPlan: { include: { diningArea: true, tables: true } } },
  });
  if (!row) throw new NotFoundError("DiningFloorPlanTable", planTableId);
  assertTenantOwned(row, principal);
  requirePermission(principal, row.clubId, "hospitality:floor:edit");
  if (row.floorPlan.status !== "DRAFT") {
    throw new ConflictError("Only DRAFT plans can be edited.");
  }

  const merged: TableInput = {
    tableNumber: (patch.tableNumber ?? row.tableNumber).trim(),
    displayName: patch.displayName ?? row.displayName,
    shape: (patch.shape ?? row.shape) as Shape,
    capacity: patch.capacity ?? row.capacity,
    xPos: patch.xPos ?? row.xPos,
    yPos: patch.yPos ?? row.yPos,
    width: patch.width ?? row.width,
    height: patch.height ?? row.height,
    rotation: patch.rotation ?? row.rotation,
  };
  validateTableInput(merged, row.floorPlan.diningArea.canvasWidth, row.floorPlan.diningArea.canvasHeight);

  // Duplicate guard for the rename case.
  const dup = row.floorPlan.tables.find(
    (t) => t.id !== row.id && !t.archived &&
      t.tableNumber.trim().toLowerCase() === merged.tableNumber.toLowerCase(),
  );
  if (dup) {
    throw new ConflictError(`Table number "${merged.tableNumber}" is already in this layout.`);
  }

  const before = {
    tableNumber: row.tableNumber, xPos: row.xPos, yPos: row.yPos,
    width: row.width, height: row.height, shape: row.shape, capacity: row.capacity,
  };
  const updated = await prisma.diningFloorPlanTable.update({
    where: { id: row.id },
    data: {
      tableNumber: merged.tableNumber,
      displayName: merged.displayName,
      shape: merged.shape,
      capacity: merged.capacity,
      xPos: merged.xPos,
      yPos: merged.yPos,
      width: merged.width,
      height: merged.height,
      rotation: merged.rotation ?? 0,
    },
  });
  await prisma.diningFloorPlan.update({
    where: { id: row.floorPlanId }, data: { savedAt: new Date(), savedById: principal.id },
  });
  await audit(principal, {
    action: "hospitality.floor-plan.table.update",
    entityType: "DiningFloorPlanTable",
    entityId: row.id,
    clubId: row.clubId,
    before,
    after: { ...merged },
  });
  return updated;
}

export async function archiveDraftTable(principal: Principal, planTableId: string) {
  const row = await prisma.diningFloorPlanTable.findUnique({
    where: { id: planTableId },
    include: { floorPlan: true },
  });
  if (!row) throw new NotFoundError("DiningFloorPlanTable", planTableId);
  assertTenantOwned(row, principal);
  requirePermission(principal, row.clubId, "hospitality:floor:edit");
  if (row.floorPlan.status !== "DRAFT") {
    throw new ConflictError("Only DRAFT plans can be edited.");
  }

  // Block removal if the source DiningTable currently has operational
  // activity. The user can resolve those (depart the party, settle
  // the check, close/cancel the reservation) and then re-archive.
  if (row.sourceDiningTableId) {
    const blockers = await detectArchiveBlockers(row.clubId, row.sourceDiningTableId);
    if (blockers.length > 0) {
      throw new ConflictError(
        `Cannot remove "${row.tableNumber}": ${blockers.join("; ")}.`,
      );
    }
  }

  const updated = await prisma.diningFloorPlanTable.update({
    where: { id: row.id }, data: { archived: true },
  });
  await prisma.diningFloorPlan.update({
    where: { id: row.floorPlanId }, data: { savedAt: new Date(), savedById: principal.id },
  });
  await audit(principal, {
    action: "hospitality.floor-plan.table.archive",
    entityType: "DiningFloorPlanTable",
    entityId: row.id,
    clubId: row.clubId,
    after: { tableNumber: row.tableNumber },
  });
  return updated;
}

async function detectArchiveBlockers(clubId: string, diningTableId: string): Promise<string[]> {
  const blockers: string[] = [];
  const table = await prisma.diningTable.findUnique({
    where: { id: diningTableId },
    select: { status: true },
  });
  if (table?.status === "SEATED") blockers.push("table is currently SEATED");
  const openCheck = await prisma.pOSCheck.findFirst({
    where: { tableId: diningTableId, clubId, status: { notIn: ["CLOSED", "VOIDED"] } },
    select: { id: true },
  });
  if (openCheck) blockers.push("an open POS check is on this table");
  const activeRes = await prisma.diningReservation.findFirst({
    where: {
      tableId: diningTableId, clubId,
      status: { in: ["SEATED", "CONFIRMED", "REQUESTED"] },
    },
    select: { id: true },
  });
  if (activeRes) blockers.push("an active reservation is on this table");
  return blockers;
}

export async function discardDraft(principal: Principal, planId: string) {
  const plan = await loadPlanForEdit(principal, planId);
  await prisma.diningFloorPlan.delete({ where: { id: plan.id } });
  await audit(principal, {
    action: "hospitality.floor-plan.draft.discard",
    entityType: "DiningFloorPlan",
    entityId: plan.id,
    clubId: plan.clubId,
    after: { versionNumber: plan.versionNumber },
  });
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Publish — atomically reconcile draft → live DiningTable.
// ---------------------------------------------------------------------------

export type PublishValidationIssue = {
  planTableId: string | null;
  tableNumber: string | null;
  message: string;
};

export async function validateDraftForPublish(
  principal: Principal,
  planId: string,
): Promise<PublishValidationIssue[]> {
  const plan = await prisma.diningFloorPlan.findUnique({
    where: { id: planId },
    include: { diningArea: true, tables: true },
  });
  if (!plan) throw new NotFoundError("DiningFloorPlan", planId);
  assertTenantOwned(plan, principal);
  requirePermission(principal, plan.clubId, "hospitality:floor:view");

  const issues: PublishValidationIssue[] = [];

  const active = plan.tables.filter((t) => !t.archived);
  if (active.length === 0) {
    issues.push({ planTableId: null, tableNumber: null, message: "Layout has no active tables." });
  }

  // Duplicate number guard.
  const numberCounts = new Map<string, number>();
  for (const t of active) {
    const key = t.tableNumber.trim().toLowerCase();
    numberCounts.set(key, (numberCounts.get(key) ?? 0) + 1);
  }
  for (const [num, count] of numberCounts) {
    if (count > 1) {
      const offender = active.find((t) => t.tableNumber.trim().toLowerCase() === num);
      issues.push({
        planTableId: offender?.id ?? null,
        tableNumber: offender?.tableNumber ?? num,
        message: `Duplicate table number "${num}" appears ${count} times.`,
      });
    }
  }

  // Per-row layout sanity — bounds account for tile size (step 33).
  const { canvasWidth, canvasHeight } = plan.diningArea;
  for (const t of active) {
    if (t.capacity < 1) {
      issues.push({ planTableId: t.id, tableNumber: t.tableNumber, message: "Capacity must be ≥ 1." });
    }
    if (t.xPos - t.width / 2 < 0 || t.xPos + t.width / 2 > canvasWidth) {
      issues.push({ planTableId: t.id, tableNumber: t.tableNumber, message: "Table extends outside the canvas horizontally." });
    }
    if (t.yPos - t.height / 2 < 0 || t.yPos + t.height / 2 > canvasHeight) {
      issues.push({ planTableId: t.id, tableNumber: t.tableNumber, message: "Table extends outside the canvas vertically." });
    }
  }

  // Archive-blocker guard. Archived plan rows whose live DiningTable is
  // operationally active must not publish — would lose the table from
  // the live map while a party is still seated at it.
  for (const t of plan.tables.filter((t) => t.archived && t.sourceDiningTableId)) {
    const blockers = await detectArchiveBlockers(plan.clubId, t.sourceDiningTableId!);
    if (blockers.length > 0) {
      issues.push({
        planTableId: t.id,
        tableNumber: t.tableNumber,
        message: `Cannot archive "${t.tableNumber}": ${blockers.join("; ")}.`,
      });
    }
  }

  // Step 33 — pre-check: NEW plan rows (no source) cannot reuse a
  // tableNumber that already exists in DiningTable, including
  // soft-archived ones. Without this, publishDraft's tx.diningTable.create
  // hits Prisma P2002 mid-transaction and the admin sees a generic
  // "Unique constraint" error instead of a fixable validation message.
  const newRows = active.filter((t) => !t.sourceDiningTableId);
  if (newRows.length > 0) {
    const existingNumbers = await prisma.diningTable.findMany({
      where: {
        clubId: plan.clubId,
        tableNumber: { in: newRows.map((t) => t.tableNumber) },
      },
      select: { tableNumber: true, active: true },
    });
    for (const t of newRows) {
      const collide = existingNumbers.find((e) => e.tableNumber === t.tableNumber);
      if (collide) {
        issues.push({
          planTableId: t.id,
          tableNumber: t.tableNumber,
          message: collide.active
            ? `Table number "${t.tableNumber}" already exists in live tables — edit the existing one instead of re-adding.`
            : `Table number "${t.tableNumber}" was used by a previously-archived table. Pick a different number.`,
        });
      }
    }
  }

  // Step 34 — spacing / overlap guard. Tables that overlap or sit
  // closer than MIN_CLEARANCE_PX block publish. Draft save is still
  // allowed (admins stage the layout, then must clean up spacing
  // before promoting it live).
  const spacingIssues = computeSpacingIssues(active);
  for (const s of spacingIssues) {
    issues.push({
      planTableId: s.aId,
      tableNumber: s.aTableNumber,
      message: s.message,
    });
  }

  return issues;
}

export async function publishDraft(principal: Principal, planId: string) {
  const plan = await prisma.diningFloorPlan.findUnique({
    where: { id: planId },
    include: { tables: true, diningArea: true },
  });
  if (!plan) throw new NotFoundError("DiningFloorPlan", planId);
  assertTenantOwned(plan, principal);
  requirePermission(principal, plan.clubId, "hospitality:floor:publish");
  if (plan.status !== "DRAFT") {
    throw new ConflictError("Only DRAFT plans can be published.");
  }

  const issues = await validateDraftForPublish(principal, planId);
  if (issues.length > 0) {
    throw new ValidationError(
      issues.map((i) => ({ path: i.planTableId ?? "plan", message: i.message })),
    );
  }

  const now = new Date();
  // Reconcile draft → DiningTable in a single transaction.
  const summary = await prisma.$transaction(async (tx) => {
    let created = 0;
    let updated = 0;
    let archived = 0;
    for (const t of plan.tables) {
      if (t.archived) {
        if (t.sourceDiningTableId) {
          await tx.diningTable.update({
            where: { id: t.sourceDiningTableId },
            data: { active: false },
          });
          archived++;
        }
        continue;
      }
      if (t.sourceDiningTableId) {
        await tx.diningTable.update({
          where: { id: t.sourceDiningTableId },
          data: {
            tableNumber: t.tableNumber,
            displayName: t.displayName,
            shape: t.shape,
            capacity: t.capacity,
            xPos: t.xPos,
            yPos: t.yPos,
            width: t.width,
            height: t.height,
            rotation: t.rotation,
            active: true,
          },
        });
        updated++;
      } else {
        const newTable = await tx.diningTable.create({
          data: {
            clubId: plan.clubId,
            diningAreaId: plan.diningAreaId,
            tableNumber: t.tableNumber,
            displayName: t.displayName,
            shape: t.shape,
            capacity: t.capacity,
            xPos: t.xPos,
            yPos: t.yPos,
            width: t.width,
            height: t.height,
            rotation: t.rotation,
            active: true,
          },
        });
        // Backfill the linkage so future drafts can edit this row.
        await tx.diningFloorPlanTable.update({
          where: { id: t.id },
          data: { sourceDiningTableId: newTable.id },
        });
        created++;
      }
    }
    // Demote the previous LIVE plan(s) for this area (if any) to ARCHIVED.
    // Capture ids first so we can audit per row (step 33 — CLAUDE.md
    // rule #4 requires every state change to be audited).
    const demoted = await tx.diningFloorPlan.findMany({
      where: { clubId: plan.clubId, diningAreaId: plan.diningAreaId, status: "LIVE" },
      select: { id: true, versionNumber: true },
    });
    await tx.diningFloorPlan.updateMany({
      where: { clubId: plan.clubId, diningAreaId: plan.diningAreaId, status: "LIVE" },
      data: { status: "ARCHIVED" },
    });
    // Promote this draft.
    await tx.diningFloorPlan.update({
      where: { id: plan.id },
      data: {
        status: "LIVE",
        publishedAt: now,
        publishedById: principal.id,
      },
    });
    return { created, updated, archived, demoted };
  });

  // Step 33 — audit per demoted plan so the LIVE → ARCHIVED state
  // change has its own audit row (CLAUDE.md rule #4: every state
  // change is audited).
  for (const d of summary.demoted) {
    await audit(principal, {
      action: "hospitality.floor-plan.archive",
      entityType: "DiningFloorPlan",
      entityId: d.id,
      clubId: plan.clubId,
      before: { status: "LIVE", versionNumber: d.versionNumber },
      after: { status: "ARCHIVED", supersededBy: plan.id, supersededVersion: plan.versionNumber },
    });
  }
  await audit(principal, {
    action: "hospitality.floor-plan.publish",
    entityType: "DiningFloorPlan",
    entityId: plan.id,
    clubId: plan.clubId,
    after: {
      diningAreaId: plan.diningAreaId,
      versionNumber: plan.versionNumber,
      created: summary.created,
      updated: summary.updated,
      archived: summary.archived,
      demotedCount: summary.demoted.length,
    },
  });
  return {
    plan: { ...plan, status: "LIVE" as const, publishedAt: now },
    summary: {
      created: summary.created,
      updated: summary.updated,
      archived: summary.archived,
    },
  };
}
