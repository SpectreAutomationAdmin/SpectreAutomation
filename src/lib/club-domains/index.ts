// Club domain administration.
//
// Manages the ClubDomain table — the source of truth for which hostnames
// route to which club. Lifecycle:
//
//   PENDING  → addDomain(): row inserted, verification token generated
//   VERIFIED → verifyDomain(): we (manually, or via future DNS probe) confirm
//              the DNS TXT/CNAME points to Spectre. Hostname is reserved but
//              not yet receiving traffic.
//   ACTIVE   → activateDomain(): host is live. resolveClubByHost will match it.
//   FAILED   → markFailed(): explicit error trail.
//
// Only ACTIVE domains route traffic. Inactive ones are reserved against
// hijacking but invisible to resolveClubByHost.
//
// SUPER_ADMIN can manage domains for any club; CLUB_ADMIN can only manage
// their own club's domains.

import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { isSuperAdmin, requirePermission, type Principal } from "../rbac";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { assertSensitiveActionAllowed } from "../posting-guard";

export const DOMAIN_KINDS = ["PRIMARY", "ADMIN", "MEMBER", "PROSHOP", "APP"] as const;
export type DomainKind = (typeof DOMAIN_KINDS)[number];

const HOSTNAME_REGEX = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function normalize(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function generateVerificationToken(): string {
  return `spectre-verify-${randomBytes(16).toString("hex")}`;
}

function ensureCanManage(principal: Principal, clubId: string) {
  if (isSuperAdmin(principal)) return;
  requirePermission(principal, clubId, "settings:write");
}

// ---------------------------------------------------------------------------
// Add a domain. Returns the verification token the operator must place at
// `_spectre-verify.<hostname>` as a TXT record (or a CNAME — verification
// implementation deliberately deferred to ops tooling).
// ---------------------------------------------------------------------------
export const addDomainSchema = z.object({
  clubId: z.string(),
  hostname: z.string().min(3).max(253),
  kind: z.enum(DOMAIN_KINDS).default("PRIMARY"),
  isPrimary: z.boolean().optional(),
});

export async function addDomain(principal: Principal, raw: unknown) {
  const parsed = addDomainSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  ensureCanManage(principal, parsed.data.clubId);
  await assertSensitiveActionAllowed(principal, parsed.data.clubId, "club.domain.add", "ClubDomain");
  const hostname = normalize(parsed.data.hostname);
  if (!HOSTNAME_REGEX.test(hostname)) {
    throw new ValidationError([{ path: "hostname", message: "Not a valid hostname" }]);
  }
  const existing = await prisma.clubDomain.findUnique({ where: { hostname } });
  if (existing) throw new ConflictError(`Domain ${hostname} is already registered`);
  // Sanity: forbid the platform host. Otherwise a CLUB_ADMIN could claim it.
  const { env } = await import("../env");
  if (env.SPECTRE_PLATFORM_HOST && hostname === env.SPECTRE_PLATFORM_HOST.toLowerCase()) {
    throw new ConflictError("Cannot register the Spectre platform host as a club domain");
  }
  const domain = await prisma.clubDomain.create({
    data: {
      clubId: parsed.data.clubId,
      hostname,
      kind: parsed.data.kind,
      status: "PENDING",
      verificationToken: generateVerificationToken(),
      isPrimary: parsed.data.isPrimary ?? false,
      createdByUserId: principal.id,
    },
  });
  await audit(principal, { action: "club.domain.add", entityType: "ClubDomain", entityId: domain.id, clubId: parsed.data.clubId, after: { hostname, kind: domain.kind } });
  return domain;
}

// ---------------------------------------------------------------------------
// Verify — mark DNS confirmed. Caller is operator tooling; we don't do the
// DNS lookup here (DNS in middleware is heavy, and ops teams may use third-
// party verification services). The verification token is the secret the
// operator must place at the configured DNS record.
//
// In Phase 16+ we can add a `probeDomain()` helper that does an actual
// `dns.resolveTxt()` call from a background worker.
// ---------------------------------------------------------------------------
export async function verifyDomain(principal: Principal, domainId: string) {
  const domain = await prisma.clubDomain.findUnique({ where: { id: domainId } });
  if (!domain) throw new NotFoundError("ClubDomain", domainId);
  ensureCanManage(principal, domain.clubId);
  await assertSensitiveActionAllowed(principal, domain.clubId, "club.domain.verify", "ClubDomain", domainId);
  if (domain.status !== "PENDING") {
    throw new ConflictError(`Cannot verify a domain in status ${domain.status}`);
  }
  const updated = await prisma.clubDomain.update({
    where: { id: domain.id },
    data: { status: "VERIFIED", verifiedAt: new Date(), failureReason: null },
  });
  await audit(principal, { action: "club.domain.verify", entityType: "ClubDomain", entityId: domain.id, clubId: domain.clubId });
  return updated;
}

// ---------------------------------------------------------------------------
// Activate — start receiving traffic. ACTIVE is what resolveClubByHost
// matches against.
// ---------------------------------------------------------------------------
export async function activateDomain(principal: Principal, domainId: string) {
  const domain = await prisma.clubDomain.findUnique({ where: { id: domainId } });
  if (!domain) throw new NotFoundError("ClubDomain", domainId);
  ensureCanManage(principal, domain.clubId);
  await assertSensitiveActionAllowed(principal, domain.clubId, "club.domain.activate", "ClubDomain", domainId);
  if (domain.status !== "VERIFIED") {
    throw new ConflictError(`Cannot activate a domain in status ${domain.status} — verify first`);
  }
  const updated = await prisma.clubDomain.update({
    where: { id: domain.id },
    data: { status: "ACTIVE", activatedAt: new Date() },
  });
  await audit(principal, { action: "club.domain.activate", entityType: "ClubDomain", entityId: domain.id, clubId: domain.clubId });
  return updated;
}

// ---------------------------------------------------------------------------
// Deactivate — back to VERIFIED so the host stops routing without losing
// the verification record.
// ---------------------------------------------------------------------------
export async function deactivateDomain(principal: Principal, domainId: string, reason?: string) {
  const domain = await prisma.clubDomain.findUnique({ where: { id: domainId } });
  if (!domain) throw new NotFoundError("ClubDomain", domainId);
  ensureCanManage(principal, domain.clubId);
  await assertSensitiveActionAllowed(principal, domain.clubId, "club.domain.deactivate", "ClubDomain", domainId);
  if (domain.status !== "ACTIVE") {
    throw new ConflictError(`Domain is ${domain.status}; only ACTIVE domains can be deactivated`);
  }
  const updated = await prisma.clubDomain.update({
    where: { id: domain.id },
    data: { status: "VERIFIED", failureReason: reason ?? null },
  });
  await audit(principal, { action: "club.domain.deactivate", entityType: "ClubDomain", entityId: domain.id, clubId: domain.clubId, after: { reason } });
  return updated;
}

export async function markFailed(principal: Principal, domainId: string, reason: string) {
  const domain = await prisma.clubDomain.findUnique({ where: { id: domainId } });
  if (!domain) throw new NotFoundError("ClubDomain", domainId);
  ensureCanManage(principal, domain.clubId);
  const updated = await prisma.clubDomain.update({
    where: { id: domain.id },
    data: { status: "FAILED", failureReason: reason },
  });
  await audit(principal, { action: "club.domain.fail", entityType: "ClubDomain", entityId: domain.id, clubId: domain.clubId, after: { reason } });
  return updated;
}

// ---------------------------------------------------------------------------
// Remove — soft is fine since hostname is unique. Hard delete only when the
// row is PENDING or FAILED (so we don't lose audit context for an active host).
// ---------------------------------------------------------------------------
export async function removeDomain(principal: Principal, domainId: string) {
  const domain = await prisma.clubDomain.findUnique({ where: { id: domainId } });
  if (!domain) throw new NotFoundError("ClubDomain", domainId);
  ensureCanManage(principal, domain.clubId);
  if (domain.status === "ACTIVE") {
    throw new ConflictError("Deactivate the domain before removing it");
  }
  await prisma.clubDomain.delete({ where: { id: domain.id } });
  await audit(principal, { action: "club.domain.remove", entityType: "ClubDomain", entityId: domain.id, clubId: domain.clubId, after: { hostname: domain.hostname } });
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------
export async function listDomains(principal: Principal, args: { clubId?: string }) {
  if (args.clubId) {
    ensureCanManage(principal, args.clubId);
    return prisma.clubDomain.findMany({ where: { clubId: args.clubId }, orderBy: [{ status: "asc" }, { hostname: "asc" }] });
  }
  if (!isSuperAdmin(principal)) {
    throw new ForbiddenError("Cross-club domain list is SUPER_ADMIN only");
  }
  return prisma.clubDomain.findMany({
    orderBy: [{ status: "asc" }, { hostname: "asc" }],
    include: { club: { select: { id: true, name: true, slug: true } } },
  });
}

// Helper used by the verification UI — shows the operator exactly what to
// place in DNS.
export function dnsInstructions(domain: { hostname: string; verificationToken: string }) {
  return {
    txtRecord: { name: `_spectre-verify.${domain.hostname}`, type: "TXT", value: domain.verificationToken },
    cnameRecord: { name: domain.hostname, type: "CNAME", value: "platform.spectre.cloud" },
    note: "Place the TXT record first, click Verify, then update the CNAME and click Activate. Both records can co-exist indefinitely.",
  };
}

// SHA256 helper for any future signed-callback verification path.
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
