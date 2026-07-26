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
import { MailboxFlowError, MAILBOX_ERROR_CODE, type MailboxErrorCode } from "@/lib/mailbox/errors";

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
    redirectUrl.searchParams.set("mailbox", "connected");
    redirectUrl.searchParams.set("cx", result.mailboxConnectionId);
    return NextResponse.redirect(redirectUrl, 302);
  } catch (err) {
    if (err instanceof MailboxFlowError) {
      const returnPath = safeErrorReturn(err.code);
      const redirectUrl = canonicalRedirect(returnPath);
      redirectUrl.searchParams.set("mailbox", "error");
      redirectUrl.searchParams.set("error", err.code);
      return NextResponse.redirect(redirectUrl, 302);
    }
    const redirectUrl = canonicalRedirect("/app/user/settings");
    redirectUrl.searchParams.set("mailbox", "error");
    redirectUrl.searchParams.set("error", MAILBOX_ERROR_CODE.INTERNAL_ERROR);
    return NextResponse.redirect(redirectUrl, 302);
  }
}

// Every error redirect lands on an internal, allowlisted path. Never
// echo the OAuth `state` or Microsoft's `error_description` back to
// the browser as a query parameter — they can contain user email
// addresses or tenant identifiers the user may not want URL-visible.
function safeErrorReturn(code: MailboxErrorCode): string {
  void code;
  return "/app/user/settings";
}
