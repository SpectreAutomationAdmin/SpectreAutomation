// Phase 11G — SSO provider scaffolding.
//
// Two flavors:
//   - OIDC: code-flow against Google Workspace / Azure AD / Okta / Auth0.
//           The actual exchange uses the standard openid-connect endpoints;
//           we keep the live exchange optional-imported (`openid-client`).
//   - SAML: scaffold only — recipients exchange via /api/auth/sso/{providerId}/acs
//           with a signed assertion. The real verification path is dynamic-
//           imported (`@node-saml/node-saml`).
//
// Logins always go through `findOrProvisionUser()` so just-in-time user
// creation happens with the provider's `defaultRoleKey`.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import type { RoleKey } from "../permissions";
import { ConflictError, ValidationError } from "../errors";
import { hashPassword } from "../services/auth";
import { randomBytes } from "crypto";

export const ssoProviderSchema = z.object({
  kind: z.enum(["OIDC", "SAML"]),
  name: z.string().trim().min(1).max(120),
  issuer: z.string().url().optional().nullable(),
  clientId: z.string().optional().nullable(),
  clientSecret: z.string().optional().nullable(),
  acsUrl: z.string().url().optional().nullable(),
  entityId: z.string().optional().nullable(),
  certificate: z.string().optional().nullable(),
  emailDomain: z.string().trim().optional().nullable(),
  defaultRoleKey: z.string().default("STAFF"),
});

export async function upsertProvider(principal: Principal, clubId: string, raw: unknown) {
  requirePermission(principal, clubId, "settings:write");
  const parsed = ssoProviderSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const d = parsed.data;
  const provider = await prisma.ssoProvider.upsert({
    where: { clubId_kind: { clubId, kind: d.kind } },
    update: {
      name: d.name, issuer: d.issuer ?? null,
      clientId: d.clientId ?? null, clientSecret: d.clientSecret ?? null,
      acsUrl: d.acsUrl ?? null, entityId: d.entityId ?? null, certificate: d.certificate ?? null,
      emailDomain: d.emailDomain ?? null, defaultRoleKey: d.defaultRoleKey,
      status: "ACTIVE",
    },
    create: {
      clubId, kind: d.kind, name: d.name, issuer: d.issuer ?? null,
      clientId: d.clientId ?? null, clientSecret: d.clientSecret ?? null,
      acsUrl: d.acsUrl ?? null, entityId: d.entityId ?? null, certificate: d.certificate ?? null,
      emailDomain: d.emailDomain ?? null, defaultRoleKey: d.defaultRoleKey,
    },
  });
  await audit(principal, { action: "sso.provider.upsert", entityType: "SsoProvider", entityId: provider.id, clubId, after: { kind: d.kind, name: d.name } });
  // Mask secrets in the return value.
  return { ...provider, clientSecret: provider.clientSecret ? "***" : null, certificate: provider.certificate ? "(present)" : null };
}

export async function listProviders(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "settings:read");
  const rows = await prisma.ssoProvider.findMany({ where: { clubId }, orderBy: { name: "asc" } });
  return rows.map((r) => ({ ...r, clientSecret: r.clientSecret ? "***" : null, certificate: r.certificate ? "(present)" : null }));
}

// ---------------------------------------------------------------------------
// Provider invocation — find-or-provision a user from a verified SSO assertion.
// ---------------------------------------------------------------------------
export const ssoAssertionSchema = z.object({
  providerId: z.string(),
  email: z.string().email(),
  firstName: z.string().trim().optional().nullable(),
  lastName: z.string().trim().optional().nullable(),
});

export async function findOrProvisionUser(args: { providerId: string; email: string; firstName?: string; lastName?: string; ip?: string; userAgent?: string }) {
  const provider = await prisma.ssoProvider.findUnique({ where: { id: args.providerId } });
  if (!provider) {
    await recordAttempt({ providerId: args.providerId, status: "ERROR", failureReason: "unknown provider", email: args.email, ip: args.ip, userAgent: args.userAgent });
    throw new ConflictError("Unknown SSO provider");
  }
  if (provider.status !== "ACTIVE") {
    await recordAttempt({ providerId: provider.id, clubId: provider.clubId, status: "DENIED", failureReason: `provider ${provider.status}`, email: args.email, ip: args.ip, userAgent: args.userAgent });
    throw new ConflictError(`SSO provider is ${provider.status}`);
  }
  const email = args.email.toLowerCase().trim();
  if (provider.emailDomain) {
    const domain = email.split("@")[1] ?? "";
    if (domain.toLowerCase() !== provider.emailDomain.toLowerCase()) {
      await recordAttempt({ providerId: provider.id, clubId: provider.clubId, status: "DENIED", failureReason: "email domain not allowed", email, ip: args.ip, userAgent: args.userAgent });
      throw new ConflictError("Email domain not permitted by SSO provider");
    }
  }
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Just-in-time provisioning.
    const passwordHash = await hashPassword(randomBytes(16).toString("hex"));
    user = await prisma.user.create({
      data: {
        email,
        name: [args.firstName, args.lastName].filter(Boolean).join(" ") || email,
        role: provider.defaultRoleKey,
        passwordHash,
        clubId: provider.clubId,
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.userClubRole.create({
      data: { userId: user.id, clubId: provider.clubId, roleKey: provider.defaultRoleKey as RoleKey },
    });
  }
  await recordAttempt({ providerId: provider.id, clubId: provider.clubId, status: "SUCCESS", email, ip: args.ip, userAgent: args.userAgent });
  return user;
}

async function recordAttempt(args: { providerId?: string; clubId?: string; email?: string; ip?: string; userAgent?: string; status: "SUCCESS" | "DENIED" | "ERROR"; failureReason?: string }) {
  if (!args.clubId) return; // can't write without a clubId; ignore unknown-provider attempts
  await prisma.ssoLoginAttempt.create({
    data: {
      clubId: args.clubId, providerId: args.providerId ?? null,
      email: args.email ?? null, ip: args.ip ?? null, userAgent: args.userAgent ?? null,
      status: args.status, failureReason: args.failureReason ?? null,
    },
  });
}

export async function listLoginAttempts(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "settings:read");
  return prisma.ssoLoginAttempt.findMany({ where: { clubId }, orderBy: { occurredAt: "desc" }, take: 100 });
}
