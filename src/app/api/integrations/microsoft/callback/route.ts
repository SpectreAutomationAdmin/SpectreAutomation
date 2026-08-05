// Sprint 2 B2 (2026-07-19) — GET /api/integrations/microsoft/callback
//
// Microsoft OAuth redirect target. Consumes the OAuth transaction,
// exchanges the authorization code, validates identity, persists
// the mailbox. Behind MAILBOX_INTEGRATION_ENABLED per §5 of the B2
// directive; when the flag is false the route returns 404.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { env, isMailboxIntegrationEnabled } from "@/lib/env";
import { finaliseConnection } from "@/lib/mailbox/connect";
import { MailboxFlowError, MAILBOX_ERROR_CODE } from "@/lib/mailbox/errors";
import { prisma } from "@/lib/prisma";
import { assertReturnPathSafe } from "@/lib/mailbox/connect";

// Sprint 2 Checkpoint 12C (2026-07-21) — every browser-facing redirect
// out of this callback MUST use env.APP_URL as its origin, NEVER the
// request URL's origin. On Fly, `req.url` presents as the container's
// internal listen origin (http://localhost:3000/...); using it would
// send the browser to localhost, which is unreachable from the user's
// machine. env.APP_URL is Zod-validated at boot and is not
// request-controlled, so it cannot be poisoned by a spoofed
// x-forwarded-host header (the classic host-header injection open-
// redirect attack).
//
// returnPath is already allowlisted at startConnect() time via
// assertReturnPathSafe (see src/lib/mailbox/connect.ts:93), so it is
// safe to concatenate against env.APP_URL. safeErrorReturn() returns
// a hardcoded internal path. There is no request-controlled string in
// any redirect origin OR path constructed below.
function canonicalRedirect(pathAndQuery: string): URL {
  return new URL(pathAndQuery, env.APP_URL);
}

// Sprint 2 Step 11 / Checkpoint 11 (2026-07-20) — the guard below
// returns before touching any dynamic API, which Next.js 14's App
// Router took as license to statically prerender the handler at
// build time. That baked the build-time env's flag-off 404 into the
// image and made the runtime flag flip inert. Force dynamic so the
// handler executes on every request.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isMailboxIntegrationEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.UNAUTHENTICATED }, { status: 401 });
  }
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });

  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? undefined;
  const microsoftError = url.searchParams.get("error") ?? undefined;
  const microsoftErrorDescription = url.searchParams.get("error_description") ?? undefined;
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
  const userAgent = req.headers.get("user-agent") ?? undefined;

  try {
    const result = await finaliseConnection({
      state,
      code,
      microsoftError,
      microsoftErrorDescription,
      callerUserId: principal.id,
      callerClubId: clubId,
      ip,
      userAgent,
    });
    const redirectUrl = canonicalRedirect(result.returnPath);
    // Sprint 3 · Checkpoint 16H remediation (2026-08-05) — surface
    // "connected" vs "permissions updated" so Connected Accounts can
    // render an accurate success banner.
    redirectUrl.searchParams.set("mailbox", result.isReconnect ? "updated" : "connected");
    redirectUrl.searchParams.set("cx", result.mailboxConnectionId);
    return NextResponse.redirect(redirectUrl, 302);
  } catch (err) {
    if (err instanceof MailboxFlowError) {
      // Sprint 3 · Checkpoint 16H remediation — restore the user's
      // original returnPath (e.g. /app/user/settings/connected-accounts)
      // by loading the transaction from state. Fallback to the
      // Connected Accounts page itself when state is missing / unknown /
      // returnPath fails the allowlist. NEVER redirects to
      // /app/user/settings (a 404).
      const returnPath = await safeErrorReturn(state);
      const redirectUrl = canonicalRedirect(returnPath);
      redirectUrl.searchParams.set("mailbox", "error");
      redirectUrl.searchParams.set("error", err.code);
      return NextResponse.redirect(redirectUrl, 302);
    }
    const returnPath = await safeErrorReturn(state);
    const redirectUrl = canonicalRedirect(returnPath);
    redirectUrl.searchParams.set("mailbox", "error");
    redirectUrl.searchParams.set("error", MAILBOX_ERROR_CODE.INTERNAL_ERROR);
    return NextResponse.redirect(redirectUrl, 302);
  }
}

// Sprint 3 · Checkpoint 16H remediation (2026-08-05) — recover the
// user's stored returnPath from the transaction so an error lands on
// the same page the user started from. Fallback is the real Connected
// Accounts page (never the parent /app/user/settings, which is 404).
const CONNECTED_ACCOUNTS_FALLBACK = "/app/user/settings/connected-accounts";
async function safeErrorReturn(state: string): Promise<string> {
  if (!state) return CONNECTED_ACCOUNTS_FALLBACK;
  try {
    const txn = await prisma.mailboxOAuthTransaction.findUnique({
      where: { state },
      select: { returnPath: true },
    });
    if (!txn?.returnPath) return CONNECTED_ACCOUNTS_FALLBACK;
    // Belt-and-suspenders: re-check the allowlist. If it passes,
    // we honour the stored path. If not, fall back to Connected
    // Accounts. Never trust a stored value blindly.
    try {
      assertReturnPathSafe(txn.returnPath);
      return txn.returnPath;
    } catch {
      return CONNECTED_ACCOUNTS_FALLBACK;
    }
  } catch {
    return CONNECTED_ACCOUNTS_FALLBACK;
  }
}
