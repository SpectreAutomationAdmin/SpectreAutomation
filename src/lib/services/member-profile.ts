// Member-self profile, household, and preference management.
//
// Permission model: a member can manage their own record (self:profile:write).
// An admin with members:write can manage on behalf. ensureSelfOrAdmin centralizes
// the check.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, type Principal } from "../rbac";
import { assertTenantOwned } from "./tenant";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";

function ensureSelfOrAdmin(principal: Principal, member: { id: string; clubId: string }) {
  if (hasPermission(principal, member.clubId, "members:write")) return;
  if (principal.memberId === member.id && hasPermission(principal, member.clubId, "self:profile:write")) return;
  throw new ForbiddenError("Not permitted to edit this profile");
}

// -- Profile contact info ---------------------------------------------------
// Optional strings that should become null (not "") when blanked, so the
// column doesn't drift between "user blanked the field" and "never set".
// `.optional()` MUST be last so absent keys stay undefined and the transform
// is skipped — otherwise every absent column would be overwritten with null.
const optionalNullableString = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length ? v : null))
    .optional();

export const profileSchema = z.object({
  phone: optionalNullableString(40),
  email: z.string().email().max(254).optional(),
  // YYYY-MM-DD from <input type="date"> — parse defensively so a malformed
  // string fails validation rather than silently writing Invalid Date.
  dateOfBirth: z
    .string()
    .trim()
    .transform((v, ctx) => {
      if (!v) return null;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid date" });
        return z.NEVER;
      }
      return d;
    })
    .optional(),
  addressLine1: optionalNullableString(200),
  addressLine2: optionalNullableString(200),
  city: optionalNullableString(100),
  state: optionalNullableString(100),
  postalCode: optionalNullableString(20),
  country: optionalNullableString(100),
  // Phase 20 (Member Database) — extended demographic fields on the
  // primary Member. All optional; blank strings coerce to null so
  // the admin edit form can clear a value without a special "unset".
  firstName: optionalNullableString(100),
  middleName: optionalNullableString(100),
  lastName: optionalNullableString(100),
  nickname: optionalNullableString(100),
  salutation: optionalNullableString(40),
  gender: optionalNullableString(40),
  homePhone: optionalNullableString(40),
  profileImageUrl: optionalNullableString(500),
});

export async function updateProfile(principal: Principal, memberId: string, raw: unknown) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  ensureSelfOrAdmin(principal, member);
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const data: {
    phone?: string | null;
    email?: string;
    dateOfBirth?: Date | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
    firstName?: string;
    middleName?: string | null;
    lastName?: string;
    nickname?: string | null;
    salutation?: string | null;
    gender?: string | null;
    homePhone?: string | null;
    profileImageUrl?: string | null;
  } = {};
  if (parsed.data.phone !== undefined) data.phone = parsed.data.phone;
  if (parsed.data.email) data.email = parsed.data.email.toLowerCase();
  if (parsed.data.dateOfBirth !== undefined) data.dateOfBirth = parsed.data.dateOfBirth;
  if (parsed.data.addressLine1 !== undefined) data.addressLine1 = parsed.data.addressLine1;
  if (parsed.data.addressLine2 !== undefined) data.addressLine2 = parsed.data.addressLine2;
  if (parsed.data.city !== undefined) data.city = parsed.data.city;
  if (parsed.data.state !== undefined) data.state = parsed.data.state;
  if (parsed.data.postalCode !== undefined) data.postalCode = parsed.data.postalCode;
  if (parsed.data.country !== undefined) data.country = parsed.data.country;
  // Phase 20 (Member Database) — firstName/lastName may be cleared
  // only via a validation-guarded pathway upstream; the schema treats
  // blank strings as null which would break Member's NOT NULL name
  // columns, so we drop the null on the write when it appears.
  if (parsed.data.firstName) data.firstName = parsed.data.firstName;
  if (parsed.data.lastName) data.lastName = parsed.data.lastName;
  if (parsed.data.middleName !== undefined) data.middleName = parsed.data.middleName;
  if (parsed.data.nickname !== undefined) data.nickname = parsed.data.nickname;
  if (parsed.data.salutation !== undefined) data.salutation = parsed.data.salutation;
  if (parsed.data.gender !== undefined) data.gender = parsed.data.gender;
  if (parsed.data.homePhone !== undefined) data.homePhone = parsed.data.homePhone;
  if (parsed.data.profileImageUrl !== undefined) data.profileImageUrl = parsed.data.profileImageUrl;
  const updated = await prisma.member.update({ where: { id: memberId }, data });
  await audit(principal, {
    action: "member.profile.update",
    entityType: "Member",
    entityId: memberId,
    clubId: member.clubId,
    before: {
      phone: member.phone,
      email: member.email,
      dateOfBirth: member.dateOfBirth,
      addressLine1: member.addressLine1,
      addressLine2: member.addressLine2,
      city: member.city,
      state: member.state,
      postalCode: member.postalCode,
      country: member.country,
    },
    after: {
      phone: updated.phone,
      email: updated.email,
      dateOfBirth: updated.dateOfBirth,
      addressLine1: updated.addressLine1,
      addressLine2: updated.addressLine2,
      city: updated.city,
      state: updated.state,
      postalCode: updated.postalCode,
      country: updated.country,
    },
  });
  return updated;
}

// -- Household --------------------------------------------------------------
export const householdSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  relationship: z.enum(["SPOUSE", "PARTNER", "CHILD", "OTHER"]),
  email: z.string().email().max(254).optional().or(z.literal("")).transform((v) => v && v.length ? v : null),
  phone: z.string().trim().max(40).optional().or(z.literal("")).transform((v) => v && v.length ? v : null),
  dateOfBirth: z.string().trim().optional().or(z.literal("")).transform((v) => v && v.length ? new Date(v) : null),
});

export async function addHouseholdMember(principal: Principal, memberId: string, raw: unknown) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  ensureSelfOrAdmin(principal, member);
  const parsed = householdSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const row = await prisma.memberHouseholdMember.create({
    data: { clubId: member.clubId, memberId, ...parsed.data },
  });
  await audit(principal, {
    action: "member.household.add",
    entityType: "MemberHouseholdMember",
    entityId: row.id,
    clubId: member.clubId,
    after: row,
  });
  return row;
}

export async function removeHouseholdMember(principal: Principal, memberId: string, householdId: string) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  ensureSelfOrAdmin(principal, member);
  const row = await prisma.memberHouseholdMember.findUnique({ where: { id: householdId } });
  if (!row || row.memberId !== memberId) throw new NotFoundError("HouseholdMember", householdId);
  await prisma.memberHouseholdMember.delete({ where: { id: householdId } });
  await audit(principal, {
    action: "member.household.remove",
    entityType: "MemberHouseholdMember",
    entityId: householdId,
    clubId: member.clubId,
    before: row,
  });
}

// -- Preferences (interests + notifications) -------------------------------
const flagFields = [
  "interestedGolf", "interestedDining", "interestedEvents", "interestedLeagues",
  "interestedPracticeFacilities", "wantsProShopOffers", "wantsTeeTimeAlerts",
  "emailStatements", "emailAccountAlerts", "emailEventAnnouncements", "emailGeneralAnnouncements",
  "smsPaymentAlerts", "smsTeeTimeAlerts",
] as const;
type FlagField = (typeof flagFields)[number];

export async function updatePreferences(principal: Principal, memberId: string, raw: Record<string, unknown>) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  ensureSelfOrAdmin(principal, member);

  const data: Partial<Record<FlagField, boolean>> = {};
  for (const f of flagFields) {
    if (f in raw) data[f] = Boolean(raw[f]);
  }
  const updated = await prisma.memberPreference.upsert({
    where: { memberId },
    create: { clubId: member.clubId, memberId, ...data },
    update: data,
  });
  await audit(principal, {
    action: "member.preferences.update",
    entityType: "MemberPreference",
    entityId: updated.id,
    clubId: member.clubId,
    after: data,
  });
  return updated;
}
