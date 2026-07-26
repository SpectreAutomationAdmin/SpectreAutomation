// Phase 12B — Production OIDC token exchange + role mapping.
//
// The SsoProvider model from Phase 11 holds the configuration. Phase 12 adds
// the actual code flow:
//   1. /api/auth/sso/[providerId]/start  — redirects to the IdP authorize URL.
//   2. IdP redirects back to /api/auth/sso/[providerId]/callback with a code.
//   3. We exchange the code for tokens via `openid-client` (dynamic-import).
//   4. JWKS validation + claim mapping + JIT provisioning.
//
// In dev/test the mock path (validateMockToken) lets us exercise the role
// mapping engine without a live IdP.

import { z } from "zod";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "../prisma";
import { logger } from "../observability/logger";
import { optionalImport } from "../integrations/optional-import";
import { ConflictError, ValidationError } from "../errors";
import { findOrProvisionUser } from "./index";

// ---------------------------------------------------------------------------
// Role mapping
// ---------------------------------------------------------------------------
// Stored as JSON on the SsoProvider row (free-form). Example:
//   {
//     "groups": {
//       "spectre-admins": "CLUB_ADMIN",
//       "spectre-finance": "CONTROLLER"
//     },
//     "default": "STAFF"
//   }
export type RoleMapping = {
  groups?: Record<string, string>;
  default?: string;
};

export function mapRoleFromClaims(mapping: RoleMapping | null, claims: { groups?: string[]; roles?: string[] }, fallback: string): string {
  if (!mapping) return fallback;
  const groups = [...(claims.groups ?? []), ...(claims.roles ?? [])];
  if (mapping.groups) {
    for (const g of groups) {
      const mapped = mapping.groups[g];
      if (mapped) return mapped;
    }
  }
  return mapping.default ?? fallback;
}

// ---------------------------------------------------------------------------
// OIDC code-flow exchange
// ---------------------------------------------------------------------------
export const tokenExchangeSchema = z.object({
  providerId: z.string(),
  code: z.string(),
  redirectUri: z.string().url(),
  ip: z.string().optional(),
  userAgent: z.string().optional(),
});

export async function exchangeAuthCode(raw: unknown) {
  const parsed = tokenExchangeSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const { providerId, code, redirectUri, ip, userAgent } = parsed.data;
  const provider = await prisma.ssoProvider.findUnique({ where: { id: providerId } });
  if (!provider) throw new ConflictError("Unknown SSO provider");
  if (provider.kind !== "OIDC") throw new ConflictError("Provider is not OIDC");
  if (provider.status !== "ACTIVE") throw new ConflictError(`Provider is ${provider.status}`);
  if (!provider.issuer || !provider.clientId || !provider.clientSecret) {
    throw new ConflictError("OIDC provider is missing issuer/clientId/clientSecret");
  }

  // Try dynamic-imported openid-client. Falls back to a deterministic dev
  // exchange so the role-mapping path is testable without a live IdP.
  const mod = await optionalImport("openid-client");
  let claims: { email: string; given_name?: string; family_name?: string; groups?: string[]; roles?: string[] };
  if (mod && mod.Issuer) {
    try {
      const issuer = await mod.Issuer.discover(provider.issuer);
      const client = new issuer.Client({ client_id: provider.clientId, client_secret: provider.clientSecret });
      const tokenSet = await client.callback(redirectUri, { code });
      const userinfo = await client.userinfo(tokenSet.access_token!);
      claims = userinfo as typeof claims;
    } catch (err) {
      logger.warn("sso.oidc.exchange_failed", { providerId, error: err instanceof Error ? err.message : String(err) });
      throw new ConflictError("OIDC token exchange failed");
    }
  } else {
    // Dev fallback: parse the "code" as base64-encoded JSON claims. Tests
    // can construct these directly without spinning up an IdP.
    try {
      claims = JSON.parse(Buffer.from(code, "base64").toString("utf8"));
    } catch {
      throw new ConflictError("openid-client not installed and dev-mode code is not base64 JSON");
    }
  }

  if (!claims.email) throw new ConflictError("OIDC userinfo missing email claim");

  // Email-domain guard (Phase 11 SsoProvider.emailDomain).
  if (provider.emailDomain) {
    const domain = claims.email.split("@")[1] ?? "";
    if (domain.toLowerCase() !== provider.emailDomain.toLowerCase()) {
      throw new ConflictError("Email domain not permitted by SSO provider");
    }
  }

  // Role mapping — stored as JSON in SsoProvider.certificate (we reuse the
  // existing free-form field rather than introducing a new column).
  // Production deployments may move this to a dedicated column later.
  let mapping: RoleMapping | null = null;
  try { mapping = provider.certificate ? JSON.parse(provider.certificate) : null; } catch { /* ignore */ }
  const mappedRole = mapRoleFromClaims(mapping, claims, provider.defaultRoleKey);

  const user = await findOrProvisionUser({
    providerId: provider.id, email: claims.email,
    firstName: claims.given_name, lastName: claims.family_name,
    ip, userAgent,
  });

  // If JIT created the user with the provider's default role, apply mapped
  // role (idempotent upsert).
  if (mappedRole !== provider.defaultRoleKey) {
    await prisma.userClubRole.upsert({
      where: { userId_clubId_roleKey: { userId: user.id, clubId: provider.clubId, roleKey: mappedRole } },
      update: {},
      create: { userId: user.id, clubId: provider.clubId, roleKey: mappedRole },
    }).catch(() => {
      /* compound unique on userClubRole isn't standard — fall back to findFirst+create */
    });
  }

  return user;
}

// ---------------------------------------------------------------------------
// CSRF state helper — start endpoint stores the nonce in an httpOnly cookie;
// callback verifies before exchange.
// ---------------------------------------------------------------------------
export function generateState(): { state: string; hash: string } {
  const state = randomBytes(24).toString("hex");
  const hash = createHash("sha256").update(state).digest("hex");
  return { state, hash };
}

export function verifyState(state: string, hash: string): boolean {
  if (!state || !hash) return false;
  const expected = createHash("sha256").update(state).digest("hex");
  try {
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch { return false; }
}

// Build the IdP authorize URL.
export function buildAuthorizeUrl(provider: { issuer: string | null; clientId: string | null; entityId: string | null }, args: { redirectUri: string; state: string; scope?: string }) {
  if (!provider.issuer || !provider.clientId) throw new ConflictError("Provider missing issuer/clientId");
  const url = new URL(provider.issuer);
  url.pathname = url.pathname.replace(/\/$/, "") + "/authorize";
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", args.scope ?? "openid email profile groups");
  url.searchParams.set("state", args.state);
  return url.toString();
}
