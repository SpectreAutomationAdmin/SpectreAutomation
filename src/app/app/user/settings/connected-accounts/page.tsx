// Sprint 2 B3 (2026-07-19) — Connected Accounts settings page.
//
// Route: /app/user/settings/connected-accounts
//
// Per §3 of the B3 directive: authenticated Spectre user, active club,
// feature flag enabled. Renders ONLY the current user's own personal
// Microsoft mailbox connection — Club Admin and Super Admin do not
// see anyone else's mailbox here.
//
// The `notFound()` when the feature flag is off is deliberate: it
// makes the surface invisible in production while the flag is off,
// matching every /api/integrations/microsoft/* route which also
// returns 404 under the flag.

import { redirect, notFound } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { hasPermission } from "@/lib/rbac";
import { loadUserMailboxSnapshot } from "@/lib/mailbox/reader";
import ConnectedAccountsClient from "@/components/mailbox/ConnectedAccountsClient";

interface SearchParams {
  mailbox?: string;
  error?: string;
  // The callback appends the connection id under `cx` — surfaced in
  // the UI ONLY to disambiguate the "which connection just returned?"
  // case. Never sent back to the browser as an authoritative id.
  cx?: string;
}

// Small server-side permission label the client component uses to
// decide whether to render Connect (the founder-approved rule is:
// only users with `settings:write` can initiate a mailbox connect).
const CONNECT_PERMISSION = "settings:write" as const;

export default async function ConnectedAccountsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!isMailboxIntegrationEnabled()) notFound();
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  const canConnect = hasPermission(principal, clubId, CONNECT_PERMISSION);

  const snapshot = await loadUserMailboxSnapshot({ userId: principal.id, clubId });

  return (
    <ConnectedAccountsClient
      snapshot={{
        connection: snapshot.connection && {
          ...snapshot.connection,
          createdAt: snapshot.connection.createdAt.toISOString(),
          disconnectedAt: snapshot.connection.disconnectedAt?.toISOString() ?? null,
          lastSuccessfulSyncAt: snapshot.connection.lastSuccessfulSyncAt?.toISOString() ?? null,
          lastAttemptedSyncAt: snapshot.connection.lastAttemptedSyncAt?.toISOString() ?? null,
        },
        recentActivity: snapshot.recentActivity.map((a) => ({
          action: a.action,
          createdAt: a.createdAt.toISOString(),
        })),
      }}
      canConnect={canConnect}
      callbackResult={{
        mailbox: searchParams.mailbox ?? null,
        error: searchParams.error ?? null,
      }}
    />
  );
}
