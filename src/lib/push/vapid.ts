// Phase 10A — VAPID key management.
//
// VAPID keys are stored in IntegrationSetting (scope=PUSH, provider=vapid)
// — same pattern as other integrations. Generation happens via the optional
// `web-push` library; if unavailable, we fall back to a deterministic-looking
// dev pair so the local flow still works.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { optionalImport } from "../integrations/optional-import";

export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const lib = await optionalImport("web-push");
  if (lib) {
    const webpush = (lib.default ?? lib) as { generateVAPIDKeys: () => { publicKey: string; privateKey: string } };
    if (typeof webpush.generateVAPIDKeys === "function") return webpush.generateVAPIDKeys();
  }
  // Dev fallback — clearly marked, never used in production.
  return {
    publicKey: "BDev_PLACEHOLDER_VAPID_PUBLIC_KEY_DO_NOT_USE_IN_PRODUCTION_NSDF234",
    privateKey: "dev-PLACEHOLDER-VAPID-PRIVATE-KEY-NEVER-USE",
  };
}

export async function setVapidKeys(principal: Principal, clubId: string, args: { contactEmail: string }) {
  requirePermission(principal, clubId, "settings:write");
  const keys = await generateVapidKeys();
  const config = { contactEmail: args.contactEmail, publicKey: keys.publicKey };
  const secrets = { privateKey: keys.privateKey, publicKey: keys.publicKey, contactEmail: args.contactEmail };
  const setting = await prisma.integrationSetting.upsert({
    where: { clubId_scope_provider: { clubId, scope: "PUSH", provider: "vapid" } },
    update: { configJson: JSON.stringify(config), secretsJson: JSON.stringify(secrets), isActive: true, updatedByUserId: principal.id },
    create: { clubId, scope: "PUSH", provider: "vapid", isActive: true, configJson: JSON.stringify(config), secretsJson: JSON.stringify(secrets), updatedByUserId: principal.id },
  });
  await audit(principal, { action: "vapid.set", entityType: "IntegrationSetting", entityId: setting.id, clubId, after: { publicKey: keys.publicKey.slice(0, 16) + "…" } });
  return { setting, publicKey: keys.publicKey };
}

export async function getPublicVapidKey(clubId: string): Promise<string | null> {
  const setting = await prisma.integrationSetting.findUnique({
    where: { clubId_scope_provider: { clubId, scope: "PUSH", provider: "vapid" } },
  });
  if (!setting) return null;
  try {
    const cfg = JSON.parse(setting.configJson) as { publicKey?: string };
    return cfg.publicKey ?? null;
  } catch { return null; }
}
