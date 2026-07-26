// Applicant / application service — Phase 2A productionized.
//
// Lifecycle: DRAFT -> SUBMITTED -> UNDER_REVIEW -> APPROVED/DENIED/WAITLISTED
//            with side branches PENDING_INFORMATION and WITHDRAWN.
//
// All transitions enforced by application-state.ts.

import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, requirePermission } from "../rbac";
import { tenantWhere, assertTenantOwned } from "./tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { env } from "../env";
import type { Principal } from "../rbac";
import { canTransition, requireTransition, type AppStatus } from "./application-state";
import { getRequestContext } from "../request-context";
import { ensureChecklistForMember } from "./onboarding";

// ---------- Zod schemas ----------------------------------------------------
const optStr = (max: number) => z.string().trim().max(max).optional().or(z.literal("")).transform((v) => (v && v.length ? v : null));

// Profile half (step 1) — minimum required to even save a draft.
export const applicationProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().email().max(254),
  phone: optStr(40),
  dateOfBirth: z.string().trim().max(20).optional().or(z.literal("")).transform((v) => v && v.length ? new Date(v) : null),
  address1: optStr(200),
  address2: optStr(200),
  city: optStr(100),
  provinceState: optStr(100),
  postalCode: optStr(20),
  country: optStr(80),
});

// Membership-detail half (step 2).
export const applicationMembershipSchema = z.object({
  sponsorName: optStr(120),
  membershipCategory: z.string().trim().max(80).optional().or(z.literal("")).transform((v) => v && v.length ? v : null),
  employmentInfo: optStr(2000),
  referralSource: optStr(200),
});

// Household line (step 3).
export const householdMemberSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  relationship: z.enum(["SPOUSE", "PARTNER", "CHILD", "OTHER"]),
  email: z.string().email().max(254).optional().or(z.literal("")).transform((v) => v && v.length ? v : null),
  phone: optStr(40),
  dateOfBirth: z.string().trim().max(20).optional().or(z.literal("")).transform((v) => v && v.length ? new Date(v) : null),
  notes: optStr(2000),
});

// Final-step consents.
export const applicationFinalSchema = z.object({
  consentCreditCheck: z.boolean(),
  consentBackgroundCheck: z.boolean(),
});

// ---------- Drafts: create, get, save, submit -------------------------------
//
// Token model: we generate a random 32-byte token, deliver the plaintext to
// the applicant ONCE (in the resume link / email — Phase 7 ships email), and
// store only the HMAC-SHA256 hash. Tokens expire in 30 days.

const TOKEN_TTL_DAYS = 30;
const TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return crypto.createHmac("sha256", env.SPECTRE_SESSION_SECRET).update(token).digest("hex");
}

export async function createDraft(clubId: string, raw: unknown): Promise<{ applicantId: string; token: string }> {
  const parsed = applicationProfileSchema.safeParse(raw);
  if (!parsed.success) throw zodError(parsed.error);
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) throw new NotFoundError("Club", clubId);

  const applicant = await prisma.applicant.create({
    data: {
      clubId,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      email: parsed.data.email.toLowerCase(),
      phone: parsed.data.phone,
      dateOfBirth: parsed.data.dateOfBirth,
      address1: parsed.data.address1,
      address2: parsed.data.address2,
      city: parsed.data.city,
      provinceState: parsed.data.provinceState,
      postalCode: parsed.data.postalCode,
      country: parsed.data.country,
      applicationStatus: "DRAFT",
    },
  });

  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  await prisma.applicationDraftToken.create({
    data: {
      clubId,
      applicantId: applicant.id,
      tokenHash: hashToken(token),
      email: applicant.email,
      expiresAt: new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });

  await audit(null, {
    action: "application.draft.create",
    entityType: "Applicant",
    entityId: applicant.id,
    clubId,
    after: applicant,
  });

  return { applicantId: applicant.id, token };
}

export async function getDraftByToken(clubId: string, token: string) {
  const row = await prisma.applicationDraftToken.findFirst({
    where: { clubId, tokenHash: hashToken(token) },
    include: {
      applicant: {
        include: { household: { orderBy: { createdAt: "asc" } }, documents: { orderBy: { uploadedAt: "asc" } } },
      },
    },
  });
  if (!row) return null;
  if (row.consumedAt) return null;
  if (row.expiresAt < new Date()) return null;
  if (row.applicant.applicationStatus !== "DRAFT" && row.applicant.applicationStatus !== "PENDING_INFORMATION") {
    return null;
  }
  return row;
}

export const draftPatchSchema = applicationProfileSchema.partial().merge(applicationMembershipSchema.partial());

export async function saveDraft(clubId: string, token: string, raw: unknown) {
  const row = await getDraftByToken(clubId, token);
  if (!row) throw new NotFoundError("Application draft");
  const parsed = draftPatchSchema.safeParse(raw);
  if (!parsed.success) throw zodError(parsed.error);
  const data = stripUndefined(parsed.data);
  const updated = await prisma.applicant.update({
    where: { id: row.applicantId },
    data,
  });
  await audit(null, {
    action: "application.draft.save",
    entityType: "Applicant",
    entityId: row.applicantId,
    clubId,
    before: row.applicant,
    after: updated,
  });
  return updated;
}

export async function addHouseholdMemberToDraft(clubId: string, token: string, raw: unknown) {
  const row = await getDraftByToken(clubId, token);
  if (!row) throw new NotFoundError("Application draft");
  const parsed = householdMemberSchema.safeParse(raw);
  if (!parsed.success) throw zodError(parsed.error);
  const created = await prisma.applicationHouseholdMember.create({
    data: { clubId, applicantId: row.applicantId, ...parsed.data },
  });
  await audit(null, {
    action: "application.household.add",
    entityType: "ApplicationHouseholdMember",
    entityId: created.id,
    clubId,
    after: created,
  });
  return created;
}

export async function removeHouseholdMemberFromDraft(clubId: string, token: string, memberId: string) {
  const row = await getDraftByToken(clubId, token);
  if (!row) throw new NotFoundError("Application draft");
  const found = await prisma.applicationHouseholdMember.findUnique({ where: { id: memberId } });
  if (!found || found.applicantId !== row.applicantId) throw new NotFoundError("ApplicationHouseholdMember", memberId);
  await prisma.applicationHouseholdMember.delete({ where: { id: memberId } });
  await audit(null, {
    action: "application.household.remove",
    entityType: "ApplicationHouseholdMember",
    entityId: memberId,
    clubId,
    before: found,
  });
}

// Document attachment via the public/draft path.
//
// We accept ONLY storage metadata here. The actual upload is done client-side
// directly to the storage adapter (signed-URL flow — Phase 7). This function
// records that the upload happened; the storageKey is opaque and cannot be
// guessed.
export const draftDocumentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  storageKey: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().min(1).max(100),
  sizeBytes: z.number().int().min(0).max(50_000_000), // 50 MB ceiling
});

export async function recordDraftDocument(clubId: string, token: string, raw: unknown) {
  const row = await getDraftByToken(clubId, token);
  if (!row) throw new NotFoundError("Application draft");
  const parsed = draftDocumentSchema.safeParse(raw);
  if (!parsed.success) throw zodError(parsed.error);
  const accessTokenSecret = crypto.randomBytes(16).toString("base64url");
  const created = await prisma.applicationDocument.create({
    data: { clubId, applicantId: row.applicantId, ...parsed.data, accessTokenSecret },
  });
  await audit(null, {
    action: "application.document.upload",
    entityType: "ApplicationDocument",
    entityId: created.id,
    clubId,
    after: { id: created.id, name: created.name, mimeType: created.mimeType, sizeBytes: created.sizeBytes },
  });
  return created;
}

// Final submit. Validates that all required fields are present and consents
// were given, then moves DRAFT -> SUBMITTED and consumes the token.
export async function submitDraft(clubId: string, token: string, raw: unknown) {
  const row = await getDraftByToken(clubId, token);
  if (!row) throw new NotFoundError("Application draft");
  const consents = applicationFinalSchema.safeParse(raw);
  if (!consents.success) throw zodError(consents.error);

  // Required-fields gate.
  const a = row.applicant;
  const required: Array<[string, unknown]> = [
    ["firstName", a.firstName], ["lastName", a.lastName], ["email", a.email],
    ["membershipCategory", a.membershipCategory],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new ValidationError(missing.map((k) => ({ path: k, message: "Required" })), "Please complete all required fields");
  }

  const { ip, userAgent } = getRequestContext();
  const now = new Date();

  const [updated] = await prisma.$transaction([
    prisma.applicant.update({
      where: { id: row.applicantId },
      data: {
        applicationStatus: "SUBMITTED",
        consentCreditCheck: consents.data.consentCreditCheck,
        consentBackgroundCheck: consents.data.consentBackgroundCheck,
        submittedAt: now,
        signedSubmissionIp: ip,
        signedSubmissionUa: userAgent,
      },
    }),
    prisma.applicationDraftToken.update({
      where: { id: row.id },
      data: { consumedAt: now },
    }),
  ]);

  await audit(null, {
    action: "application.submit",
    entityType: "Applicant",
    entityId: row.applicantId,
    clubId,
    before: a,
    after: updated,
    meta: { source: "draft_submit" },
  });

  return updated;
}

// Applicant-initiated withdrawal (any pre-approval state).
export async function withdrawDraft(clubId: string, token: string, reason?: string | null) {
  const row = await getDraftByToken(clubId, token);
  if (!row) throw new NotFoundError("Application draft");
  requireTransition(row.applicant.applicationStatus as AppStatus, "WITHDRAWN");
  const updated = await prisma.applicant.update({
    where: { id: row.applicantId },
    data: { applicationStatus: "WITHDRAWN", internalNotes: appendStamp(row.applicant.internalNotes, `[withdrawn by applicant] ${reason ?? ""}`.trim()) },
  });
  await audit(null, {
    action: "application.withdraw",
    entityType: "Applicant",
    entityId: row.applicantId,
    clubId,
    before: row.applicant,
    after: updated,
    meta: { reason },
  });
  return updated;
}

// ---------- Anonymous one-shot submit (kept for back-compat) ----------------
// Used by tests and the simple submit flow when no draft was created.
export const applicationCreateSchema = applicationProfileSchema
  .merge(applicationMembershipSchema)
  .merge(applicationFinalSchema);
export type ApplicationCreateInput = z.infer<typeof applicationCreateSchema>;

export async function submitApplication(clubId: string, raw: unknown) {
  const parsed = applicationCreateSchema.safeParse(raw);
  if (!parsed.success) throw zodError(parsed.error);
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club) throw new NotFoundError("Club", clubId);
  const { ip, userAgent } = getRequestContext();

  const applicant = await prisma.applicant.create({
    data: {
      clubId,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      email: parsed.data.email.toLowerCase(),
      phone: parsed.data.phone,
      sponsorName: parsed.data.sponsorName,
      membershipCategory: parsed.data.membershipCategory,
      employmentInfo: parsed.data.employmentInfo,
      consentCreditCheck: parsed.data.consentCreditCheck,
      consentBackgroundCheck: parsed.data.consentBackgroundCheck,
      applicationStatus: "SUBMITTED",
      submittedAt: new Date(),
      signedSubmissionIp: ip,
      signedSubmissionUa: userAgent,
    },
  });
  await audit(null, {
    action: "application.submit",
    entityType: "Applicant",
    entityId: applicant.id,
    clubId,
    after: applicant,
    meta: { source: "public_form" },
  });
  return applicant;
}

// ---------- Admin actions ---------------------------------------------------
export async function approveApplication(principal: Principal, applicantId: string) {
  const applicant = await prisma.applicant.findUnique({ where: { id: applicantId } });
  assertTenantOwned(applicant, principal);
  requirePermission(principal, applicant.clubId, "applications:review");
  if (applicant.applicationStatus === "APPROVED") {
    const existing = await prisma.member.findFirst({ where: { applicantId } });
    if (existing) return { applicant, member: existing };
  }
  requireTransition(applicant.applicationStatus as AppStatus, "APPROVED");

  const memberNumber = await nextMemberNumber(applicant.clubId);
  const { applicant: updatedApplicant, member } = await prisma.$transaction(async (tx) => {
    const updatedApplicant = await tx.applicant.update({
      where: { id: applicantId },
      data: { applicationStatus: "APPROVED", lastReviewedAt: new Date() },
    });
    const member = await tx.member.create({
      data: {
        clubId: applicant.clubId,
        applicantId: applicant.id,
        memberNumber,
        firstName: applicant.firstName,
        lastName: applicant.lastName,
        email: applicant.email,
        phone: applicant.phone,
        status: "ONBOARDING",
        joinDate: new Date(),
        membershipCategory: applicant.membershipCategory,
        paymentMethodStatus: "NONE",
        onboardingStartedAt: new Date(),
      },
    });
    await tx.memberAccount.create({ data: { clubId: applicant.clubId, memberId: member.id } });
    // Copy household into MemberHousehold so member-side edits are decoupled.
    const household = await tx.applicationHouseholdMember.findMany({ where: { applicantId: applicant.id } });
    for (const h of household) {
      await tx.memberHouseholdMember.create({
        data: {
          clubId: applicant.clubId,
          memberId: member.id,
          firstName: h.firstName,
          lastName: h.lastName,
          relationship: h.relationship,
          email: h.email,
          phone: h.phone,
          dateOfBirth: h.dateOfBirth,
        },
      });
    }
    return { applicant: updatedApplicant, member };
  });

  // Seed the onboarding checklist outside the transaction so a checklist
  // failure (e.g. a future club-config issue) doesn't block member creation.
  await ensureChecklistForMember(member.id);

  await audit(principal, {
    action: "application.approve",
    entityType: "Applicant",
    entityId: applicant.id,
    clubId: applicant.clubId,
    before: applicant,
    after: updatedApplicant,
    meta: { memberId: member.id, memberNumber: member.memberNumber },
  });
  return { applicant: updatedApplicant, member };
}

export async function denyApplication(principal: Principal, applicantId: string, reason?: string | null) {
  const applicant = await prisma.applicant.findUnique({ where: { id: applicantId } });
  assertTenantOwned(applicant, principal);
  requirePermission(principal, applicant.clubId, "applications:review");
  requireTransition(applicant.applicationStatus as AppStatus, "DENIED");

  const updated = await prisma.applicant.update({
    where: { id: applicantId },
    data: { applicationStatus: "DENIED", denialReason: reason ?? null, lastReviewedAt: new Date() },
  });
  await audit(principal, {
    action: "application.deny",
    entityType: "Applicant",
    entityId: applicant.id,
    clubId: applicant.clubId,
    before: applicant,
    after: updated,
    meta: { reason },
  });
  return updated;
}

export async function waitlistApplication(principal: Principal, applicantId: string, priority?: number) {
  const applicant = await prisma.applicant.findUnique({ where: { id: applicantId } });
  assertTenantOwned(applicant, principal);
  requirePermission(principal, applicant.clubId, "applications:review");
  requireTransition(applicant.applicationStatus as AppStatus, "WAITLISTED");

  const updated = await prisma.applicant.update({
    where: { id: applicantId },
    data: { applicationStatus: "WAITLISTED", waitlistPriority: priority ?? null, lastReviewedAt: new Date() },
  });
  await audit(principal, {
    action: "application.waitlist",
    entityType: "Applicant",
    entityId: applicant.id,
    clubId: applicant.clubId,
    before: applicant,
    after: updated,
    meta: { priority },
  });
  return updated;
}

export async function requestMoreInformation(principal: Principal, applicantId: string, note: string) {
  if (!note.trim()) throw new ValidationError([{ path: "note", message: "Note is required" }]);
  const applicant = await prisma.applicant.findUnique({ where: { id: applicantId } });
  assertTenantOwned(applicant, principal);
  requirePermission(principal, applicant.clubId, "applications:review");
  requireTransition(applicant.applicationStatus as AppStatus, "PENDING_INFORMATION");

  const updated = await prisma.applicant.update({
    where: { id: applicantId },
    data: {
      applicationStatus: "PENDING_INFORMATION",
      pendingInfoNote: note.trim(),
      lastReviewedAt: new Date(),
    },
  });
  await audit(principal, {
    action: "application.request_info",
    entityType: "Applicant",
    entityId: applicant.id,
    clubId: applicant.clubId,
    before: applicant,
    after: updated,
    meta: { note: note.trim() },
  });
  // FUTURE: send templated email with secure resume link to applicant.email
  return updated;
}

export async function moveUnderReview(principal: Principal, applicantId: string) {
  const applicant = await prisma.applicant.findUnique({ where: { id: applicantId } });
  assertTenantOwned(applicant, principal);
  requirePermission(principal, applicant.clubId, "applications:review");
  if (applicant.applicationStatus === "UNDER_REVIEW") return applicant;
  requireTransition(applicant.applicationStatus as AppStatus, "UNDER_REVIEW");
  const updated = await prisma.applicant.update({
    where: { id: applicantId },
    data: { applicationStatus: "UNDER_REVIEW", lastReviewedAt: new Date() },
  });
  await audit(principal, {
    action: "application.under_review",
    entityType: "Applicant",
    entityId: applicant.id,
    clubId: applicant.clubId,
    before: applicant,
    after: updated,
  });
  return updated;
}

export async function assignReviewer(principal: Principal, applicantId: string, userId: string | null) {
  const applicant = await prisma.applicant.findUnique({ where: { id: applicantId } });
  assertTenantOwned(applicant, principal);
  requirePermission(principal, applicant.clubId, "applications:assign");
  if (userId) {
    // Reviewer must be a user with access to this club.
    const reviewer = await prisma.user.findUnique({ where: { id: userId }, include: { clubRoles: true } });
    if (!reviewer) throw new NotFoundError("User", userId);
    const hasAccess = reviewer.clubRoles.some((r) => r.clubId === applicant.clubId || r.clubId === null);
    if (!hasAccess) throw new ConflictError("Reviewer must have access to this club");
  }
  const updated = await prisma.applicant.update({
    where: { id: applicantId },
    data: { reviewerId: userId },
  });
  await audit(principal, {
    action: "application.assign_reviewer",
    entityType: "Applicant",
    entityId: applicant.id,
    clubId: applicant.clubId,
    before: { reviewerId: applicant.reviewerId },
    after: { reviewerId: updated.reviewerId },
  });
  return updated;
}

export async function appendInternalNote(principal: Principal, applicantId: string, note: string) {
  const applicant = await prisma.applicant.findUnique({ where: { id: applicantId } });
  assertTenantOwned(applicant, principal);
  requirePermission(principal, applicant.clubId, "applications:review");
  const trimmed = note.trim();
  if (!trimmed) throw new ValidationError([{ path: "note", message: "Note cannot be empty" }]);

  const stamp = new Date().toISOString();
  const author = ` — ${principal.name}`;
  const next = (applicant.internalNotes ? applicant.internalNotes + "\n\n" : "") + `[${stamp}${author}] ${trimmed}`;
  const updated = await prisma.applicant.update({ where: { id: applicantId }, data: { internalNotes: next } });
  await audit(principal, {
    action: "application.note",
    entityType: "Applicant",
    entityId: applicant.id,
    clubId: applicant.clubId,
    meta: { note: trimmed },
  });
  return updated;
}

// ---------- Queries ---------------------------------------------------------
export async function listApplications(principal: Principal, clubId: string, status?: string) {
  const where = { ...tenantWhere(principal, clubId), ...(status ? { applicationStatus: status } : {}) };
  return prisma.applicant.findMany({ where, orderBy: { createdAt: "desc" }, include: { reviewer: true } });
}

// List candidate reviewers for the admin UI.
export async function listReviewers(principal: Principal, clubId: string) {
  if (!hasPermission(principal, clubId, "applications:assign")) return [];
  return prisma.user.findMany({
    where: {
      status: "ACTIVE",
      clubRoles: { some: { clubId } },
    },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });
}

// ---------- Helpers ---------------------------------------------------------
async function nextMemberNumber(clubId: string): Promise<string> {
  // Step 16 — plain 4-digit numbers, leading zeros preserved. Uniqueness
  // is enforced at the schema level by @@unique([clubId, memberNumber]),
  // so two different clubs can both have "2001". Within a club we pad
  // to 4 digits via the count + 2001 offset (matches the prior
  // SS-#### sequence's body).
  const count = await prisma.member.count({ where: { clubId } });
  return (2000 + count + 1).toString().padStart(4, "0");
}

function zodError(err: z.ZodError) {
  return new ValidationError(err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function appendStamp(existing: string | null | undefined, msg: string): string {
  const stamp = new Date().toISOString();
  return (existing ? existing + "\n\n" : "") + `[${stamp}] ${msg}`;
}
