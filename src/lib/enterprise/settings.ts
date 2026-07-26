// Phase 6J — Club settings.
//
// A typed, audited key/value store for club configuration. Identity stays on
// the Club table; everything operational (thresholds, defaults, document
// retention windows, notification opt-ins) lives here.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { tenantWhere } from "../services/tenant";
import { ValidationError } from "../errors";

export const settingSchema = z.object({
  scope: z.string().trim().min(1).max(40),
  key: z.string().trim().min(1).max(80),
  value: z.unknown(),
});

export async function setSetting(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "settings:write");
  const parsed = settingSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const { scope, key, value } = parsed.data;
  const before = await prisma.clubSetting.findUnique({ where: { clubId_scope_key: { clubId, scope, key } } });
  const updated = await prisma.clubSetting.upsert({
    where: { clubId_scope_key: { clubId, scope, key } },
    update: { valueJson: JSON.stringify(value ?? null), updatedByUserId: principal.id },
    create: { clubId, scope, key, valueJson: JSON.stringify(value ?? null), updatedByUserId: principal.id },
  });
  await audit(principal, {
    action: "settings.upsert", entityType: "ClubSetting", entityId: updated.id, clubId,
    before: before ? { value: safeParse(before.valueJson) } : null,
    after: { value: value ?? null },
  });
  return updated;
}

export async function getSetting<T = unknown>(clubId: string, scope: string, key: string): Promise<T | null> {
  const row = await prisma.clubSetting.findUnique({ where: { clubId_scope_key: { clubId, scope, key } } });
  return row ? (safeParse(row.valueJson) as T) : null;
}

export async function listSettings(principal: Principal, clubId: string, scope?: string) {
  requirePermission(principal, clubId, "settings:read");
  return prisma.clubSetting.findMany({
    where: { ...tenantWhere(principal, clubId), ...(scope ? { scope } : {}) },
    orderBy: [{ scope: "asc" }, { key: "asc" }],
  });
}

// ---------------------------------------------------------------------------
// Curated defaults — the well-known settings the platform reads.
// ---------------------------------------------------------------------------
export const SETTING_KEYS = {
  BILLING: {
    statement_day_of_month: { default: 1, description: "Day of the month statements are issued." },
    late_fee_amount: { default: 0, description: "Flat late fee applied after grace period." },
    grace_period_days: { default: 10, description: "Grace days before late fees apply." },
  },
  APPROVAL_THRESHOLDS: {
    ap_invoice_single_approver_max: { default: 1000, description: "Max invoice amount that can be approved by a single user." },
    ap_invoice_two_approvers_max:   { default: 25000, description: "Max invoice amount requiring two approvers." },
    capital_expense_min:            { default: 5000, description: "AP-line minimum that flags isCapital." },
  },
  DOCUMENTS: {
    default_retention_days: { default: 2555, description: "Default document retention (7 years)." },
  },
  NOTIFICATIONS: {
    default_member_channels: { default: ["EMAIL"], description: "Default channels for member notifications." },
    default_internal_channels: { default: ["IN_APP"], description: "Default channels for staff alerts." },
  },
  GOVERNANCE: {
    board_package_distribution_window_days: { default: 7, description: "Days a board package may be distributed after approval." },
  },
} as const;

export async function ensureDefaultSettings(clubId: string) {
  for (const [scope, keys] of Object.entries(SETTING_KEYS)) {
    for (const [key, def] of Object.entries(keys)) {
      const existing = await prisma.clubSetting.findUnique({ where: { clubId_scope_key: { clubId, scope, key } } });
      if (existing) continue;
      await prisma.clubSetting.create({
        data: { clubId, scope, key, valueJson: JSON.stringify((def as { default: unknown }).default) },
      });
    }
  }
}

function safeParse(json: string): unknown { try { return JSON.parse(json); } catch { return null; } }
