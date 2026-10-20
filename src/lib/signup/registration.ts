// SIGNUP-1 (2026-10-19) — Registration lifecycle service.
//
// Responsibilities:
//   • createRegistration({...identity})  — Screen 1 submit.
//   • resolveRegistrationByToken(token)  — resume + status endpoints.
//   • rotateResumeToken(registrationId) — SIGNUP-1F: called by the
//     /signup/r/<recoveryToken> consume route so the clicking browser
//     establishes a fresh session.  Email recovery credentials now
//     live in the dedicated SignupRecoveryLink table (short-lived,
//     single-use, revocable).  See src/lib/signup/recovery-link.ts.
//   • transitionStep / markStatus / markExpired / markCompleted.
//
// Security invariants:
//   • The DB id (cuid) is NEVER embedded in any URL or returned to the
//     browser as a routing identifier.  Only opaque tokens (and their
//     sha-256 hashes) are the credential surface.
//   • Every public lookup is by sha-256(token) against resumeTokenHash
//     OR emailResumeTokenHash — a leaked DB id alone grants no access.
//   • Zero writes to User / Club / UserClubRole / ClubSubscription.
//     Those tables are strictly SIGNUP-2 / SIGNUP-3 territory.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AppError, ValidationError } from "@/lib/errors";
import { generateOpaqueToken, sha256HashHex } from "@/lib/auth/pkce";
import { normalizeOrgName } from "@/lib/signup/org-verification";
import { logger } from "@/lib/observability/logger";

// --- CA-only launch; data model is country-agnostic ----------------------
export const SUPPORTED_COUNTRIES = ["CA"] as const;
export type SupportedCountry = (typeof SUPPORTED_COUNTRIES)[number];
export const CA_PROVINCES = [
  "AB", "BC", "MB", "NB", "NL", "NS", "ON", "PE", "QC", "SK", "NT", "NU", "YT",
] as const;

// SIGNUP-1 lifecycle values.  Match the schema's defaults.
export const SIGNUP_STEPS = ["IDENTITY", "ADMIN_PENDING", "ADMIN_VERIFIED", "PAYMENT_PENDING"] as const;
export type SignupStep = (typeof SIGNUP_STEPS)[number];
export const SIGNUP_STATUSES = ["DRAFT", "VERIFIED", "ABANDONED", "ESCALATED"] as const;
export type SignupStatus = (typeof SIGNUP_STATUSES)[number];

// Default TTL — a registration that goes untouched for 7 days is swept
// to ABANDONED.
const REGISTRATION_TTL_MS = Number(
  process.env.SIGNUP_REGISTRATION_TTL_MS ?? String(7 * 24 * 60 * 60 * 1000),
);

// Email-delivered resume token TTL — 72 h.  Short enough that a leaked
// email link is time-boxed; long enough that a founder who checks email
// the next day can resume.
const EMAIL_RESUME_TOKEN_TTL_MS = Number(
  process.env.SIGNUP_EMAIL_RESUME_TTL_MS ?? String(72 * 60 * 60 * 1000),
);

// --- Validation ----------------------------------------------------------

export const createRegistrationInputSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  operatingName: z.string().trim().min(2).max(200).optional().or(z.literal("")),
  country: z.enum(SUPPORTED_COUNTRIES),
  provinceState: z.string().trim().min(2).max(60),
  addressLine1: z.string().trim().min(2).max(200),
  addressLine2: z.string().trim().max(200).optional().or(z.literal("")),
  city: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(3).max(20),
  websiteUrl: z.string().trim().url().max(300).optional().or(z.literal("")),
});
export type CreateRegistrationInput = z.infer<typeof createRegistrationInputSchema>;

/** Province validation — CA scope only on launch.  Future expansion
 *  swaps this for a country→provinces map. */
function validateProvince(country: SupportedCountry, provinceState: string): string {
  if (country !== "CA") {
    throw new ValidationError(
      [{ path: "country", message: "Only Canadian clubs are supported during launch." }],
    );
  }
  const upper = provinceState.toUpperCase();
  if (!CA_PROVINCES.some((p) => p === upper)) {
    throw new ValidationError(
      [{ path: "provinceState", message: "Please select a Canadian province or territory." }],
    );
  }
  return upper;
}

/**
 * createRegistration — Screen 1 submit.  Returns the plaintext resume
 * token so the caller can set the HTTPOnly cookie AND redirect the
 * browser to /signup/t/<token>.  The DB stores only the sha-256 hash.
 */
export async function createRegistration(args: {
  input: unknown;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ registrationId: string; resumeToken: string }> {
  const parsed = createRegistrationInputSchema.safeParse(args.input);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const data = parsed.data;
  const province = validateProvince(data.country, data.provinceState);
  const resumeToken = generateOpaqueToken(32);
  const resumeTokenHash = sha256HashHex(resumeToken);
  const now = new Date();
  const registration = await prisma.signupRegistration.create({
    data: {
      resumeTokenHash,
      legalName: data.legalName,
      legalNameNormalized: normalizeOrgName(data.legalName),
      operatingName: data.operatingName || null,
      operatingNameNormalized: data.operatingName ? normalizeOrgName(data.operatingName) : null,
      country: data.country,
      provinceState: province,
      addressLine1: data.addressLine1,
      addressLine2: data.addressLine2 || null,
      city: data.city,
      postalCode: data.postalCode,
      websiteUrl: data.websiteUrl || null,
      step: "IDENTITY",
      status: "DRAFT",
      ownershipVerificationState: "NOT_STARTED",
      startedByIp: args.ip,
      startedUserAgent: args.userAgent,
      expiresAt: new Date(now.getTime() + REGISTRATION_TTL_MS),
    },
    select: { id: true },
  });
  logger.info("signup.registration.created", {
    registrationIdTail: registration.id.slice(-6),
    country: data.country,
    provinceState: province,
  });
  return { registrationId: registration.id, resumeToken };
}

/**
 * Resolve a registration by an opaque resume token.  Accepts the
 * plaintext token (not the hash); handles both the pre-verify
 * resumeToken AND the post-verify emailResumeToken.
 *
 * Returns null if no matching registration OR if the token is expired.
 * NEVER returns a different registration on token mismatch; NEVER
 * exposes which of the two token slots matched (both are opaque
 * credentials of equal strength from the caller's perspective).
 */
export async function resolveRegistrationByToken(token: string): Promise<ResolvedRegistration | null> {
  if (!token || typeof token !== "string" || token.length < 20 || token.length > 200) {
    return null;
  }
  const hash = sha256HashHex(token);
  // Try both token slots in a single query; the unique indexes make
  // the lookup O(1).
  const reg = await prisma.signupRegistration.findFirst({
    where: {
      OR: [
        { resumeTokenHash: hash },
        { emailResumeTokenHash: hash },
      ],
    },
    select: SELECT_FIELDS,
  });
  if (!reg) return null;
  // SIGNUP-1G (2026-10-20) — the 7-day registration TTL only applies
  // to DRAFT.  Once Microsoft identity is captured (status transitions
  // out of DRAFT: VERIFIED / ESCALATED), the registration is "important
  // information" and must remain recoverable indefinitely until
  // SIGNUP-2 either activates or operator-rejects it.  The sweeper
  // already respects this (only sweeps DRAFT rows); this resolver
  // branch previously filtered them out at read time, which was a
  // silent-loss bug relative to the founder's lifecycle directive.
  if (reg.status === "DRAFT" && reg.expiresAt.getTime() < Date.now()) return null;
  if (reg.status === "ABANDONED") return null;
  // Email-token-level TTL compat (pre-SIGNUP-1F emails only).
  // Recovery tokens for SIGNUP-1F+ live in SignupRecoveryLink
  // (30-min TTL) consumed via /signup/r/<token>, not here.
  if (reg.emailResumeTokenHash === hash && reg.emailResumeTokenExpiresAt) {
    if (reg.emailResumeTokenExpiresAt.getTime() < Date.now()) return null;
  }
  return reg as ResolvedRegistration;
}

/**
 * SIGNUP-1F (2026-10-20) — Rotate the persistent browser-session
 * resumeToken.  Called by the recovery-link consume path so the
 * clicking browser receives a fresh HTTPOnly cookie after consuming
 * an email recovery link on a new device.
 *
 * The old browser's cookie becomes stale after this call; the old
 * browser can recover with a fresh email link via /signup/resume.
 * This is intentional — recovery links are the authoritative
 * cross-device credential surface.
 *
 * Returns the plaintext resume token so the caller can set the
 * HTTPOnly cookie + redirect to /signup/t/<token>/status.
 */
export async function rotateResumeToken(registrationId: string): Promise<string> {
  const token = generateOpaqueToken(32);
  const hash = sha256HashHex(token);
  await prisma.signupRegistration.update({
    where: { id: registrationId },
    data: { resumeTokenHash: hash },
  });
  logger.info("signup.resume_token.rotated", {
    registrationIdTail: registrationId.slice(-6),
  });
  return token;
}

/** Transition `step` + `status` atomically.  Validated against the
 *  allowed values; no raw-string state writes anywhere else. */
export async function transitionStep(
  registrationId: string,
  next: { step: SignupStep; status?: SignupStatus },
): Promise<void> {
  await prisma.signupRegistration.update({
    where: { id: registrationId },
    data: {
      step: next.step,
      ...(next.status ? { status: next.status } : {}),
      ...(next.step === "ADMIN_VERIFIED" ? { completedAt: new Date() } : {}),
    },
  });
}

/** Mark a registration VERIFIED after the Microsoft callback + admin
 *  position have been captured. */
export async function markVerified(args: {
  registrationId: string;
  adminEmail: string;
  adminMicrosoftOid: string;
  adminMicrosoftTenantId: string;
  adminDisplayName: string | null;
  adminGivenName: string | null;
  adminSurname: string | null;
  adminPosition: string | null;
}): Promise<void> {
  await prisma.signupRegistration.update({
    where: { id: args.registrationId },
    data: {
      adminEmail: args.adminEmail,
      adminMicrosoftOid: args.adminMicrosoftOid,
      adminMicrosoftTenantId: args.adminMicrosoftTenantId,
      adminDisplayName: args.adminDisplayName,
      adminGivenName: args.adminGivenName,
      adminSurname: args.adminSurname,
      adminPosition: args.adminPosition,
      adminVerifiedAt: new Date(),
      step: "ADMIN_VERIFIED",
      status: "VERIFIED",
      completedAt: new Date(),
    },
  });
}

// --- Projection ----------------------------------------------------------

const SELECT_FIELDS = {
  id: true,
  legalName: true,
  operatingName: true,
  country: true,
  provinceState: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  postalCode: true,
  websiteUrl: true,
  adminEmail: true,
  adminMicrosoftOid: true,
  adminMicrosoftTenantId: true,
  adminDisplayName: true,
  adminGivenName: true,
  adminSurname: true,
  adminPosition: true,
  adminVerifiedAt: true,
  step: true,
  status: true,
  ownershipVerificationState: true,
  ownershipAutomatedCheckJson: true,
  ownershipNote: true,
  expiresAt: true,
  emailResumeTokenHash: true,
  emailResumeTokenExpiresAt: true,
  completedAt: true,
  createdAt: true,
} as const;

export type ResolvedRegistration = {
  id: string;
  legalName: string;
  operatingName: string | null;
  country: string;
  provinceState: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  postalCode: string;
  websiteUrl: string | null;
  adminEmail: string | null;
  adminMicrosoftOid: string | null;
  adminMicrosoftTenantId: string | null;
  adminDisplayName: string | null;
  adminGivenName: string | null;
  adminSurname: string | null;
  adminPosition: string | null;
  adminVerifiedAt: Date | null;
  step: string;
  status: string;
  ownershipVerificationState: string;
  ownershipAutomatedCheckJson: string | null;
  ownershipNote: string | null;
  expiresAt: Date;
  emailResumeTokenHash: string | null;
  emailResumeTokenExpiresAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

/** Expose a thin lookup used by test diagnostics only.  Never call
 *  from a route handler — routes must go through
 *  resolveRegistrationByToken. */
export async function _unsafe_findById(id: string): Promise<ResolvedRegistration | null> {
  const reg = await prisma.signupRegistration.findUnique({
    where: { id },
    select: SELECT_FIELDS,
  });
  return reg as ResolvedRegistration | null;
}

export function assertNotProvisioningTenant(context: string): void {
  // SIGNUP-1 invariant — no production tenant writes.  Called at the
  // top of any service that could be tempted to touch Club or User.
  // Kept as a compile-time + runtime reminder.
  if (process.env.SIGNUP_ENFORCE_NO_PROVISIONING === "disabled") {
    throw new AppError(
      "SIGNUP_INVARIANT",
      "SIGNUP_ENFORCE_NO_PROVISIONING=disabled is forbidden; tenant provisioning belongs to SIGNUP-3",
      500,
    );
  }
  void context;
}
