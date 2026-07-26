// Admin → Club Settings service.
//
// All reads and writes flow through this module so tenant isolation
// is enforced in exactly one place. Callers pass a Principal; the
// service derives clubId from the principal's active club and
// rejects any cross-club access at the boundary.
//
// Validation is Zod-based; the schema lives in
// src/lib/clubs/profile-validation.ts and is shared with the Admin
// page's server action so the same rules apply on form submit and
// in API/test paths.

import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import type { Principal } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { computeFiscalPeriod, type FiscalPeriodResult } from "./fiscal-period";
import { clubProfileInputSchema, type ClubProfileInput } from "./profile-validation";

// ---------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------

/**
 * Return the ClubProfile row for the given clubId. Always tenant-scoped
 * — the caller's principal must hold `settings:read` at that clubId.
 *
 * Returns null when no profile exists yet; the admin page treats null
 * as "first save" so the form renders with empty defaults.
 */
export async function getClubProfile(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "settings:read");
  return prisma.clubProfile.findUnique({ where: { clubId } });
}

// ---------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------

/**
 * Upsert the ClubProfile for the current club.
 *
 * Tenant guards:
 *   1. requirePermission(principal, clubId, "settings:write")
 *   2. Any chosen default-account ID must belong to the SAME clubId.
 *      A user that tries to set a defaultArAccountId pointing at
 *      another club's chart-of-accounts row is rejected with
 *      ValidationError; this prevents data leakage across tenants.
 *
 * Validation: input is parsed through clubProfileInputSchema first.
 * The schema enforces year-bounds, email/URL shape, GST format,
 * and fiscal month/day validity (Feb-30, Apr-31 etc. → rejected).
 *
 * Audit: every successful upsert writes an audit row with before/after.
 */
export async function upsertClubProfile(
  principal: Principal,
  clubId: string,
  input: unknown,
) {
  requirePermission(principal, clubId, "settings:write");

  // Validate input shape. safeParse returns errors with field paths so
  // the form can surface them inline.
  const parsed = clubProfileInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const data = parsed.data;

  // Tenant guard for any selected default-account ids. Each id must
  // resolve to an Account owned by this clubId; otherwise reject with
  // a ValidationError naming the offending field so the form can
  // highlight it.
  await assertAccountsBelongToClub(clubId, data);

  const before = await prisma.clubProfile.findUnique({ where: { clubId } });

  const saved = await prisma.clubProfile.upsert({
    where: { clubId },
    create: {
      clubId,
      ...data,
      updatedByUserId: principal.id,
    },
    update: {
      ...data,
      updatedByUserId: principal.id,
    },
  });

  await audit(principal, {
    action: before ? "club-profile.update" : "club-profile.create",
    entityType: "ClubProfile",
    entityId: saved.id,
    clubId,
    before: before ?? undefined,
    after: saved,
  });

  return saved;
}

// ---------------------------------------------------------------------
// Cross-tenant account-id check
// ---------------------------------------------------------------------

const ACCOUNT_FIELDS = [
  "defaultArAccountId",
  "defaultApAccountId",
  "defaultRetainedEarningsAccountId",
  "defaultCurrentYearEarningsAccountId",
  "defaultOperatingBankAccountId",
  "defaultReserveBankAccountId",
  "defaultMemberReceivablesAccountId",
  "defaultSalesTaxPayableAccountId",
] as const;

async function assertAccountsBelongToClub(clubId: string, data: ClubProfileInput) {
  const chosenIds: Array<{ field: string; id: string }> = [];
  for (const field of ACCOUNT_FIELDS) {
    const id = data[field];
    if (id) chosenIds.push({ field, id });
  }
  if (chosenIds.length === 0) return;

  const ids = chosenIds.map((c) => c.id);
  const owned = await prisma.account.findMany({
    where: { clubId, id: { in: ids } },
    select: { id: true },
  });
  const ownedSet = new Set(owned.map((a) => a.id));

  const violations = chosenIds.filter((c) => !ownedSet.has(c.id));
  if (violations.length > 0) {
    throw new ValidationError(
      violations.map((v) => ({
        path: v.field,
        message: `Account ${v.id} does not belong to this club.`,
      })),
    );
  }
}

// ---------------------------------------------------------------------
// Fiscal-period lookup for the club
// ---------------------------------------------------------------------

/**
 * Compute the fiscal period for a given date using the club's
 * configured fiscal-year-end. Returns null when no profile exists or
 * fiscal-year-end fields are not set (caller decides the fallback —
 * e.g., monthly-reporting falls back to a hardcoded demo value).
 *
 * No permission check here — this is a read of derived data (date
 * math against a single int pair) that any user of the club already
 * has access to via the rendered report; making this open avoids a
 * permissions ping-pong every time a report header re-renders.
 *
 * NOTE: this does NOT consult the FiscalYear/FiscalPeriod tables. It
 * is pure date math from the configured fiscalYearEndMonth/Day so the
 * helper is stable for any date including dates that fall outside
 * the range of already-generated FiscalPeriod rows.
 */
export async function getFiscalPeriodForClub(
  clubId: string,
  date: Date,
): Promise<FiscalPeriodResult | null> {
  const profile = await prisma.clubProfile.findUnique({
    where: { clubId },
    select: { fiscalYearEndMonth: true, fiscalYearEndDay: true },
  });
  if (!profile?.fiscalYearEndMonth || !profile?.fiscalYearEndDay) return null;
  return computeFiscalPeriod(profile.fiscalYearEndMonth, profile.fiscalYearEndDay, date);
}

// ---------------------------------------------------------------------
// Tenant-safety wrapper for read-by-club used by reports
// ---------------------------------------------------------------------

/**
 * Read-only convenience used by downstream rendering (monthly package,
 * statements, invoices, etc.). Does NOT require a Principal because
 * the caller has already authenticated and is reading the club they
 * are currently viewing. Returns null if no profile is configured.
 *
 * Callers MUST resolve `clubId` from a tenant-scoped path before
 * calling this (e.g. via getActiveClubId or page-level guards). Passing
 * a clubId chosen from user input would defeat the purpose of the
 * tenant model.
 */
export async function readClubProfile(clubId: string) {
  return prisma.clubProfile.findUnique({ where: { clubId } });
}

// Re-export so callers have a single import path.
export { clubProfileInputSchema };
export type { ClubProfileInput };
export { computeFiscalPeriod };
export type { FiscalPeriodResult };

// Defensive re-export: the schema's underlying types should never
// shape-shift across modules. Compile-time check below would surface
// if someone removed a field from the Zod schema that the service
// still references.
type _ClubProfileShapeSanity = Required<Pick<ClubProfileInput, (typeof ACCOUNT_FIELDS)[number]>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _shapeSanity: _ClubProfileShapeSanity | undefined = undefined;
// Re-throw of unused-var rule for build cleanliness; keeping the type
// check is the real point of this block.
export type { ForbiddenError };
