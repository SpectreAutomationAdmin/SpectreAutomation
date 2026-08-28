// Payroll-3B-1 (2026-08-27) — canonical PayrollPayGroup service.
//
// Pay groups are the tenant-scoped scheduling/membership boundary
// for payroll processing. Codes are unique within a Club
// (`@@unique([clubId, code])`) — the service enforces the same
// constraint at write time and surfaces a structured ValidationError
// on collision instead of letting Prisma throw a raw P2002.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { ValidationError, NotFoundError } from "../errors";
import { ALLOWED_PAY_FREQUENCIES, type PayFrequency } from "./club-config";

const ENTITY = "PayrollPayGroup";

export const CODE_MAX = 32;
export const NAME_MAX = 80;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_]{0,31}$/;

export interface PayGroupView {
  id: string;
  clubId: string;
  code: string;
  name: string;
  payFrequency: PayFrequency;
  active: boolean;
  payDateOffsetDays: number;
  calendarAnchorDate: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  memberCount: number;
}

interface PayGroupRow {
  id: string;
  clubId: string;
  code: string;
  name: string;
  payFrequency: string;
  active: boolean;
  payDateOffsetDays: number;
  calendarAnchorDate: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function projectRow(row: PayGroupRow, memberCount: number): PayGroupView {
  const freq = (ALLOWED_PAY_FREQUENCIES as readonly string[]).includes(row.payFrequency)
    ? (row.payFrequency as PayFrequency)
    : "BIWEEKLY";
  return {
    id: row.id,
    clubId: row.clubId,
    code: row.code,
    name: row.name,
    payFrequency: freq,
    active: row.active,
    payDateOffsetDays: row.payDateOffsetDays,
    calendarAnchorDate: row.calendarAnchorDate,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    memberCount,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateCode(raw: string): string {
  const trimmed = (raw ?? "").trim().toUpperCase();
  if (!trimmed) {
    throw new ValidationError([{ path: "code", message: "Code required" }]);
  }
  if (trimmed.length > CODE_MAX) {
    throw new ValidationError([
      { path: "code", message: `Code exceeds ${CODE_MAX}-character limit` },
    ]);
  }
  if (!CODE_PATTERN.test(trimmed)) {
    throw new ValidationError([
      {
        path: "code",
        message: "Code must start with a letter or digit and contain only A-Z, 0-9, and underscores",
      },
    ]);
  }
  return trimmed;
}

function validateName(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new ValidationError([{ path: "name", message: "Name required" }]);
  if (trimmed.length > NAME_MAX) {
    throw new ValidationError([
      { path: "name", message: `Name exceeds ${NAME_MAX}-character limit` },
    ]);
  }
  return trimmed;
}

function validatePayFrequency(raw: string): PayFrequency {
  if (!(ALLOWED_PAY_FREQUENCIES as readonly string[]).includes(raw)) {
    throw new ValidationError([
      { path: "payFrequency", message: `Must be one of ${ALLOWED_PAY_FREQUENCIES.join(", ")}` },
    ]);
  }
  return raw as PayFrequency;
}

function validatePayDateOffset(raw: number): number {
  if (!Number.isInteger(raw) || raw < 0 || raw > 30) {
    throw new ValidationError([
      { path: "payDateOffsetDays", message: "Offset must be a whole number of days from 0 to 30" },
    ]);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

/** List every pay group for the tenant, active + inactive, oldest
 *  first (creation order is meaningful to admins). Read requires
 *  `payroll:read`. Returns `memberCount` as of NOW — i.e. rows where
 *  `effectiveFrom <= now && (effectiveTo IS NULL || effectiveTo > now)`. */
export async function listPayGroups(
  principal: Principal,
  clubId: string,
): Promise<PayGroupView[]> {
  requirePermission(principal, clubId, "payroll:read");
  const [rows, memberships] = await Promise.all([
    prisma.payrollPayGroup.findMany({
      where: { clubId },
      orderBy: [{ createdAt: "asc" }],
    }),
    prisma.payrollPayGroupMember.findMany({
      where: {
        clubId,
        effectiveFrom: { lte: new Date() },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
      },
      select: { payGroupId: true },
    }),
  ]);
  const counts = new Map<string, number>();
  for (const m of memberships) counts.set(m.payGroupId, (counts.get(m.payGroupId) ?? 0) + 1);
  return rows.map((r) => projectRow(r, counts.get(r.id) ?? 0));
}

export async function getPayGroup(
  principal: Principal,
  clubId: string,
  id: string,
): Promise<PayGroupView | null> {
  requirePermission(principal, clubId, "payroll:read");
  const row = await prisma.payrollPayGroup.findFirst({ where: { id, clubId } });
  if (!row) return null;
  const memberCount = await prisma.payrollPayGroupMember.count({
    where: {
      clubId,
      payGroupId: id,
      effectiveFrom: { lte: new Date() },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
    },
  });
  return projectRow(row, memberCount);
}

// ---------------------------------------------------------------------------
// Write paths
// ---------------------------------------------------------------------------

export interface CreatePayGroupInput {
  code: string;
  name: string;
  payFrequency: PayFrequency;
  payDateOffsetDays?: number;
  /** Optional at create time (WEEKLY/BIWEEKLY require it later, at
   *  generation time). The service snaps the supplied Date to UTC
   *  midnight so it represents a civil calendar day. */
  calendarAnchorDate?: Date | null;
  notes?: string | null;
  active?: boolean;
}

export async function createPayGroup(
  principal: Principal,
  clubId: string,
  input: CreatePayGroupInput,
): Promise<PayGroupView> {
  requirePermission(principal, clubId, "payroll:write");
  await assertPostingAllowed(principal, clubId, "payroll.pay-group.create", ENTITY, clubId);

  const code = validateCode(input.code);
  const name = validateName(input.name);
  const payFrequency = validatePayFrequency(input.payFrequency);
  const payDateOffsetDays = validatePayDateOffset(input.payDateOffsetDays ?? 5);

  const existing = await prisma.payrollPayGroup.findFirst({ where: { clubId, code } });
  if (existing) {
    throw new ValidationError([
      { path: "code", message: `A pay group with code "${code}" already exists at this Club` },
    ]);
  }

  const calendarAnchorDate = input.calendarAnchorDate
    ? new Date(Date.UTC(
        input.calendarAnchorDate.getUTCFullYear(),
        input.calendarAnchorDate.getUTCMonth(),
        input.calendarAnchorDate.getUTCDate(),
      ))
    : null;

  const row = await prisma.payrollPayGroup.create({
    data: {
      clubId,
      code,
      name,
      payFrequency,
      payDateOffsetDays,
      calendarAnchorDate,
      notes: input.notes?.trim() || null,
      active: input.active ?? true,
      createdByUserId: principal.id,
    },
  });
  await audit(principal, {
    action: "payroll.pay-group.create",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    after: { code: row.code, name: row.name, payFrequency: row.payFrequency, active: row.active },
  });
  return projectRow(row, 0);
}

export interface UpdatePayGroupInput {
  name?: string;
  payFrequency?: PayFrequency;
  payDateOffsetDays?: number;
  calendarAnchorDate?: Date | null;
  notes?: string | null;
  active?: boolean;
}

/** Fields whose value participates in generated Pay Period dates.
 *  Payroll-3B-2 config-change safety refuses mutations to any of
 *  these fields once generated periods exist. */
const CALENDAR_AFFECTING_FIELDS: Array<keyof UpdatePayGroupInput> = [
  "payFrequency",
  "payDateOffsetDays",
  "calendarAnchorDate",
];

/** Update a pay group. Note: `code` is intentionally NOT editable —
 *  changing a pay group's code silently invalidates downstream
 *  references, and 3B-1 does not need renamable codes. If a rename
 *  is genuinely needed, deactivate this pay group and create a new
 *  one with the desired code. */
export async function updatePayGroup(
  principal: Principal,
  clubId: string,
  id: string,
  input: UpdatePayGroupInput,
): Promise<PayGroupView> {
  requirePermission(principal, clubId, "payroll:write");
  await assertPostingAllowed(principal, clubId, "payroll.pay-group.update", ENTITY, id);

  const row = await prisma.payrollPayGroup.findFirst({ where: { id, clubId } });
  if (!row) throw new NotFoundError(ENTITY, id);

  // Payroll-3B-2 guard — if the caller is touching any field that
  // participates in generated period dates, refuse the mutation
  // when Pay Periods already exist for this group. Payroll evidence
  // becomes historical the moment it exists; a controlled amendment
  // workflow will arrive in a later slice.
  const calendarChange = CALENDAR_AFFECTING_FIELDS.some((f) => input[f] !== undefined);
  if (calendarChange) {
    const existingPeriodCount = await prisma.payrollPayPeriod.count({
      where: { clubId, payGroupId: id },
    });
    if (existingPeriodCount > 0) {
      throw new ValidationError([
        {
          path: "calendar",
          message:
            `This Pay Group already has ${existingPeriodCount} generated pay period` +
            `${existingPeriodCount === 1 ? "" : "s"}. Payroll calendar settings (frequency, ` +
            `pay-date offset, calendar anchor) cannot be changed once pay periods exist. ` +
            `Non-calendar edits (name, notes, active) remain available.`,
        },
      ]);
    }
  }

  const patch: {
    name?: string;
    payFrequency?: string;
    payDateOffsetDays?: number;
    calendarAnchorDate?: Date | null;
    notes?: string | null;
    active?: boolean;
  } = {};
  if (input.name !== undefined) patch.name = validateName(input.name);
  if (input.payFrequency !== undefined) patch.payFrequency = validatePayFrequency(input.payFrequency);
  if (input.payDateOffsetDays !== undefined) patch.payDateOffsetDays = validatePayDateOffset(input.payDateOffsetDays);
  if (input.calendarAnchorDate !== undefined) {
    patch.calendarAnchorDate = input.calendarAnchorDate
      ? new Date(Date.UTC(
          input.calendarAnchorDate.getUTCFullYear(),
          input.calendarAnchorDate.getUTCMonth(),
          input.calendarAnchorDate.getUTCDate(),
        ))
      : null;
  }
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
  if (input.active !== undefined) patch.active = input.active;

  const updated = await prisma.payrollPayGroup.update({ where: { id: row.id }, data: patch });
  await audit(principal, {
    action: "payroll.pay-group.update",
    entityType: ENTITY,
    entityId: updated.id,
    clubId,
    before: { name: row.name, payFrequency: row.payFrequency, active: row.active },
    after: { name: updated.name, payFrequency: updated.payFrequency, active: updated.active },
  });
  const memberCount = await prisma.payrollPayGroupMember.count({
    where: {
      clubId,
      payGroupId: id,
      effectiveFrom: { lte: new Date() },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
    },
  });
  return projectRow(updated, memberCount);
}

export async function setPayGroupActive(
  principal: Principal,
  clubId: string,
  id: string,
  active: boolean,
): Promise<PayGroupView> {
  return updatePayGroup(principal, clubId, id, { active });
}
