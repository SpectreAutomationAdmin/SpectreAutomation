// Phase 12F — Marketplace foundations.
//
// Provides the building blocks for third-party app integrations:
//   - App registration (public clientId + once-shown clientSecret)
//   - Tenant-scoped install / uninstall
//   - Scoped permission grants per install
//   - OAuth-style authorization-code → access-token exchange (in-process for
//     now; the access/refresh tokens are stored as sha256 hashes only)
//   - Webhook subscriptions per install
//
// NOTE on scope: this is foundations only — no public listing/marketplace UI,
// no payment routing, no app review queue. Phase 13+ owns those.

import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, isSuperAdmin, type Principal } from "../rbac";
import { ConflictError, NotFoundError, ValidationError } from "../errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function parseScopes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((s) => String(s)) : [];
  } catch {
    return [];
  }
}

function csv(arr: string[]): string {
  return arr.map((s) => s.trim()).filter(Boolean).join(",");
}

// ---------------------------------------------------------------------------
// App registration (publisher action). Returns the clientSecret ONCE.
// ---------------------------------------------------------------------------
export const registerAppSchema = z.object({
  key: z.string().min(3).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/, "key must be lowercase slug"),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  homepageUrl: z.string().url().optional(),
  iconUrl: z.string().url().optional(),
  kind: z.enum(["FIRST_PARTY", "THIRD_PARTY"]).default("THIRD_PARTY"),
  redirectUris: z.array(z.string().url()).min(1).max(10),
  defaultScopes: z.array(z.string().min(1).max(64)).default([]),
  webhookUrl: z.string().url().optional(),
});

export async function registerApp(principal: Principal, raw: unknown) {
  // Publishing apps is a platform-wide action — gate on super-admin only.
  if (!isSuperAdmin(principal)) throw new NotFoundError("MarketplaceApp", "register");
  const parsed = registerAppSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const existing = await prisma.marketplaceApp.findUnique({ where: { key: parsed.data.key } });
  if (existing) throw new ConflictError(`MarketplaceApp with key ${parsed.data.key} already exists`);
  const clientId = `app_${randomToken(16)}`;
  const clientSecret = randomToken(48);
  const app = await prisma.marketplaceApp.create({
    data: {
      key: parsed.data.key,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      iconUrl: parsed.data.iconUrl ?? null,
      homepageUrl: parsed.data.homepageUrl ?? null,
      kind: parsed.data.kind,
      status: "PUBLISHED",
      defaultScopesJson: JSON.stringify(parsed.data.defaultScopes),
      clientId,
      clientSecretHash: sha256(clientSecret),
      redirectUris: csv(parsed.data.redirectUris),
      webhookUrl: parsed.data.webhookUrl ?? null,
      publisherUserId: principal.id,
    },
  });
  await audit(principal, { action: "marketplace.app.register", entityType: "MarketplaceApp", entityId: app.id, clubId: null, after: { key: app.key, name: app.name, clientId } });
  return { app: { ...app, clientSecretHash: undefined }, clientId, clientSecret };
}

export async function listApps() {
  const apps = await prisma.marketplaceApp.findMany({
    where: { status: "PUBLISHED" },
    orderBy: { name: "asc" },
  });
  return apps.map((a) => ({
    id: a.id, key: a.key, name: a.name, description: a.description,
    iconUrl: a.iconUrl, homepageUrl: a.homepageUrl, kind: a.kind,
    defaultScopes: parseScopes(a.defaultScopesJson),
    clientId: a.clientId,
  }));
}

// ---------------------------------------------------------------------------
// Install / uninstall for a specific tenant.
// ---------------------------------------------------------------------------
export const installAppSchema = z.object({
  appId: z.string(),
  clubId: z.string(),
  scopes: z.array(z.string().min(1).max(64)).optional(),
  notes: z.string().max(1000).optional(),
});

export async function installApp(principal: Principal, raw: unknown) {
  const parsed = installAppSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  requirePermission(principal, parsed.data.clubId, "settings:write");
  const app = await prisma.marketplaceApp.findUnique({ where: { id: parsed.data.appId } });
  if (!app) throw new NotFoundError("MarketplaceApp", parsed.data.appId);
  if (app.status !== "PUBLISHED") throw new ConflictError("App is not in a published state");
  const existing = await prisma.installedApp.findUnique({ where: { clubId_appId: { clubId: parsed.data.clubId, appId: parsed.data.appId } } });
  if (existing && existing.status === "ACTIVE") {
    throw new ConflictError(`App ${app.key} is already installed at this club`);
  }
  const scopes = parsed.data.scopes ?? parseScopes(app.defaultScopesJson);
  // Validate scopes against the app's default scope set so a tenant can't
  // self-grant beyond what the publisher declared.
  const defaultSet = new Set(parseScopes(app.defaultScopesJson));
  const invalid = scopes.filter((s) => defaultSet.size > 0 && !defaultSet.has(s));
  if (invalid.length > 0) {
    throw new ValidationError([{ path: "scopes", message: `scopes not declared by app: ${invalid.join(",")}` }]);
  }
  const install = await prisma.$transaction(async (tx) => {
    const upserted = existing
      ? await tx.installedApp.update({
          where: { id: existing.id },
          data: {
            status: "ACTIVE", scopesJson: JSON.stringify(scopes),
            installedByUserId: principal.id, installedAt: new Date(),
            notes: parsed.data.notes ?? null, revokedAt: null, revokedByUserId: null,
          },
        })
      : await tx.installedApp.create({
          data: {
            clubId: parsed.data.clubId, appId: parsed.data.appId,
            installedByUserId: principal.id,
            status: "ACTIVE", scopesJson: JSON.stringify(scopes),
            notes: parsed.data.notes ?? null,
          },
        });
    // Reset permission rows: revoke anything stale, then upsert the new set.
    await tx.appPermission.updateMany({
      where: { installedAppId: upserted.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    for (const perm of scopes) {
      await tx.appPermission.upsert({
        where: { installedAppId_permission: { installedAppId: upserted.id, permission: perm } },
        update: { revokedAt: null, grantedAt: new Date() },
        create: { clubId: parsed.data.clubId, installedAppId: upserted.id, permission: perm },
      });
    }
    return upserted;
  });
  await audit(principal, { action: "marketplace.app.install", entityType: "InstalledApp", entityId: install.id, clubId: parsed.data.clubId, after: { appId: app.id, scopes } });
  return install;
}

export async function uninstallApp(principal: Principal, installId: string, reason?: string) {
  const install = await prisma.installedApp.findUnique({ where: { id: installId } });
  if (!install) throw new NotFoundError("InstalledApp", installId);
  requirePermission(principal, install.clubId, "settings:write");
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.installedApp.update({
      where: { id: install.id },
      data: { status: "REVOKED", revokedAt: new Date(), revokedByUserId: principal.id },
    });
    // Revoke permissions and any outstanding tokens.
    await tx.appPermission.updateMany({
      where: { installedAppId: install.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.oAuthGrant.updateMany({
      where: { installedAppId: install.id, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    await tx.appWebhookSubscription.updateMany({
      where: { installedAppId: install.id, status: "ACTIVE" },
      data: { status: "REVOKED" },
    });
    return u;
  });
  await audit(principal, { action: "marketplace.app.uninstall", entityType: "InstalledApp", entityId: install.id, clubId: install.clubId, after: { reason } });
  return updated;
}

export async function listInstalls(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "settings:read");
  const installs = await prisma.installedApp.findMany({
    where: { clubId },
    include: { app: true, permissions: true },
    orderBy: { installedAt: "desc" },
  });
  return installs.map((i) => ({
    id: i.id, status: i.status, installedAt: i.installedAt,
    appKey: i.app.key, appName: i.app.name, appIconUrl: i.app.iconUrl,
    scopes: parseScopes(i.scopesJson),
    permissions: i.permissions.filter((p) => !p.revokedAt).map((p) => p.permission),
  }));
}

// ---------------------------------------------------------------------------
// OAuth-style token flow.
//
// Step 1: an in-process authorization code is created by `authorize()` after
//         the install is confirmed by a club admin. The raw code is returned
//         ONCE and embeds the install id; only its sha256 is stored.
// Step 2: `exchangeCode()` verifies the clientId / clientSecret and the code,
//         then issues an access token (sha256-hashed at rest).
//
// This is intentionally simple: a single-host, in-process flow. A real public
// IdP would replace `authorize()` with a redirect handshake.
// ---------------------------------------------------------------------------
const AUTH_CODE_TTL_MS = 5 * 60_000;
const ACCESS_TOKEN_TTL_MS = 60 * 60_000;

type PendingCode = { code: string; installId: string; clubId: string; appId: string; scopes: string[]; expiresAt: number };
const pendingCodes = new Map<string, PendingCode>();

function gcCodes() {
  const now = Date.now();
  for (const [k, v] of pendingCodes) if (v.expiresAt < now) pendingCodes.delete(k);
}

export async function authorize(principal: Principal, args: { installId: string }) {
  const install = await prisma.installedApp.findUnique({ where: { id: args.installId } });
  if (!install) throw new NotFoundError("InstalledApp", args.installId);
  requirePermission(principal, install.clubId, "settings:write");
  if (install.status !== "ACTIVE") throw new ConflictError("Install is not ACTIVE");
  gcCodes();
  const code = randomToken(24);
  pendingCodes.set(sha256(code), {
    code, installId: install.id, clubId: install.clubId, appId: install.appId,
    scopes: parseScopes(install.scopesJson),
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });
  await audit(principal, { action: "marketplace.oauth.authorize", entityType: "InstalledApp", entityId: install.id, clubId: install.clubId });
  return { code, expiresInSeconds: AUTH_CODE_TTL_MS / 1000 };
}

export const exchangeSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  code: z.string(),
});

export async function exchangeCode(raw: unknown) {
  const parsed = exchangeSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const app = await prisma.marketplaceApp.findUnique({ where: { clientId: parsed.data.clientId } });
  if (!app) throw new NotFoundError("MarketplaceApp", parsed.data.clientId);
  if (app.clientSecretHash !== sha256(parsed.data.clientSecret)) {
    throw new ValidationError([{ path: "clientSecret", message: "invalid client credentials" }]);
  }
  gcCodes();
  const pending = pendingCodes.get(sha256(parsed.data.code));
  if (!pending) throw new ValidationError([{ path: "code", message: "invalid or expired code" }]);
  pendingCodes.delete(sha256(parsed.data.code));
  if (pending.appId !== app.id) throw new ValidationError([{ path: "code", message: "code does not belong to this app" }]);
  const accessToken = `spk_${randomToken(32)}`;
  const refreshToken = `spr_${randomToken(32)}`;
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
  const grant = await prisma.oAuthGrant.create({
    data: {
      clubId: pending.clubId, appId: app.id, installedAppId: pending.installId,
      accessTokenHash: sha256(accessToken), refreshTokenHash: sha256(refreshToken),
      scopesJson: JSON.stringify(pending.scopes),
      expiresAt, status: "ACTIVE",
    },
  });
  return {
    accessToken, refreshToken,
    tokenType: "Bearer", expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scopes: pending.scopes,
    grantId: grant.id,
  };
}

export async function resolveAccessToken(rawAccessToken: string): Promise<{
  clubId: string; appId: string; installId: string | null; scopes: string[];
} | null> {
  const grant = await prisma.oAuthGrant.findUnique({
    where: { accessTokenHash: sha256(rawAccessToken) },
  });
  if (!grant) return null;
  if (grant.status !== "ACTIVE") return null;
  if (grant.expiresAt.getTime() < Date.now()) return null;
  return {
    clubId: grant.clubId, appId: grant.appId, installId: grant.installedAppId,
    scopes: parseScopes(grant.scopesJson),
  };
}

export async function revokeGrant(principal: Principal, grantId: string) {
  const grant = await prisma.oAuthGrant.findUnique({ where: { id: grantId } });
  if (!grant) throw new NotFoundError("OAuthGrant", grantId);
  requirePermission(principal, grant.clubId, "settings:write");
  const revoked = await prisma.oAuthGrant.update({
    where: { id: grantId },
    data: { status: "REVOKED", revokedAt: new Date() },
  });
  await audit(principal, { action: "marketplace.oauth.revoke", entityType: "OAuthGrant", entityId: grant.id, clubId: grant.clubId });
  return revoked;
}

// ---------------------------------------------------------------------------
// Webhook subscriptions per install — apps can subscribe to event topics.
// ---------------------------------------------------------------------------
export const subscribeWebhookSchema = z.object({
  installedAppId: z.string(),
  events: z.array(z.string().min(1).max(64)).min(1).max(50),
  url: z.string().url(),
});

export async function subscribeAppWebhook(principal: Principal, raw: unknown) {
  const parsed = subscribeWebhookSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const install = await prisma.installedApp.findUnique({ where: { id: parsed.data.installedAppId } });
  if (!install) throw new NotFoundError("InstalledApp", parsed.data.installedAppId);
  requirePermission(principal, install.clubId, "settings:write");
  if (install.status !== "ACTIVE") throw new ConflictError("Install is not ACTIVE");
  const secret = randomToken(32);
  const sub = await prisma.appWebhookSubscription.create({
    data: {
      clubId: install.clubId, installedAppId: install.id,
      events: csv(parsed.data.events), url: parsed.data.url,
      secret: sha256(secret),
    },
  });
  await audit(principal, { action: "marketplace.webhook.subscribe", entityType: "AppWebhookSubscription", entityId: sub.id, clubId: install.clubId, after: { events: parsed.data.events } });
  // Raw secret shown once; receivers verify HMAC against it.
  return { subscription: { ...sub, secret: "(stored hashed)" }, signingSecret: secret };
}
