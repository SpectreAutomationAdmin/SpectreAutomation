// TA-1B (2026-09-03) — Tenant Administration constants.
//
// Canonical operational responsibility keys and the tenant-assignable
// role allow-list. Keep this file free of Prisma imports so it is safe
// to import from anywhere.

import type { RoleKey } from "../permissions";

// ---------------------------------------------------------------------
// Responsibility keys currently declared. TA-1B only ships one; later
// slices extend this union (PAYROLL_ADMINISTRATION, PAYROLL_FINAL_APPROVAL,
// DEPARTMENT_TIME_APPROVAL, AP_APPROVAL, etc.).
// ---------------------------------------------------------------------
export const RESPONSIBILITY_KEYS = ["TENANT_ADMINISTRATION"] as const;
export type ResponsibilityKey = (typeof RESPONSIBILITY_KEYS)[number];

// ---------------------------------------------------------------------
// Tenant-assignable role allow-list. A Tenant Administrator may grant
// any of these UserClubRole.roleKey values on invitation / role change.
// Deliberately EXCLUDES:
//   - SUPER_ADMIN            (platform-only; would breach tenant boundary)
//   - MEMBER                 (member portal role, not admin)
// If a role a founder considers tenant-managed is missing, add it here
// with intent — do not silently accept anything the RBAC map defines.
// ---------------------------------------------------------------------
export const TENANT_ASSIGNABLE_ROLES: ReadonlyArray<RoleKey> = [
  "CLUB_ADMIN",
  "GENERAL_MANAGER",
  "CONTROLLER",
  "FINANCE_ADMIN",
  "DEPARTMENT_MANAGER",
  "PRO_SHOP_MANAGER",
  "F_AND_B_MANAGER",
  "EVENT_MANAGER",
  "PAYROLL_ADMIN",
  "STAFF",
  "AUDITOR_READ_ONLY",
  "BOARD_READ_ONLY",
] as const;

export function isTenantAssignableRole(roleKey: string): roleKey is RoleKey {
  return (TENANT_ASSIGNABLE_ROLES as ReadonlyArray<string>).includes(roleKey);
}

// ---------------------------------------------------------------------
// Human-readable role labels — the invitation UI renders these; raw
// UserClubRole.roleKey literals must not leak to founder-facing surfaces.
// ---------------------------------------------------------------------
export const ROLE_LABELS: Record<RoleKey, string> = {
  SUPER_ADMIN: "Spectre Platform Admin",
  CLUB_ADMIN: "Club Administrator",
  GENERAL_MANAGER: "General Manager",
  CONTROLLER: "Controller",
  FINANCE_ADMIN: "Finance Administrator",
  DEPARTMENT_MANAGER: "Department Manager",
  PRO_SHOP_MANAGER: "Pro Shop Manager",
  F_AND_B_MANAGER: "Food & Beverage Manager",
  EVENT_MANAGER: "Event Manager",
  PAYROLL_ADMIN: "Payroll Administrator",
  MEMBER: "Member",
  STAFF: "Staff",
  AUDITOR_READ_ONLY: "External Auditor (read-only)",
  BOARD_READ_ONLY: "Board Member (read-only)",
};

// ---------------------------------------------------------------------
// Membership + invitation status enums.
// ---------------------------------------------------------------------
export type UserClubProfileStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";
export const USER_CLUB_PROFILE_STATUS_ORDER: UserClubProfileStatus[] = [
  "ACTIVE",
  "SUSPENDED",
  "REVOKED",
];

export type AdminInvitationStatus =
  | "PENDING"
  | "SENT"
  | "OPENED"
  | "ACTIVATED"
  | "EXPIRED"
  | "REVOKED"
  | "FAILED";

// Invitations in these states are still "live" for the purpose of
// deduping outstanding invitations to the same email.
export const LIVE_INVITATION_STATUSES: AdminInvitationStatus[] = [
  "PENDING",
  "SENT",
  "OPENED",
];

// Default invitation lifetime.
export const DEFAULT_INVITATION_TTL_DAYS = 7;
export const MIN_INVITATION_TTL_DAYS = 1;
export const MAX_INVITATION_TTL_DAYS = 30;

// ---------------------------------------------------------------------
// Responsibility assignment roles.
// ---------------------------------------------------------------------
export type ResponsibilityRole = "PRIMARY" | "BACKUP";
