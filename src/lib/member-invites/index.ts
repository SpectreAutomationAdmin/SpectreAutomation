// Phase 13D — Member portal invites.
//
// Productionizes onboarding for existing members imported from a legacy system.
// They don't go through the new-applicant flow — instead they receive a
// branded "activate your portal" email with a one-time token. Token states:
//
//   PENDING   — created but not yet sent (e.g. queued for bulk send)
//   SENT      — handed off to the email provider
//   OPENED    — token was clicked at least once
//   ACTIVATED — member set a password and signed in
//   EXPIRED   — token never used before expiresAt
//   FAILED    — email provider reported a hard bounce or similar
//
// Tokens are stored as sha256 hashes only; raw values are returned exactly
// once at creation. Bulk send is rate-limited per club to avoid being flagged
// as spam.

import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { isSuperAdmin, requirePermission, type Principal } from "../rbac";
import { ConflictError, NotFoundError, ValidationError } from "../errors";

const DEFAULT_TTL_DAYS = 30;
const BULK_BATCH_SIZE = 100;

function sha256(s: string): string { return createHash("sha256").update(s).digest("hex"); }

function ensureWrite(principal: Principal, clubId: string) {
  if (isSuperAdmin(principal)) return;
  requirePermission(principal, clubId, "users:invite");
}

// ---------------------------------------------------------------------------
// Create an invite for a single member
// ---------------------------------------------------------------------------
export const createInviteSchema = z.object({
  clubId: z.string(),
  memberId: z.string(),
  email: z.string().email().optional(),
  ttlDays: z.number().int().min(1).max(180).optional(),
});

export async function createInvite(principal: Principal, raw: unknown) {
  const parsed = createInviteSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  ensureWrite(principal, parsed.data.clubId);
  const member = await prisma.member.findUnique({ where: { id: parsed.data.memberId } });
  if (!member || member.clubId !== parsed.data.clubId) throw new NotFoundError("Member", parsed.data.memberId);
  const email = (parsed.data.email ?? member.email).trim().toLowerCase();
  if (!email || !email.includes("@")) throw new ValidationError([{ path: "email", message: "Valid email is required" }]);
  // Phase 14D — never send to a suppressed address.
  const { isSuppressed } = await import("../email-delivery");
  const suppressed = await isSuppressed(email, parsed.data.clubId);
  if (suppressed.suppressed) {
    throw new ConflictError(`Cannot invite ${email} — address is on the suppression list (${suppressed.reason})`);
  }
  // Mark any prior pending invites as expired.
  await prisma.memberPortalInvite.updateMany({
    where: { memberId: member.id, status: { in: ["PENDING", "SENT", "OPENED"] } },
    data: { status: "EXPIRED" },
  });
  const ttl = (parsed.data.ttlDays ?? DEFAULT_TTL_DAYS) * 86400_000;
  const rawToken = randomBytes(32).toString("base64url");
  const invite = await prisma.memberPortalInvite.create({
    data: {
      clubId: parsed.data.clubId, memberId: member.id, email,
      tokenHash: sha256(rawToken),
      status: "PENDING",
      expiresAt: new Date(Date.now() + ttl),
      createdByUserId: principal.id,
    },
  });
  await audit(principal, { action: "member.invite.create", entityType: "MemberPortalInvite", entityId: invite.id, clubId: parsed.data.clubId, after: { memberId: member.id, email } });
  return { invite, token: rawToken };
}

// ---------------------------------------------------------------------------
// Preview the email body before sending
// ---------------------------------------------------------------------------
export function buildInviteEmail(args: { memberName: string; clubName: string; activationUrl: string }) {
  return {
    subject: `Welcome to ${args.clubName} — activate your member portal`,
    body: [
      `Dear ${args.memberName},`,
      ``,
      `As a valued member of ${args.clubName}, you now have access to your private member portal.`,
      `Sign in to view your account, statements, and event registrations.`,
      ``,
      `Activate your portal:`,
      args.activationUrl,
      ``,
      `If you did not expect this email, you can ignore it — the link will expire automatically.`,
      ``,
      `Warm regards,`,
      args.clubName,
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Mark as sent (called by the queue / mail adapter after handoff)
// ---------------------------------------------------------------------------
export async function markSent(inviteId: string, lastError?: string | null) {
  const invite = await prisma.memberPortalInvite.findUnique({ where: { id: inviteId } });
  if (!invite) throw new NotFoundError("MemberPortalInvite", inviteId);
  return prisma.memberPortalInvite.update({
    where: { id: inviteId },
    data: {
      status: lastError ? "FAILED" : "SENT",
      sentAt: lastError ? invite.sentAt : new Date(),
      sendCount: { increment: 1 },
      lastError: lastError ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Bulk send — create invites for all members in a club without an active one
// ---------------------------------------------------------------------------
export const bulkInviteSchema = z.object({
  clubId: z.string(),
  memberIds: z.array(z.string()).optional(), // if omitted, all ACTIVE members
  ttlDays: z.number().int().min(1).max(180).optional(),
});

export async function bulkCreateInvites(principal: Principal, raw: unknown) {
  const parsed = bulkInviteSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  ensureWrite(principal, parsed.data.clubId);
  const whereClause = parsed.data.memberIds
    ? { clubId: parsed.data.clubId, id: { in: parsed.data.memberIds } }
    : { clubId: parsed.data.clubId, status: "ACTIVE" };
  const members = await prisma.member.findMany({ where: whereClause, take: BULK_BATCH_SIZE });
  const results: Array<{ memberId: string; status: "CREATED" | "SKIPPED"; reason?: string; token?: string }> = [];
  for (const m of members) {
    if (!m.email) { results.push({ memberId: m.id, status: "SKIPPED", reason: "no email" }); continue; }
    const existing = await prisma.memberPortalInvite.findFirst({
      where: { memberId: m.id, status: { in: ["PENDING", "SENT", "OPENED"] } },
    });
    if (existing) { results.push({ memberId: m.id, status: "SKIPPED", reason: "already invited" }); continue; }
    const { token } = await createInvite(principal, { clubId: parsed.data.clubId, memberId: m.id, ttlDays: parsed.data.ttlDays });
    results.push({ memberId: m.id, status: "CREATED", token });
  }
  await audit(principal, { action: "member.invite.bulk", entityType: "MemberPortalInvite", entityId: null, clubId: parsed.data.clubId, after: { created: results.filter((r) => r.status === "CREATED").length, skipped: results.filter((r) => r.status === "SKIPPED").length } });
  return results;
}

// ---------------------------------------------------------------------------
// Activation — the member clicks the link, sets a password
// ---------------------------------------------------------------------------
export const activateSchema = z.object({
  token: z.string().min(10),
  newPassword: z.string().min(8).max(200),
});

export async function activateInvite(raw: unknown, args?: { ip?: string; userAgent?: string }) {
  const parsed = activateSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const invite = await prisma.memberPortalInvite.findUnique({ where: { tokenHash: sha256(parsed.data.token) } });
  if (!invite) throw new NotFoundError("MemberPortalInvite", "token");
  if (invite.status === "ACTIVATED") throw new ConflictError("Invite already activated");
  if (invite.status === "EXPIRED" || invite.expiresAt.getTime() < Date.now()) {
    await prisma.memberPortalInvite.update({ where: { id: invite.id }, data: { status: "EXPIRED" } });
    throw new ConflictError("Invite has expired");
  }
  // Find the linked Member; create or attach a User with role MEMBER.
  const member = await prisma.member.findUnique({ where: { id: invite.memberId } });
  if (!member) throw new NotFoundError("Member", invite.memberId);
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  const user = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email: invite.email } });
    if (existing) {
      const updated = await tx.user.update({
        where: { id: existing.id },
        data: { passwordHash, status: "ACTIVE", memberId: member.id },
      });
      await tx.userClubRole.upsert({
        where: { userId_clubId_roleKey: { userId: existing.id, clubId: invite.clubId, roleKey: "MEMBER" } },
        update: {},
        create: { userId: existing.id, clubId: invite.clubId, roleKey: "MEMBER" },
      });
      return updated;
    }
    const u = await tx.user.create({
      data: {
        email: invite.email,
        name: `${member.firstName} ${member.lastName}`,
        role: "MEMBER",
        passwordHash,
        status: "ACTIVE",
        clubId: invite.clubId,
        memberId: member.id,
      },
    });
    await tx.userClubRole.create({ data: { userId: u.id, clubId: invite.clubId, roleKey: "MEMBER" } });
    return u;
  });
  const activated = await prisma.memberPortalInvite.update({
    where: { id: invite.id },
    data: { status: "ACTIVATED", activatedAt: new Date(), openedAt: invite.openedAt ?? new Date() },
  });
  return { invite: activated, user, ip: args?.ip, userAgent: args?.userAgent };
}

// ---------------------------------------------------------------------------
// Track opens (token clicked, hasn't activated yet)
// ---------------------------------------------------------------------------
export async function markOpened(token: string) {
  const invite = await prisma.memberPortalInvite.findUnique({ where: { tokenHash: sha256(token) } });
  if (!invite) return null;
  if (invite.status === "PENDING" || invite.status === "SENT") {
    return prisma.memberPortalInvite.update({
      where: { id: invite.id },
      data: { status: "OPENED", openedAt: new Date() },
    });
  }
  return invite;
}

// ---------------------------------------------------------------------------
// Resend — invalidate the old token and issue a fresh one
// ---------------------------------------------------------------------------
export async function resendInvite(principal: Principal, inviteId: string) {
  const invite = await prisma.memberPortalInvite.findUnique({ where: { id: inviteId } });
  if (!invite) throw new NotFoundError("MemberPortalInvite", inviteId);
  ensureWrite(principal, invite.clubId);
  if (invite.status === "ACTIVATED") throw new ConflictError("Invite already activated");
  const { token } = await createInvite(principal, { clubId: invite.clubId, memberId: invite.memberId, email: invite.email });
  return { token };
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------
export async function listInvites(principal: Principal, clubId: string, filter?: { status?: string }) {
  ensureWrite(principal, clubId);
  return prisma.memberPortalInvite.findMany({
    where: { clubId, ...(filter?.status ? { status: filter.status } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export async function inviteStats(principal: Principal, clubId: string) {
  ensureWrite(principal, clubId);
  const all = await prisma.memberPortalInvite.groupBy({
    by: ["status"],
    where: { clubId },
    _count: true,
  });
  return Object.fromEntries(all.map((r) => [r.status, r._count]));
}
