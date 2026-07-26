// Phase 13E — Staff training / sandbox mode.
//
// A simple per-club toggle that the financial-posting boundary checks. When
// training mode is ON, posting calls should refuse to write to the real
// ledger. The toggle has an `expiresAt` so it auto-disables; an enabled
// session also writes audit + lights up a banner across admin pages.
//
// Training scenarios are pre-seeded checklists per role that walk staff
// through the workflows they need before go-live. They're advisory — nothing
// blocks the user from skipping them.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { isSuperAdmin, requirePermission, type Principal } from "../rbac";
import { ConflictError, NotFoundError, ValidationError } from "../errors";

const DEFAULT_SCENARIOS: Array<{ key: string; roleKey: string; title: string }> = [
  { key: "controller_close", roleKey: "CONTROLLER", title: "Run a month-end close" },
  { key: "controller_review_je", roleKey: "CONTROLLER", title: "Review and approve a journal batch" },
  { key: "gm_dashboard_review", roleKey: "GENERAL_MANAGER", title: "Review the operating dashboard" },
  { key: "gm_approve_invoice", roleKey: "GENERAL_MANAGER", title: "Approve an AP invoice" },
  { key: "dept_inventory_count", roleKey: "DEPARTMENT_MANAGER", title: "Perform an inventory count" },
  { key: "proshop_sale", roleKey: "PRO_SHOP_MANAGER", title: "Ring up a Pro Shop sale" },
  { key: "fnb_private_event", roleKey: "F_AND_B_MANAGER", title: "Book a private event" },
  { key: "board_packet", roleKey: "BOARD_READ_ONLY", title: "Read the latest board package" },
  { key: "auditor_access", roleKey: "AUDITOR_READ_ONLY", title: "Open an audit request" },
  { key: "ar_collections", roleKey: "FINANCE_ADMIN", title: "Walk through the collections queue" },
];

function ensureManage(principal: Principal, clubId: string) {
  if (isSuperAdmin(principal)) return;
  requirePermission(principal, clubId, "settings:write");
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------
export const enableSchema = z.object({
  clubId: z.string(),
  ttlHours: z.number().int().min(1).max(168).default(8),
  notes: z.string().max(2000).optional(),
});

export async function enableTrainingMode(principal: Principal, raw: unknown) {
  const parsed = enableSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  ensureManage(principal, parsed.data.clubId);
  const expiresAt = new Date(Date.now() + parsed.data.ttlHours * 3600_000);
  const mode = await prisma.clubTrainingMode.upsert({
    where: { clubId: parsed.data.clubId },
    update: {
      enabled: true, enabledAt: new Date(), enabledByUserId: principal.id,
      expiresAt, notes: parsed.data.notes ?? null,
    },
    create: {
      clubId: parsed.data.clubId, enabled: true,
      enabledAt: new Date(), enabledByUserId: principal.id,
      expiresAt, notes: parsed.data.notes ?? null,
    },
  });
  // Seed scenarios on first enable (idempotent).
  for (const s of DEFAULT_SCENARIOS) {
    await prisma.trainingScenario.upsert({
      where: { clubId_key: { clubId: parsed.data.clubId, key: s.key } },
      update: {},
      create: { clubId: parsed.data.clubId, key: s.key, roleKey: s.roleKey, title: s.title },
    });
  }
  await audit(principal, { action: "training.enable", entityType: "ClubTrainingMode", entityId: mode.id, clubId: parsed.data.clubId, after: { ttlHours: parsed.data.ttlHours } });
  return mode;
}

export async function disableTrainingMode(principal: Principal, clubId: string) {
  ensureManage(principal, clubId);
  const mode = await prisma.clubTrainingMode.findUnique({ where: { clubId } });
  if (!mode) throw new NotFoundError("ClubTrainingMode", clubId);
  const updated = await prisma.clubTrainingMode.update({
    where: { id: mode.id },
    data: { enabled: false, expiresAt: null },
  });
  await audit(principal, { action: "training.disable", entityType: "ClubTrainingMode", entityId: mode.id, clubId });
  return updated;
}

// ---------------------------------------------------------------------------
// Used by the posting boundary
// ---------------------------------------------------------------------------
export async function isTrainingModeActive(clubId: string): Promise<boolean> {
  const mode = await prisma.clubTrainingMode.findUnique({ where: { clubId } });
  if (!mode || !mode.enabled) return false;
  if (mode.expiresAt && mode.expiresAt.getTime() < Date.now()) {
    // Auto-disable.
    await prisma.clubTrainingMode.update({ where: { id: mode.id }, data: { enabled: false } });
    return false;
  }
  return true;
}

export class TrainingModeBlockedError extends Error {
  constructor(action: string) {
    super(`Action ${action} is blocked while training mode is enabled`);
    this.name = "TrainingModeBlockedError";
  }
}

export async function assertNotTraining(clubId: string, action: string) {
  if (await isTrainingModeActive(clubId)) {
    throw new TrainingModeBlockedError(action);
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
export async function listScenarios(principal: Principal, clubId: string, roleKey?: string) {
  ensureManage(principal, clubId);
  return prisma.trainingScenario.findMany({
    where: { clubId, ...(roleKey ? { roleKey } : {}) },
    orderBy: [{ roleKey: "asc" }, { key: "asc" }],
  });
}

export async function markScenarioComplete(principal: Principal, scenarioId: string) {
  const scenario = await prisma.trainingScenario.findUnique({ where: { id: scenarioId } });
  if (!scenario) throw new NotFoundError("TrainingScenario", scenarioId);
  ensureManage(principal, scenario.clubId);
  if (scenario.status === "COMPLETED") throw new ConflictError("Already complete");
  return prisma.trainingScenario.update({
    where: { id: scenarioId },
    data: { status: "COMPLETED", completedAt: new Date(), completedByUserId: principal.id },
  });
}

export async function resetScenarios(principal: Principal, clubId: string) {
  ensureManage(principal, clubId);
  const updated = await prisma.trainingScenario.updateMany({
    where: { clubId },
    data: { status: "NOT_STARTED", completedAt: null, completedByUserId: null },
  });
  await audit(principal, { action: "training.scenarios.reset", entityType: "TrainingScenario", entityId: null, clubId });
  return updated;
}
