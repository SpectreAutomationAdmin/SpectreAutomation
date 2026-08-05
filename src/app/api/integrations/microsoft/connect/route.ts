// Sprint 2 B2 (2026-07-19) — POST /api/integrations/microsoft/connect
//
// Authenticated Spectre user → generates a durable OAuth transaction
// row and redirects (via 302) or returns (via 200 JSON) the Microsoft
// authorization URL. Behind MAILBOX_INTEGRATION_ENABLED per §4 of
// the B2 directive; when the flag is false the route returns 404 so
// the feature is invisible.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { startConnect } from "@/lib/mailbox/connect";
import { MailboxFlowError, MAILBOX_ERROR_CODE } from "@/lib/mailbox/errors";

// The connect permission piggy-backs on `settings:write` for Phase B
// so a Club Admin can wire their own mailbox without an RBAC-schema
// change. Phase B directive §4 says: "Reuse an existing suitable
// integration-management permission where available." B4/C1 may
// tighten this to a `mailbox:connect` key if the founder decides
// mailbox connection deserves finer control than settings edits.
const CONNECT_PERMISSION = "settings:write" as const;

export async function POST(req: NextRequest) {
  if (!isMailboxIntegrationEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.UNAUTHENTICATED }, { status: 401 });
  }
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, CONNECT_PERMISSION)) {
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.PERMISSION_DENIED }, { status: 403 });
  }

  const body = await safeParseJson(req);
  // Sprint 3 · Checkpoint 16H remediation (2026-08-05) — default
  // returnPath is now the real Connected Accounts page (the prior
  // "/app/user/settings" is a 404). Also accept
  // expectedMailboxConnectionId for permission-update reconnects.
  const returnPath = typeof body?.returnPath === "string" ? body.returnPath : "/app/user/settings/connected-accounts";
  const loginHint = typeof body?.loginHint === "string" ? body.loginHint : undefined;
  const expectedMailboxConnectionId = typeof body?.expectedMailboxConnectionId === "string"
    ? body.expectedMailboxConnectionId
    : undefined;

  try {
    const { authorizationUrl, transactionId } = await startConnect({
      userId: principal.id,
      clubId,
      returnPath,
      loginHint,
      expectedMailboxConnectionId,
    });
    return NextResponse.json({ authorizationUrl, transactionId }, { status: 200 });
  } catch (err) {
    if (err instanceof MailboxFlowError) {
      const status = err.code === MAILBOX_ERROR_CODE.FEATURE_DISABLED ? 404 : 400;
      return NextResponse.json({ error: err.code }, { status });
    }
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.INTERNAL_ERROR }, { status: 500 });
  }
}

async function safeParseJson(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const raw = await req.text();
    if (!raw) return null;
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
