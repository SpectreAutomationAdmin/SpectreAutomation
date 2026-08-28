// Payroll-3B-1 (2026-08-27) — canonical PayrollClubConfig service.
//
// One PayrollClubConfig per Club (schema: `clubId @unique`). This
// service is the ONLY sanctioned write path — every mutation calls
// requirePermission + assertPostingAllowed + audit(). The legacy
// pre-3A ops-side payroll ledger (`src/lib/ops/payroll.ts`) does
// NOT read or write PayrollClubConfig; canonical Payroll lives
// entirely under `src/lib/payroll/`.
//
// Activation preconditions (per Payroll-3B-1 §5):
//   - country must be present (default "CA" is honoured)
//   - provinceOfEmployment must be present
//   - MVP jurisdiction gate: country=CA + province=AB
//   - defaultPayFrequency must be one of the accepted values
//   - defaultPaymentMethod must be one of the accepted values
//   - payrollAdminUserId assigned + user is an active User with a
//     PAYROLL_ADMIN role at this Club
//   - controllerUserId assigned + user is an active User with a
//     CONTROLLER role at this Club
// Activation returns a ValidationError enumerating every missing
// prerequisite so the UI can render actionable messages.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { ValidationError, NotFoundError } from "../errors";

const ENTITY = "PayrollClubConfig";

export const ALLOWED_PAY_FREQUENCIES = ["WEEKLY", "BIWEEKLY", "SEMI_MONTHLY", "MONTHLY"] as const;
export const ALLOWED_PAYMENT_METHODS = ["DIRECT_DEPOSIT", "CHEQUE", "OTHER"] as const;
export const SUPPORTED_COUNTRIES = ["CA"] as const;
export const SUPPORTED_PROVINCES_CA = ["AB"] as const;

export type PayFrequency = (typeof ALLOWED_PAY_FREQUENCIES)[number];
export type PaymentMethod = (typeof ALLOWED_PAYMENT_METHODS)[number];

export interface PayrollClubConfigView {
  clubId: string;
  enabled: boolean;
  country: string;
  provinceOfEmployment: string | null;
  defaultPayFrequency: PayFrequency;
  defaultPaymentMethod: PaymentMethod;
  payrollAdminUserId: string | null;
  controllerUserId: string | null;
  glAccountingProfileId: string | null;
  paystubNumberPrefix: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ConfigRow {
  clubId: string;
  enabled: boolean;
  country: string;
  provinceOfEmployment: string | null;
  defaultPayFrequency: string;
  defaultPaymentMethod: string;
  payrollAdminUserId: string | null;
  controllerUserId: string | null;
  glAccountingProfileId: string | null;
  paystubNumberPrefix: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function projectRow(row: ConfigRow): PayrollClubConfigView {
  const freq = (ALLOWED_PAY_FREQUENCIES as readonly string[]).includes(row.defaultPayFrequency)
    ? (row.defaultPayFrequency as PayFrequency)
    : "BIWEEKLY";
  const method = (ALLOWED_PAYMENT_METHODS as readonly string[]).includes(row.defaultPaymentMethod)
    ? (row.defaultPaymentMethod as PaymentMethod)
    : "DIRECT_DEPOSIT";
  return {
    clubId: row.clubId,
    enabled: row.enabled,
    country: row.country,
    provinceOfEmployment: row.provinceOfEmployment,
    defaultPayFrequency: freq,
    defaultPaymentMethod: method,
    payrollAdminUserId: row.payrollAdminUserId,
    controllerUserId: row.controllerUserId,
    glAccountingProfileId: row.glAccountingProfileId,
    paystubNumberPrefix: row.paystubNumberPrefix,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

/** Read the Club's payroll configuration. Returns null when a config
 *  row has never been initialised for this Club. Read requires
 *  `payroll:read`. */
export async function getPayrollClubConfig(
  principal: Principal,
  clubId: string,
): Promise<PayrollClubConfigView | null> {
  requirePermission(principal, clubId, "payroll:read");
  const row = await prisma.payrollClubConfig.findUnique({ where: { clubId } });
  return row ? projectRow(row) : null;
}

// ---------------------------------------------------------------------------
// Write paths
// ---------------------------------------------------------------------------

export interface UpdatePayrollClubConfigInput {
  country?: string;
  provinceOfEmployment?: string | null;
  defaultPayFrequency?: PayFrequency;
  defaultPaymentMethod?: PaymentMethod;
  payrollAdminUserId?: string | null;
  controllerUserId?: string | null;
  glAccountingProfileId?: string | null;
  paystubNumberPrefix?: string | null;
}

/** Initialise (upsert) the Club's payroll configuration with any
 *  updateable field. `enabled` is NEVER writeable here — activation
 *  goes through `activatePayrollClubConfig` so preconditions are
 *  enforced. */
export async function upsertPayrollClubConfig(
  principal: Principal,
  clubId: string,
  input: UpdatePayrollClubConfigInput,
): Promise<PayrollClubConfigView> {
  requirePermission(principal, clubId, "payroll:write");
  await assertPostingAllowed(principal, clubId, "payroll.config.upsert", ENTITY, clubId);

  const patch: {
    country?: string;
    provinceOfEmployment?: string | null;
    defaultPayFrequency?: string;
    defaultPaymentMethod?: string;
    payrollAdminUserId?: string | null;
    controllerUserId?: string | null;
    glAccountingProfileId?: string | null;
    paystubNumberPrefix?: string | null;
  } = {};

  if (input.country !== undefined) {
    if (!input.country.trim()) {
      throw new ValidationError([{ path: "country", message: "Country required" }]);
    }
    patch.country = input.country.trim().toUpperCase();
  }
  if (input.provinceOfEmployment !== undefined) {
    patch.provinceOfEmployment = input.provinceOfEmployment
      ? input.provinceOfEmployment.trim().toUpperCase()
      : null;
  }
  if (input.defaultPayFrequency !== undefined) {
    if (!(ALLOWED_PAY_FREQUENCIES as readonly string[]).includes(input.defaultPayFrequency)) {
      throw new ValidationError([
        { path: "defaultPayFrequency", message: `Must be one of ${ALLOWED_PAY_FREQUENCIES.join(", ")}` },
      ]);
    }
    patch.defaultPayFrequency = input.defaultPayFrequency;
  }
  if (input.defaultPaymentMethod !== undefined) {
    if (!(ALLOWED_PAYMENT_METHODS as readonly string[]).includes(input.defaultPaymentMethod)) {
      throw new ValidationError([
        { path: "defaultPaymentMethod", message: `Must be one of ${ALLOWED_PAYMENT_METHODS.join(", ")}` },
      ]);
    }
    patch.defaultPaymentMethod = input.defaultPaymentMethod;
  }
  if (input.payrollAdminUserId !== undefined) {
    patch.payrollAdminUserId = input.payrollAdminUserId?.trim() || null;
  }
  if (input.controllerUserId !== undefined) {
    patch.controllerUserId = input.controllerUserId?.trim() || null;
  }
  if (input.glAccountingProfileId !== undefined) {
    patch.glAccountingProfileId = input.glAccountingProfileId?.trim() || null;
  }
  if (input.paystubNumberPrefix !== undefined) {
    const trimmed = (input.paystubNumberPrefix ?? "").trim();
    if (trimmed.length > 16) {
      throw new ValidationError([
        { path: "paystubNumberPrefix", message: "Prefix exceeds 16-character limit" },
      ]);
    }
    patch.paystubNumberPrefix = trimmed || null;
  }

  const before = await prisma.payrollClubConfig.findUnique({ where: { clubId } });
  const row = await prisma.payrollClubConfig.upsert({
    where: { clubId },
    update: patch,
    create: { clubId, ...patch },
  });
  await audit(principal, {
    action: "payroll.config.upsert",
    entityType: ENTITY,
    entityId: row.clubId,
    clubId,
    before: before ? projectRow(before) : null,
    after: projectRow(row),
  });
  return projectRow(row);
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

interface PreconditionCheckResult {
  ok: boolean;
  missing: Array<{ path: string; message: string }>;
}

/** Pure precondition check — returns the missing pieces without
 *  attempting activation. Used by the UI to render a "Ready to
 *  activate" summary. */
export async function checkPayrollActivationPreconditions(
  clubId: string,
): Promise<PreconditionCheckResult> {
  const row = await prisma.payrollClubConfig.findUnique({ where: { clubId } });
  const missing: Array<{ path: string; message: string }> = [];
  if (!row) {
    missing.push({ path: "config", message: "Payroll configuration has not been initialised" });
    return { ok: false, missing };
  }
  if (!row.country?.trim()) {
    missing.push({ path: "country", message: "Country required" });
  } else if (!(SUPPORTED_COUNTRIES as readonly string[]).includes(row.country)) {
    missing.push({
      path: "country",
      message: `Only ${SUPPORTED_COUNTRIES.join(", ")} supported in the current Payroll release`,
    });
  }
  if (!row.provinceOfEmployment?.trim()) {
    missing.push({ path: "provinceOfEmployment", message: "Province of employment required" });
  } else if (row.country === "CA" && !(SUPPORTED_PROVINCES_CA as readonly string[]).includes(row.provinceOfEmployment)) {
    missing.push({
      path: "provinceOfEmployment",
      message: `Only ${SUPPORTED_PROVINCES_CA.join(", ")} supported in the current Payroll release`,
    });
  }
  if (!(ALLOWED_PAY_FREQUENCIES as readonly string[]).includes(row.defaultPayFrequency)) {
    missing.push({ path: "defaultPayFrequency", message: "Default pay frequency required" });
  }
  if (!(ALLOWED_PAYMENT_METHODS as readonly string[]).includes(row.defaultPaymentMethod)) {
    missing.push({ path: "defaultPaymentMethod", message: "Default payment method required" });
  }
  if (!row.payrollAdminUserId) {
    missing.push({ path: "payrollAdminUserId", message: "A Payroll Administrator has not been assigned" });
  } else {
    const ok = await userHasRoleAtClub(row.payrollAdminUserId, clubId, "PAYROLL_ADMIN");
    if (!ok) {
      missing.push({
        path: "payrollAdminUserId",
        message: "Designated Payroll Administrator is not an active PAYROLL_ADMIN at this Club",
      });
    }
  }
  if (!row.controllerUserId) {
    missing.push({ path: "controllerUserId", message: "A Controller has not been assigned" });
  } else {
    const ok = await userHasRoleAtClub(row.controllerUserId, clubId, "CONTROLLER");
    if (!ok) {
      missing.push({
        path: "controllerUserId",
        message: "Designated Controller is not an active CONTROLLER at this Club",
      });
    }
  }
  return { ok: missing.length === 0, missing };
}

/** Activate Payroll for a Club. Validates every precondition; on
 *  failure throws ValidationError enumerating the missing pieces. */
export async function activatePayrollClubConfig(
  principal: Principal,
  clubId: string,
): Promise<PayrollClubConfigView> {
  requirePermission(principal, clubId, "payroll:write");
  await assertPostingAllowed(principal, clubId, "payroll.config.activate", ENTITY, clubId);

  const check = await checkPayrollActivationPreconditions(clubId);
  if (!check.ok) {
    throw new ValidationError(check.missing);
  }
  const before = await prisma.payrollClubConfig.findUnique({ where: { clubId } });
  if (!before) throw new NotFoundError(ENTITY, clubId);
  const row = await prisma.payrollClubConfig.update({
    where: { clubId },
    data: { enabled: true },
  });
  await audit(principal, {
    action: "payroll.config.activate",
    entityType: ENTITY,
    entityId: row.clubId,
    clubId,
    before: { enabled: before.enabled },
    after: { enabled: row.enabled },
  });
  return projectRow(row);
}

/** Deactivate Payroll for a Club. Does not touch other fields; a
 *  future re-activation runs the full precondition check again. */
export async function deactivatePayrollClubConfig(
  principal: Principal,
  clubId: string,
): Promise<PayrollClubConfigView> {
  requirePermission(principal, clubId, "payroll:write");
  await assertPostingAllowed(principal, clubId, "payroll.config.deactivate", ENTITY, clubId);

  const before = await prisma.payrollClubConfig.findUnique({ where: { clubId } });
  if (!before) throw new NotFoundError(ENTITY, clubId);
  const row = await prisma.payrollClubConfig.update({
    where: { clubId },
    data: { enabled: false },
  });
  await audit(principal, {
    action: "payroll.config.deactivate",
    entityType: ENTITY,
    entityId: row.clubId,
    clubId,
    before: { enabled: before.enabled },
    after: { enabled: row.enabled },
  });
  return projectRow(row);
}

// ---------------------------------------------------------------------------
// Role-relationship check
// ---------------------------------------------------------------------------

async function userHasRoleAtClub(
  userId: string,
  clubId: string,
  roleKey: string,
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      status: true,
      clubRoles: { where: { clubId, roleKey }, select: { id: true } },
    },
  });
  if (!user) return false;
  if (user.status !== "ACTIVE") return false;
  return user.clubRoles.length > 0;
}
