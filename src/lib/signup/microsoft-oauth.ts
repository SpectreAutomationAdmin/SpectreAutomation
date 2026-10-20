// SIGNUP-1 (2026-10-19) — Microsoft identity-only OAuth for the
// pre-authentication signup flow.
//
// Scope policy (hard invariant):
//   openid + profile + email + offline_access  ONLY.
//
// Spectre's existing mailbox-connect flow (src/lib/mailbox/connect.ts)
// uses the full APPROVED_DELEGATED_SCOPES set including Mail.Read /
// Mail.ReadWrite / Mail.Send / Calendars.Read — those are mailbox-
// integration scopes that are REQUESTED SEPARATELY by the club
// administrator during implementation (SIGNUP-3 or later).  Requesting
// them at signup time would (a) surface a confusing consent screen,
// (b) grant Spectre mailbox access before the club has provisioned a
// tenant, and (c) violate the founder's §5 directive.
//
// Personal-account rejection:
//   `authority` = login.microsoftonline.com/organizations rejects
//   personal Microsoft accounts at the identity-platform layer.
//   `idTokenClaims.idp === "MSA"` is ALSO rejected server-side
//   (defence in depth), so even a user who somehow lands with a
//   personal account token cannot complete signup.
//
// Replay / tamper protection:
//   - `state` is cryptographically random, single-use
//     (`consumedAt` set on first use).
//   - `nonce` is in both the auth URL and the id_token; mismatch →
//     reject.
//   - PKCE S256 — the authorization code is useless without the
//     verifier stored server-side in SignupOAuthTransaction.
//
// NEVER STORES the access token or refresh token.  SIGNUP-1 only
// needs the identity claims; the tokens are discarded immediately
// after the id_token claim validation.

import { env, signupRedirectUri } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import {
  pkceVerifier,
  pkceChallenge,
  oauthState,
  oauthNonce,
} from "@/lib/auth/pkce";

const IDENTITY_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

// 10-minute transaction TTL — enough for a user to complete the
// Microsoft consent screen; short enough to limit replay windows.
const SIGNUP_OAUTH_TTL_MS = Number(
  process.env.SIGNUP_OAUTH_TTL_MS ?? String(10 * 60 * 1000),
);

type MsalConfidentialClient = import("@azure/msal-node").ConfidentialClientApplication;
let SIGNUP_CLIENT: MsalConfidentialClient | null = null;

async function lazyClient(): Promise<MsalConfidentialClient> {
  if (SIGNUP_CLIENT) return SIGNUP_CLIENT;
  const clientId = env.MICROSOFT_GRAPH_DELEGATED_CLIENT_ID;
  const clientSecret = env.MICROSOFT_GRAPH_DELEGATED_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new AppError(
      "SIGNUP_MISCONFIGURED",
      "Microsoft identity is not configured. Set MICROSOFT_GRAPH_DELEGATED_CLIENT_ID and MICROSOFT_GRAPH_DELEGATED_CLIENT_SECRET.",
      500,
      "Microsoft identity is temporarily unavailable. Please try again later.",
    );
  }
  const msal = await import("@azure/msal-node");
  SIGNUP_CLIENT = new msal.ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      // "organizations" audience rejects personal Microsoft accounts at
      // the identity-platform layer — see §4 of the SIGNUP-1 directive.
      authority: `${env.MICROSOFT_GRAPH_AUTHORITY_HOST}/organizations`,
    },
  });
  return SIGNUP_CLIENT;
}

function redirectUri(): string {
  // SIGNUP-1D (2026-10-20) — centralised via signupRedirectUri so
  // the readiness-check endpoint and this OAuth flow return the
  // IDENTICAL string.  AADSTS50011 ("reply URL does not match") is
  // the symptom when this string drifts from Entra's registered
  // Redirect URIs.
  return signupRedirectUri();
}

// --------------------------------------------------------------
// startMicrosoftAuth — called by POST /api/signup/microsoft/start.
// Creates a SignupOAuthTransaction + returns the Microsoft
// authorization URL.
// --------------------------------------------------------------

export async function startMicrosoftAuth(args: {
  registrationId: string;
  returnPath: string;
}): Promise<{ authorizationUrl: string; transactionId: string }> {
  if (!args.returnPath.startsWith("/signup/t/")) {
    throw new AppError(
      "SIGNUP_UNSAFE_RETURN_PATH",
      `Return path ${args.returnPath} is not under /signup/t/`,
      400,
    );
  }
  const client = await lazyClient();
  const state = oauthState();
  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);
  const nonce = oauthNonce();
  const now = new Date();
  const tx = await prisma.signupOAuthTransaction.create({
    data: {
      state,
      registrationId: args.registrationId,
      pkceVerifier: verifier,
      nonce,
      returnPath: args.returnPath,
      expiresAt: new Date(now.getTime() + SIGNUP_OAUTH_TTL_MS),
    },
    select: { id: true },
  });
  const url = await client.getAuthCodeUrl({
    scopes: [...IDENTITY_SCOPES],
    redirectUri: redirectUri(),
    state,
    nonce,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    // Prevent silent SSO — the founding admin picks the right work
    // account.
    prompt: "select_account",
  });
  logger.info("signup.oauth.started", {
    txIdTail: tx.id.slice(-6),
    registrationIdTail: args.registrationId.slice(-6),
  });
  return { authorizationUrl: url, transactionId: tx.id };
}

// --------------------------------------------------------------
// finaliseMicrosoftAuth — called by GET /api/signup/microsoft/callback.
// Validates the OAuth state, exchanges the code, extracts the id_token
// claims, rejects personal Microsoft accounts, and returns the
// verified identity.
//
// NEVER writes to User or UserClubRole.  Only writes to:
//   - SignupOAuthTransaction (consumedAt + outcome)
//   - SignupRegistration (adminEmail / adminMicrosoftOid /
//     adminMicrosoftTenantId / adminDisplayName / step)
// --------------------------------------------------------------

export type FinaliseOutcome =
  | {
      status: "SUCCESS";
      transactionId: string;
      registrationId: string;
      returnPath: string;
      identity: {
        oid: string;
        tid: string;
        email: string;
        displayName: string | null;
        givenName: string | null;
        surname: string | null;
      };
    }
  | { status: "STATE_UNKNOWN" }
  | { status: "STATE_REPLAY"; transactionId: string }
  | { status: "STATE_EXPIRED"; transactionId: string }
  | { status: "NONCE_MISMATCH"; transactionId: string }
  | { status: "PERSONAL_ACCOUNT_REJECTED"; transactionId: string }
  | { status: "DENIED"; transactionId: string | null }
  | { status: "CALLBACK_ERROR"; transactionId: string | null; detail: string };

export async function finaliseMicrosoftAuth(args: {
  state: string;
  code?: string;
  microsoftError?: string;
}): Promise<FinaliseOutcome> {
  if (!args.state) {
    return { status: "CALLBACK_ERROR", transactionId: null, detail: "missing_state" };
  }
  const tx = await prisma.signupOAuthTransaction.findUnique({
    where: { state: args.state },
  });
  if (!tx) return { status: "STATE_UNKNOWN" };
  if (tx.consumedAt) {
    logger.warn("signup.oauth.replay_attempt", { txIdTail: tx.id.slice(-6) });
    return { status: "STATE_REPLAY", transactionId: tx.id };
  }
  if (tx.expiresAt.getTime() < Date.now()) {
    await markOutcome(tx.id, "EXPIRED");
    return { status: "STATE_EXPIRED", transactionId: tx.id };
  }
  if (args.microsoftError) {
    const denied = args.microsoftError === "access_denied";
    await markOutcome(tx.id, denied ? "DENIED" : "CALLBACK_ERROR");
    return denied
      ? { status: "DENIED", transactionId: tx.id }
      : { status: "CALLBACK_ERROR", transactionId: tx.id, detail: args.microsoftError };
  }
  if (!args.code) {
    await markOutcome(tx.id, "CALLBACK_ERROR");
    return { status: "CALLBACK_ERROR", transactionId: tx.id, detail: "missing_code" };
  }
  try {
    const client = await lazyClient();
    const result = await client.acquireTokenByCode({
      scopes: [...IDENTITY_SCOPES],
      redirectUri: redirectUri(),
      code: args.code,
      codeVerifier: tx.pkceVerifier,
    });
    if (!result) {
      await markOutcome(tx.id, "CALLBACK_ERROR");
      return { status: "CALLBACK_ERROR", transactionId: tx.id, detail: "null_token_response" };
    }
    const claims =
      (result.idTokenClaims ?? {}) as {
        iss?: string;
        tid?: string;
        oid?: string;
        preferred_username?: string;
        name?: string;
        email?: string;
        nonce?: string;
        idp?: string;
        given_name?: string;
        family_name?: string;
      };
    // Nonce validation — MSAL does the id_token signature +
    // issuer validation internally, but we still MUST compare
    // nonce against what we minted.
    if (claims.nonce !== tx.nonce) {
      await markOutcome(tx.id, "NONCE_MISMATCH");
      return { status: "NONCE_MISMATCH", transactionId: tx.id };
    }
    // Reject personal Microsoft accounts.  "MSA" is Microsoft's
    // identity-provider identifier for the Live/Hotmail cloud —
    // the authority=organizations should already have blocked it,
    // but we assert server-side as defence in depth.
    if (claims.idp === "MSA") {
      await markOutcome(tx.id, "PERSONAL_ACCOUNT_REJECTED");
      return { status: "PERSONAL_ACCOUNT_REJECTED", transactionId: tx.id };
    }
    if (!claims.oid || !claims.tid) {
      await markOutcome(tx.id, "CALLBACK_ERROR");
      return { status: "CALLBACK_ERROR", transactionId: tx.id, detail: "missing_oid_or_tid" };
    }
    const email = claims.email || claims.preferred_username;
    if (!email) {
      await markOutcome(tx.id, "CALLBACK_ERROR");
      return { status: "CALLBACK_ERROR", transactionId: tx.id, detail: "missing_email" };
    }
    await markOutcome(tx.id, "SUCCESS");
    return {
      status: "SUCCESS",
      transactionId: tx.id,
      registrationId: tx.registrationId,
      returnPath: tx.returnPath,
      identity: {
        oid: claims.oid,
        tid: claims.tid,
        email,
        displayName: claims.name ?? null,
        givenName: claims.given_name ?? null,
        surname: claims.family_name ?? null,
      },
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("signup.oauth.exchange_failed", { txIdTail: tx.id.slice(-6), detail });
    await markOutcome(tx.id, "CALLBACK_ERROR");
    return { status: "CALLBACK_ERROR", transactionId: tx.id, detail };
  }
}

async function markOutcome(txId: string, outcome: string): Promise<void> {
  await prisma.signupOAuthTransaction.update({
    where: { id: txId },
    data: { consumedAt: new Date(), outcome },
  });
}
